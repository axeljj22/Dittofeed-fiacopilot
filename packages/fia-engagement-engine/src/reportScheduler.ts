/**
 * Weekly report cron scheduler — extracted so both the entrypoint (index.ts) and the
 * admin API (server.ts) can (re)schedule it without a circular import.
 */
import cron from "node-cron";
import { config } from "./config";
import { logger } from "./logger";
import { runWeeklyReport, runInternalReport } from "./orchestrator";
import { getReportSchedule, getInternalReportSchedule } from "./config/engineConfigCache";
import { getDueReminders, setReminderStatus, getProfileWithWhatsapp } from "./db/supabase";
import { evolutionManager } from "./senders/whatsappEvolution";

let reportTask: cron.ScheduledTask | null = null;
let internalReportTask: cron.ScheduledTask | null = null;
let remindersTask: cron.ScheduledTask | null = null;

const REPORT_TZ = "America/Argentina/Buenos_Aires";

/**
 * Sends due Sofía reminders (Phase 4). Reuses the guarded outbound path: only opted-in users, and —
 * when PILOT_PHONE is set — only the pilot phone / whitelist receive messages. Everything else is
 * cancelled (not retried) to avoid surprises. No-op when there are no due reminders.
 */
async function runDueReminders(): Promise<void> {
  const due = await getDueReminders(new Date().toISOString());
  if (due.length === 0) return;
  const pilot = config.engine.pilotPhone.replace(/\D/g, "");
  for (const r of due) {
    try {
      const profile = await getProfileWithWhatsapp(r.user_id);
      const phone = (profile?.phone ?? "").replace(/\D/g, "");
      const optedIn = profile?.whatsapp_opt_in === true;
      const whitelisted = config.engine.pilotWhitelistPhones.some((p) => phone.includes(p));
      const pilotOk = !pilot || phone.includes(pilot) || whitelisted;
      if (!phone || !optedIn || !pilotOk) {
        await setReminderStatus(r.id, "cancelled");
        continue;
      }
      const res = await evolutionManager.sendMessage(phone, r.message);
      await setReminderStatus(r.id, res.success ? "sent" : "failed");
    } catch (error) {
      logger.warn({ error: (error as Error).message, reminderId: r.id }, "reminder send failed");
      await setReminderStatus(r.id, "failed");
    }
  }
}

/** Schedules the reminders tick (Phase 4). Safe to call once at startup. */
export function scheduleRemindersTick(): void {
  const expr = config.cron.reminders;
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "Invalid CRON_REMINDERS — reminders tick disabled");
    return;
  }
  remindersTask?.stop();
  remindersTask = cron.schedule(expr, async () => {
    try {
      await runDueReminders();
    } catch (error) {
      logger.error({ error }, "Reminders tick failed");
    }
  });
  logger.info({ schedule: expr }, "Reminders tick scheduled");
}

/** (Re)schedule the internal staff report cron from the live engine_config value (TZ: ART). */
export async function rescheduleInternalReport(): Promise<string> {
  let expr = config.cron.internalReport;
  try {
    expr = await getInternalReportSchedule();
  } catch (error) {
    logger.warn({ error }, "Could not read internal_report_schedule — using fallback");
  }
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "Invalid internal_report_schedule cron — using fallback");
    expr = config.cron.internalReport;
  }
  internalReportTask?.stop();
  internalReportTask = cron.schedule(expr, async () => {
    try {
      await runInternalReport();
    } catch (error) {
      logger.error({ error }, "Internal report cycle failed");
    }
  }, { timezone: REPORT_TZ });
  logger.info({ schedule: expr, tz: REPORT_TZ }, "Internal report scheduled");
  return expr;
}

/** (Re)schedule the weekly report cron from the live engine_config value. Returns the cron expr used. */
export async function rescheduleWeeklyReport(): Promise<string> {
  let expr = config.cron.weeklyReport;
  try {
    expr = await getReportSchedule();
  } catch (error) {
    logger.warn({ error }, "Could not read report_schedule — using fallback");
  }
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "Invalid report_schedule cron — using fallback");
    expr = config.cron.weeklyReport;
  }
  reportTask?.stop();
  reportTask = cron.schedule(expr, async () => {
    try {
      await runWeeklyReport();
    } catch (error) {
      logger.error({ error }, "Weekly report cycle failed");
    }
  });
  logger.info({ schedule: expr }, "Weekly report scheduled");
  return expr;
}
