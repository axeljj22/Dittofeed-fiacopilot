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
import {
  detectInactiveUsers,
  detectCompletedCapsules,
  detectPostDiagnostic,
  detectColdLeads,
  detectSponsorReports,
} from "./detectors";
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

  // Pilot mode — only send to the configured pilot email
  if (config.engine.pilotEmail) {
    const userEmail = (opportunity.profile as { email?: string }).email ?? "";
    if (userEmail !== config.engine.pilotEmail) {
      logger.debug(
        { userId, journeyName, userEmail },
        "Pilot mode active — skipping non-pilot user",
      );
      return;
    }
  }

  // Business hours check — only send Mon–Fri 9:00–18:00 in user's timezone
  const timezone = getTimezoneForUser(
    (opportunity.profile as { country?: string | null }).country,
  );
  if (!isBusinessHours(timezone)) {
    logger.info(
      { userId, journeyName, timezone },
      "Outside business hours — skipping until next window",
    );
    return;
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
 * Run all event-based detectors (completion, post-diagnostic).
 * These check for recent events and should run frequently.
 */
export async function runEventDetectors(): Promise<void> {
  logger.info("Running event-based detectors");

  const [completions, diagnostics] = await Promise.all([
    detectCompletedCapsules(),
    detectPostDiagnostic(),
  ]);

  const allOpportunities = [...completions, ...diagnostics];

  logger.info(
    {
      completions: completions.length,
      diagnostics: diagnostics.length,
      total: allOpportunities.length,
    },
    "Event detectors found opportunities",
  );

  for (const opportunity of allOpportunities) {
    await processOpportunity(opportunity);
  }
}

/**
 * Run all segment-based detectors (inactivity, cold leads).
 * These scan user segments and can run less frequently.
 */
export async function runSegmentDetectors(): Promise<void> {
  logger.info("Running segment-based detectors");

  const [inactive, coldLeads] = await Promise.all([
    detectInactiveUsers(),
    detectColdLeads(),
  ]);

  const allOpportunities = [...inactive, ...coldLeads];

  logger.info(
    {
      inactive: inactive.length,
      coldLeads: coldLeads.length,
      total: allOpportunities.length,
    },
    "Segment detectors found opportunities",
  );

  for (const opportunity of allOpportunities) {
    await processOpportunity(opportunity);
  }
}

/**
 * Run the weekly sponsor report detector.
 */
export async function runSponsorReports(): Promise<void> {
  logger.info("Running sponsor report detector");

  const reports = await detectSponsorReports();

  logger.info(
    { count: reports.length },
    "Sponsor reports to send",
  );

  for (const opportunity of reports) {
    await processOpportunity(opportunity);
  }
}

/**
 * Run all detectors at once (for manual trigger / testing).
 */
export async function runAllDetectors(): Promise<void> {
  await Promise.all([
    runEventDetectors(),
    runSegmentDetectors(),
  ]);
}
