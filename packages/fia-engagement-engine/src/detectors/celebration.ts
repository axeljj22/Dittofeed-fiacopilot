/**
 * Journey 2 — Celebración de cápsula completada
 *
 * Detecta eventos capsule_completed recientes y genera oportunidad
 * de mensaje de celebración + presentación de la siguiente cápsula.
 */
import { config } from "../config";
import { logger } from "../logger";
import {
  getRecentEventsByType,
  getProfileWithWhatsapp,
  getCapsuleProgressForUser,
  hasBeenContactedForJourney,
} from "../db/supabase";
import type { EngagementOpportunity } from "../db/types";

export async function detectCompletedCapsules(): Promise<
  EngagementOpportunity[]
> {
  const opportunities: EngagementOpportunity[] = [];

  // Look for capsule_completed events in the last detection window
  const recentCompletions = await getRecentEventsByType(
    "capsule_completed",
    config.engine.celebrationDelayMinutes,
  );

  // Deduplicate by user (only latest completion matters)
  const latestByUser = new Map<string, (typeof recentCompletions)[0]>();
  for (const event of recentCompletions) {
    const existing = latestByUser.get(event.user_id);
    if (!existing || event.created_at > existing.created_at) {
      latestByUser.set(event.user_id, event);
    }
  }

  for (const [userId, event] of latestByUser) {
    const profile = await getProfileWithWhatsapp(userId);
    if (!profile?.whatsapp || profile.wp_opted_out) continue;

    const capsuleNumero =
      (event.metadata as { capsule_numero?: number }).capsule_numero ?? 0;
    const nextCapsule = capsuleNumero + 1;

    // Don't celebrate capsule 25 with "next capsule" — it's the last one
    const isLastCapsule = capsuleNumero >= 25;

    const deepLink = isLastCapsule
      ? `${config.engine.appBaseUrl}/boveda`
      : `${config.engine.appBaseUrl}/capsulas/${nextCapsule}`;

    opportunities.push({
      userId,
      journeyName: "celebracion_capsula",
      profile,
      deepLink,
      context: {
        completedCapsuleNumero: capsuleNumero,
        nextCapsuleNumero: isLastCapsule ? null : nextCapsule,
        isLastCapsule,
        totalCompleted: (await getCapsuleProgressForUser(userId)).filter(
          (p) => p.status === "completed",
        ).length,
      },
    });
  }

  logger.info(
    { count: opportunities.length },
    "Celebration detector completed",
  );
  return opportunities;
}
