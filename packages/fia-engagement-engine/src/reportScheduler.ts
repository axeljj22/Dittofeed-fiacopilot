/**
 * Weekly report cron scheduler — extracted so both the entrypoint (index.ts) and the
 * admin API (server.ts) can (re)schedule it without a circular import.
 */
import cron from "node-cron";
import { config } from "./config";
import { logger } from "./logger";
import { runWeeklyReport } from "./orchestrator";
import { getReportSchedule } from "./config/engineConfigCache";

let reportTask: cron.ScheduledTask | null = null;

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
