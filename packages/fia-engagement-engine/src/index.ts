/**
 * FIA Engagement Engine
 *
 * Sidecar independiente que lee Supabase, detecta oportunidades
 * de engagement, genera mensajes con Claude, y entrega por WhatsApp.
 *
 * No modifica FIA Copilot. Solo lee la DB y escribe en engagement_log.
 *
 * Modes:
 *   (default)  Start scheduler + HTTP server
 *   --once     Run all detectors once and exit
 *   --server   Start HTTP server only (no scheduler)
 */
import cron from "node-cron";
import { config } from "./config";
import { logger } from "./logger";
import { startServer } from "./server";
import {
  runEventDetectors,
  runSegmentDetectors,
  runSponsorReports,
  runAllDetectors,
} from "./orchestrator";
import { retryFailedMessages } from "./senders/whatsapp";

function startScheduler(): void {
  logger.info(
    {
      detectorsCron: config.cron.detectors,
      sponsorCron: config.cron.sponsorReport,
    },
    "Starting FIA Engagement Engine scheduler",
  );

  // Event detectors: time-sensitive (capsule completions, diagnostics) — every 15 min
  cron.schedule(config.cron.detectors, async () => {
    try {
      await runEventDetectors();
    } catch (error) {
      logger.error({ error }, "Event detector cycle failed");
    }
  });

  // Segment detectors: inactivity, cold leads, content unlocked — every 2 hours
  // These are not time-sensitive; running less often reduces DB load significantly
  cron.schedule(config.cron.segmentDetectors, async () => {
    try {
      await runSegmentDetectors();
    } catch (error) {
      logger.error({ error }, "Segment detector cycle failed");
    }
  });

  // Sponsor weekly report: Mondays 9 AM
  cron.schedule(config.cron.sponsorReport, async () => {
    try {
      await runSponsorReports();
    } catch (error) {
      logger.error({ error }, "Sponsor report cycle failed");
    }
  });

  // Retry failed messages every 30 minutes (max 3 attempts per message, then mark terminal failed)
  cron.schedule("*/30 * * * *", async () => {
    try {
      await retryFailedMessages();
    } catch (error) {
      logger.error({ error }, "Failed message retry cycle failed");
    }
  });

  logger.info("Scheduler started — engine is running");
}

// ─── CLI entry point ───

const args = process.argv.slice(2);
const port = parseInt(process.env["ENGINE_PORT"] ?? "3001", 10);

if (args.includes("--once")) {
  logger.info("Running all detectors once (--once mode)");
  runAllDetectors()
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
  startScheduler();
  startServer(port);
}
