/**
 * Weekly report cron scheduler — extracted so both the entrypoint (index.ts) and the
 * admin API (server.ts) can (re)schedule it without a circular import.
 */
import cron from "node-cron";
import { config } from "./config";
import { logger } from "./logger";
import { runWeeklyReport, runInternalReport } from "./orchestrator";
import { getReportSchedule, getInternalReportSchedule } from "./config/engineConfigCache";

let reportTask: cron.ScheduledTask | null = null;
let internalReportTask: cron.ScheduledTask | null = null;

const REPORT_TZ = "America/Argentina/Buenos_Aires";

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
