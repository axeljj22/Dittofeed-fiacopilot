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
  getProfilesForUsers,
  getCapsuleProgressForUsers,
  getContactedUserIdsForJourney,
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
    const existing = latestByUser.get(event.lead_id);
    if (!existing || event.created_at > existing.created_at) {
      latestByUser.set(event.lead_id, event);
    }
  }

  if (latestByUser.size === 0) {
    logger.info({ count: 0 }, "Celebration detector completed");
    return opportunities;
  }

  const userIds = [...latestByUser.keys()];

  // Batch: contacted check, profiles, and capsule progress
  const [contactedIds, profilesMap, progressMap] = await Promise.all([
    getContactedUserIdsForJourney(userIds, "celebracion_capsula", 48),
    getProfilesForUsers(userIds),
    getCapsuleProgressForUsers(userIds),
  ]);

  for (const [userId, event] of latestByUser) {
    if (contactedIds.has(userId)) continue;

    const profile = profilesMap.get(userId);
    if (!profile?.phone || !profile.whatsapp_opt_in) continue;

    const meta = event.metadata as { capsule_number?: number; capsule_numero?: number } | null;
    const capsuleNumero = meta?.capsule_number ?? meta?.capsule_numero ?? 0;

    if (capsuleNumero < 1) {
      logger.warn({ userId, capsuleNumero }, "Invalid capsule_number in celebration event — skipping");
      continue;
    }

    const nextCapsule = capsuleNumero + 1;
    const isLastCapsule = capsuleNumero >= config.engine.totalCapsules;

    const deepLink = isLastCapsule
      ? `${config.engine.appBaseUrl}/boveda`
      : `${config.engine.appBaseUrl}/capsulas/${nextCapsule}`;

    const userProgress = progressMap.get(userId) ?? [];
    const totalCompleted = userProgress.filter((p) => p.status === "completed").length;

    opportunities.push({
      userId,
      journeyName: "celebracion_capsula",
      profile,
      deepLink,
      context: {
        completedCapsuleNumber: capsuleNumero,
        nextCapsuleNumber: isLastCapsule ? null : nextCapsule,
        isLastCapsule,
        totalCompleted,
      },
    });
  }

  logger.info(
    { count: opportunities.length },
    "Celebration detector completed",
  );
  return opportunities;
}
