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
  getProfileWithWhatsapp,
  getLeadScoreForUser,
  hasBeenContactedForJourney,
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
    "diagnostico_completed",
    config.engine.postDiagnosticDelayMinutes,
  );

  for (const event of recentDiagnostics) {
    const userId = event.user_id;

    // Don't send twice
    const alreadySent = await hasBeenContactedForJourney(
      userId,
      "bienvenida_diagnostico",
    );
    if (alreadySent) continue;

    const profile = await getProfileWithWhatsapp(userId);
    if (!profile?.whatsapp || profile.wp_opted_out) continue;

    const scores = await getLeadScoreForUser(userId);
    const fitScore = scores?.fit_score ?? 0;
    const intentScore = scores?.intent_score ?? 0;
    const overallScore = scores?.overall_score ?? 0;

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
      },
    });
  }

  logger.info(
    { count: opportunities.length },
    "Post-diagnostic detector completed",
  );
  return opportunities;
}
