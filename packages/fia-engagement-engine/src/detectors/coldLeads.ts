/**
 * Journey 4 — Recuperación de leads fríos
 *
 * Detecta usuarios que completaron el diagnóstico hace +15 días
 * pero no se suscribieron (plan = 'lead').
 * Un solo intento — si no convierte, no se vuelve a contactar.
 */
import { subDays } from "date-fns";
import { config } from "../config";
import { logger } from "../logger";
import {
  getActiveUsersWithWhatsapp,
  getLeadScoreForUser,
  getEventsForUserSince,
  hasBeenContactedForJourney,
} from "../db/supabase";
import type { EngagementOpportunity } from "../db/types";

export async function detectColdLeads(): Promise<EngagementOpportunity[]> {
  const opportunities: EngagementOpportunity[] = [];

  const users = await getActiveUsersWithWhatsapp();
  const threshold = subDays(new Date(), config.engine.coldLeadDays);

  for (const user of users) {
    // Only leads (not subscribed)
    if (user.plan !== "lead") continue;

    // Already contacted for this journey — one shot only
    const alreadySent = await hasBeenContactedForJourney(
      user.id,
      "recuperacion_lead_frio",
    );
    if (alreadySent) continue;

    // Check if diagnostic was completed before threshold
    const recentEvents = await getEventsForUserSince(
      user.id,
      threshold.toISOString(),
    );

    // If they have recent activity, they're not cold
    if (recentEvents.length > 0) continue;

    const scores = await getLeadScoreForUser(user.id);
    if (!scores) continue; // No diagnostic completed

    const deepLink = `${config.engine.appBaseUrl}/upgrade?ref=reactivacion_lead`;

    opportunities.push({
      userId: user.id,
      journeyName: "recuperacion_lead_frio",
      profile: user,
      deepLink,
      context: {
        fitScore: scores.fit_score,
        intentScore: scores.intent_score,
        overallScore: scores.overall_score,
        daysSinceDiagnostic: config.engine.coldLeadDays,
      },
    });
  }

  logger.info(
    { count: opportunities.length },
    "Cold leads detector completed",
  );
  return opportunities;
}
