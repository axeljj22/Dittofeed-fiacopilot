/**
 * Journey 4 — Recuperación de leads fríos
 *
 * Detecta usuarios que completaron el diagnóstico hace +15 días
 * pero no se suscribieron (plan = 'lead').
 * Un solo intento — si no convierte, no se vuelve a contactar.
 */
import { subDays, differenceInDays } from "date-fns";
import { config } from "../config";
import { logger } from "../logger";
import {
  getActiveUsersWithWhatsapp,
  getPaidUserIds,
  getContactedUserIdsForJourney,
  getUserIdsWithEventsSince,
  getLeadScoresForUsers,
} from "../db/supabase";
import type { EngagementOpportunity } from "../db/types";

export async function detectColdLeads(): Promise<EngagementOpportunity[]> {
  const opportunities: EngagementOpportunity[] = [];

  const users = await getActiveUsersWithWhatsapp();
  if (users.length === 0) return opportunities;

  const threshold = subDays(new Date(), config.engine.coldLeadDays);
  const userIds = users.map((u) => u.id);

  // Batch all per-user lookups in parallel
  const [paidIds, contactedIds, activeIds, scoresMap] = await Promise.all([
    getPaidUserIds(userIds),
    getContactedUserIdsForJourney(userIds, "recuperacion_lead_frio"),
    getUserIdsWithEventsSince(userIds, threshold.toISOString()),
    getLeadScoresForUsers(userIds),
  ]);

  for (const user of users) {
    if (paidIds.has(user.id)) continue;
    if (contactedIds.has(user.id)) continue;
    if (activeIds.has(user.id)) continue; // recent activity → not cold

    const scores = scoresMap.get(user.id);
    if (!scores) continue; // no diagnostic completed

    const daysSinceDiagnostic = differenceInDays(
      new Date(),
      new Date(scores.last_calculated_at),
    );

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
        daysSinceDiagnostic,
      },
    });
  }

  logger.info(
    { count: opportunities.length },
    "Cold leads detector completed",
  );
  return opportunities;
}
