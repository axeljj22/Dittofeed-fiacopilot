/**
 * Orchestrator — the brain of the Engagement Engine
 *
 * Runs detectors on a schedule, generates messages with Claude,
 * delivers via WhatsApp, and logs everything.
 *
 * Flow:
 * 1. Detectors scan Supabase → produce EngagementOpportunity[]
 * 2. Rate limiter filters → only actionable opportunities pass
 * 3. Claude generates personalized message for each
 * 4. WhatsApp sender delivers
 * 5. engagement_log records the outcome
 */
import { config } from "./config";
import { logger } from "./logger";
import { getRecentEngagementForUser } from "./db/supabase";

/**
 * Returns true if the current time is within business hours in the given timezone.
 * Business hours: Mon–Fri 9:00–18:00.
 */
function isBusinessHours(timezone: string): boolean {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);

  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);

  const isWeekday = !["Sat", "Sun"].includes(weekday);
  const isDaytime = hour >= 9 && hour < 18;

  return isWeekday && isDaytime;
}

/** Timezone per country code — defaults to Argentina if unknown */
const COUNTRY_TIMEZONES: Record<string, string> = {
  AR: "America/Buenos_Aires",
  CL: "America/Santiago",
  CO: "America/Bogota",
  MX: "America/Mexico_City",
  PE: "America/Lima",
  UY: "America/Montevideo",
  VE: "America/Caracas",
  EC: "America/Guayaquil",
  BO: "America/La_Paz",
  PY: "America/Asuncion",
};

function getTimezoneForUser(countryCode?: string | null): string {
  return COUNTRY_TIMEZONES[countryCode?.toUpperCase() ?? ""] ?? config.engine.defaultTimezone;
}
import { detectWeeklyReportRecipients } from "./detectors";
import { generateMessage } from "./generators/messageGenerator";
import { sendWhatsAppMessage } from "./senders/whatsapp";
import type { EngagementOpportunity } from "./db/types";

/**
 * Rate limit check: don't exceed max messages per user per day.
 */
async function isRateLimited(userId: string): Promise<boolean> {
  const recent = await getRecentEngagementForUser(userId, 24);
  const sentCount = recent.filter((e) => e.status === "sent").length;
  return sentCount >= config.engine.maxMessagesPerUserPerDay;
}

/**
 * Process a single engagement opportunity through the full pipeline.
 */
async function processOpportunity(
  opportunity: EngagementOpportunity,
): Promise<void> {
  const { userId, journeyName } = opportunity;

  // Pilot mode — only send to the configured pilot phone
  if (config.engine.pilotPhone) {
    const userPhone = (opportunity.profile.phone ?? "").replace(/\D/g, "");
    const pilotPhone = config.engine.pilotPhone.replace(/\D/g, "");
    if (userPhone !== pilotPhone) {
      logger.debug(
        { userId, journeyName, userPhone },
        "Pilot mode active — skipping non-pilot user",
      );
      return;
    }
  }

  // Business hours check — only send Mon–Fri 9:00–18:00 in user's timezone
  if (!config.engine.bypassBusinessHours) {
    const timezone = getTimezoneForUser(opportunity.profile.country);
    if (!isBusinessHours(timezone)) {
      logger.info(
        { userId, journeyName, timezone },
        "Outside business hours — skipping until next window",
      );
      return;
    }
  }

  // Rate limit check
  if (await isRateLimited(userId)) {
    logger.info(
      { userId, journeyName },
      "Rate limited — skipping",
    );
    return;
  }

  // Generate personalized message
  const message = await generateMessage(opportunity);
  if (!message) {
    logger.warn(
      { userId, journeyName },
      "Message generation failed — skipping",
    );
    return;
  }

  // Send via WhatsApp
  await sendWhatsAppMessage(opportunity, message);
}

/**
 * Process a batch of opportunities in parallel.
 * Uses allSettled so one failure doesn't block the rest.
 */
async function processAll(opportunities: EngagementOpportunity[]): Promise<void> {
  if (opportunities.length === 0) return;

  const results = await Promise.allSettled(
    opportunities.map((op) => processOpportunity(op)),
  );

  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    logger.error(
      { failed: failed.length, total: opportunities.length },
      "Some opportunities failed during processing",
    );
    for (const f of failed) {
      logger.error({ reason: (f as PromiseRejectedResult).reason }, "Opportunity error");
    }
  }
}

/**
 * Run the weekly report — the only journey.
 * Builds one personalized report opportunity per Sofía-active user and sends it.
 */
export async function runWeeklyReport(): Promise<void> {
  logger.info("Running weekly report");

  const opportunities = await detectWeeklyReportRecipients();

  logger.info({ count: opportunities.length }, "Weekly report opportunities to send");

  await processAll(opportunities);
}
