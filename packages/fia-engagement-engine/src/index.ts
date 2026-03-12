/**
 * FIA Engagement Engine
 *
 * Sidecar independiente que lee Supabase, detecta oportunidades
 * de engagement, genera mensajes con Claude, y entrega por WhatsApp.
 *
 * No modifica FIA Copilot. Solo lee la DB y escribe en engagement_log.
 */
import cron from "node-cron";
import { config } from "./config";
import { logger } from "./logger";
import {
  runEventDetectors,
  runSegmentDetectors,
  runSponsorReports,
  runAllDetectors,
} from "./orchestrator";

function startScheduler(): void {
  logger.info(
    {
      detectorsCron: config.cron.detectors,
      sponsorCron: config.cron.sponsorReport,
    },
    "Starting FIA Engagement Engine scheduler",
  );

  // Event detectors: check for completions, diagnostics (every 15 min)
  cron.schedule(config.cron.detectors, async () => {
    try {
      await runEventDetectors();
      await runSegmentDetectors();
    } catch (error) {
      logger.error({ error }, "Detector cycle failed");
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

  logger.info("Scheduler started — engine is running");
}

// ─── CLI entry point ───

const args = process.argv.slice(2);

if (args.includes("--once")) {
  // Run all detectors once and exit (useful for testing)
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
} else {
  // Default: start the scheduler
  startScheduler();
}
