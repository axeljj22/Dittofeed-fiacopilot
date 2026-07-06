/**
 * FIA Engagement Engine
 *
 * Sidecar independiente que lee Supabase, arma el reporte semanal de Sofía,
 * lo entrega por WhatsApp, y atiende mensajes entrantes.
 *
 * No modifica FIA Copilot salvo opt-out. Lee la DB y escribe en engagement_log + sofia_conversations.
 *
 * Modes:
 *   (default)  Start scheduler + HTTP server
 *   --once     Run the weekly report once and exit
 *   --server   Start HTTP server only (no scheduler)
 */
import cron from "node-cron";
import { config } from "./config";
import { logger } from "./logger";
import { startServer } from "./server";
import { runWeeklyReport, runAgenticaPurchaseAlerts } from "./orchestrator";
import { retryFailedMessages } from "./senders/whatsapp";
import { rescheduleWeeklyReport, rescheduleInternalReport } from "./reportScheduler";
import { classifyRecentConversations } from "./jobs/classifyConversations";

async function startScheduler(): Promise<void> {
  logger.info("Starting FIA Engagement Engine scheduler");

  // Weekly report — single configurable cron (Domingo 17:00 by default)
  await rescheduleWeeklyReport();

  // Internal staff control report — Sunday PM (ART), to the control group
  await rescheduleInternalReport();

  // Retry failed messages — every 30 minutes (set CRON_RETRY_FAILED to never-fire to disable)
  cron.schedule(config.cron.retryFailed, async () => {
    try {
      await retryFailedMessages();
    } catch (error) {
      logger.error({ error }, "Failed message retry cycle failed");
    }
  });

  // Poll for new FIA Agéntica self-paced purchases → alert the internal group
  // (set CRON_AGENTICA_ALERTS to a never-fire expr to disable)
  cron.schedule(config.cron.agenticaAlerts, async () => {
    try {
      await runAgenticaPurchaseAlerts();
    } catch (error) {
      logger.error({ error }, "Agéntica purchase-alert cycle failed");
    }
  });

  // Classify inbound conversations for the observability dashboard
  cron.schedule(config.classifyCron, async () => {
    try {
      await classifyRecentConversations();
    } catch (error) {
      logger.error({ error }, "Conversation classification cycle failed");
    }
  });

  logger.info("Scheduler started — engine is running");
}

// ─── CLI entry point ───

const args = process.argv.slice(2);
const port = parseInt(process.env["ENGINE_PORT"] ?? "3001", 10);

if (args.includes("--once")) {
  logger.info("Running weekly report once (--once mode)");
  runWeeklyReport()
    .then(() => {
      logger.info("Single run completed");
      process.exit(0);
    })
    .catch((error) => {
      logger.error({ error }, "Single run failed");
      process.exit(1);
    });
} else if (args.includes("--server")) {
  startServer(port);
} else {
  // Default: both scheduler + server
  void startScheduler();
  startServer(port);
}
