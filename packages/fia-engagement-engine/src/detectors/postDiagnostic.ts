/**
 * Journey 3 — Bienvenida post-diagnóstico
 *
 * Detecta usuarios que completaron el diagnóstico recientemente.
 * Envía mensaje con resumen del score + cápsula recomendada.
 */
import { config } from "../config";
import { logger } from "../logger";
import {
  getRecentEventsByType,
  getProfilesForUsers,
  getLeadScoresForUsers,
  getAssessmentsForUsers,
  getContactedUserIdsForJourney,
} from "../db/supabase";
import type { EngagementOpportunity } from "../db/types";

/**
 * Recommends starting capsule based on fit + intent scores.
 * Higher scores → can skip intro capsules.
 */
function recommendStartingCapsule(
  fitScore: number,
  intentScore: number,
): number {
  const avg = (fitScore + intentScore) / 2;
  if (avg >= 80) return 3; // Advanced — skip basics
  if (avg >= 50) return 2; // Intermediate
  return 1; // Start from the beginning
}

export async function detectPostDiagnostic(): Promise<
  EngagementOpportunity[]
> {
  const opportunities: EngagementOpportunity[] = [];

  const recentDiagnostics = await getRecentEventsByType(
    "assessment_submitted",
    config.engine.postDiagnosticDelayMinutes,
  );

  if (recentDiagnostics.length === 0) {
    logger.info({ count: 0 }, "Post-diagnostic detector completed");
    return opportunities;
  }

  // Deduplicate — only latest event per user matters
  const latestByUser = new Map<string, (typeof recentDiagnostics)[0]>();
  for (const event of recentDiagnostics) {
    const existing = latestByUser.get(event.lead_id);
    if (!existing || event.created_at > existing.created_at) {
      latestByUser.set(event.lead_id, event);
    }
  }

  const userIds = [...latestByUser.keys()];

  // Batch all per-user lookups in parallel
  const [contactedIds, profilesMap, scoresMap, assessmentsMap] = await Promise.all([
    getContactedUserIdsForJourney(userIds, "bienvenida_diagnostico"),
    getProfilesForUsers(userIds),
    getLeadScoresForUsers(userIds),
    getAssessmentsForUsers(userIds),
  ]);

  for (const userId of userIds) {
    if (contactedIds.has(userId)) continue;

    const profile = profilesMap.get(userId);
    if (!profile?.phone || !profile.whatsapp_opt_in) continue;

    const scores = scoresMap.get(userId);
    const assessment = assessmentsMap.get(userId);

    const fitScore = scores?.fit_score ?? 0;
    const intentScore = scores?.intent_score ?? 0;
    const overallScore = scores?.overall_score ?? assessment?.score ?? 0;
    const painAreas = assessment?.pain_areas ?? [];

    const recommendedCapsule = recommendStartingCapsule(fitScore, intentScore);
    const deepLink = `${config.engine.appBaseUrl}/capsulas/${recommendedCapsule}`;

    opportunities.push({
      userId,
      journeyName: "bienvenida_diagnostico",
      profile,
      deepLink,
      context: {
        fitScore,
        intentScore,
        overallScore,
        recommendedCapsule,
        painAreas,
      },
    });
  }

  logger.info(
    { count: opportunities.length },
    "Post-diagnostic detector completed",
  );
  return opportunities;
}
