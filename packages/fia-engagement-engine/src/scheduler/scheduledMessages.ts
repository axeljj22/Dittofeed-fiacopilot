/**
 * Scheduled message manager — loads active schedules from DB, creates node-cron jobs,
 * and executes broadcasts when they fire.
 *
 * Call initScheduledMessages() on engine startup.
 * Call reloadScheduledMessages() after any CRUD change via the API.
 */
import cron from "node-cron";
import { logger } from "../logger";
import {
  getActiveScheduledMessages,
  getUsersInSegment,
  updateScheduledMessage,
  type ScheduledMessage,
} from "../db/supabase";
import { getCachedConfig } from "../config/engineConfigCache";
import { evolutionManager } from "../senders/whatsappEvolution";

// Cron tasks keyed by scheduled_message.id — allows selective teardown
const _tasks = new Map<string, cron.ScheduledTask>();

/**
 * Load all active scheduled messages and register cron jobs for each.
 * Replaces any existing jobs for the same IDs.
 */
export async function initScheduledMessages(): Promise<void> {
  try {
    const schedules = await getActiveScheduledMessages();
    logger.info({ count: schedules.length }, "Loading scheduled messages");

    for (const schedule of schedules) {
      registerJob(schedule);
    }
  } catch (error) {
    logger.warn({ error }, "Failed to init scheduled messages — will retry on next reload");
  }
}

/**
 * Tear down all existing jobs and reload from DB.
 * Call after any POST/PUT/DELETE on /api/schedule.
 */
export async function reloadScheduledMessages(): Promise<void> {
  // Stop all existing jobs
  for (const [id, task] of _tasks) {
    task.stop();
    _tasks.delete(id);
  }
  await initScheduledMessages();
  logger.info({ count: _tasks.size }, "Scheduled messages reloaded");
}

function registerJob(schedule: ScheduledMessage): void {
  // Validate cron expression before registering
  if (!cron.validate(schedule.schedule_cron)) {
    logger.warn({ id: schedule.id, cron: schedule.schedule_cron }, "Invalid cron expression — skipping schedule");
    return;
  }

  // Stop existing job for this ID if any
  const existing = _tasks.get(schedule.id);
  if (existing) existing.stop();

  const task = cron.schedule(schedule.schedule_cron, async () => {
    logger.info({ id: schedule.id, name: schedule.name }, "Scheduled message firing");
    await runScheduledBroadcast(schedule);
  });

  _tasks.set(schedule.id, task);
  logger.debug({ id: schedule.id, name: schedule.name, cron: schedule.schedule_cron }, "Cron job registered");
}

/**
 * Execute a scheduled broadcast immediately (used by "Run now" and by cron trigger).
 * Returns the number of users the message was sent to.
 */
export async function runScheduledBroadcast(schedule: ScheduledMessage): Promise<number> {
  let sent = 0;
  try {
    // Load the message template from engine_config if message_key is provided
    let template: string | null = null;
    if (schedule.message_key) {
      template = await getCachedConfig(schedule.message_key, "");
      if (!template) {
        logger.warn({ id: schedule.id, message_key: schedule.message_key }, "No template found for message_key");
        return 0;
      }
    }

    // Get users in the target segment
    const users = await getUsersInSegment(schedule.segment);
    logger.info({ id: schedule.id, name: schedule.name, segment: schedule.segment, userCount: users.length }, "Broadcast starting");

    if (users.length === 0) {
      logger.warn({ id: schedule.id, segment: schedule.segment }, "No users in segment — broadcast skipped");
      await updateScheduledMessage(schedule.id, { last_run_at: new Date().toISOString() });
      return 0;
    }

    for (const user of users) {
      try {
        let text = template ?? `Hola ${user.name ?? "ahí"}, Sofía de FIA Copilot aquí.`;

        // Basic variable substitution
        text = text
          .replace(/\{\{nombre\}\}/g, user.name ?? "ahí")
          .replace(/\{\{empresa\}\}/g, user.company_name ?? "tu empresa");

        await evolutionManager.sendMessage(user.phone, text);
        sent++;
      } catch (err) {
        logger.warn({ err, userId: user.id }, "Failed to send scheduled message to user");
      }
    }

    // Update last_run_at
    await updateScheduledMessage(schedule.id, { last_run_at: new Date().toISOString() });
    logger.info({ id: schedule.id, name: schedule.name, sent, total: users.length }, "Broadcast complete");
  } catch (error) {
    logger.error({ error, id: schedule.id }, "Scheduled broadcast failed");
  }
  return sent;
}

/** Returns current job count (for health check / admin display) */
export function getActiveJobCount(): number {
  return _tasks.size;
}
