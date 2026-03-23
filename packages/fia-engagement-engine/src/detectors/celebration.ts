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
    const existing = latestByUser.get(event.lead_id);
    if (!existing || event.created_at > existing.created_at) {
      latestByUser.set(event.lead_id, event);
    }
  }

  for (const [userId, event] of latestByUser) {
    // Don't send twice for this capsule (48h window — each capsule is completed once)
    const alreadySent = await hasBeenContactedForJourney(
      userId,
      "celebracion_capsula",
      48,
    );
    if (alreadySent) continue;

    const profile = await getProfileWithWhatsapp(userId);
    if (!profile?.phone || !profile.whatsapp_opt_in) continue;

    const meta = event.metadata as { capsule_number?: number; capsule_numero?: number } | null;
    const capsuleNumero = meta?.capsule_number ?? meta?.capsule_numero ?? 0;

    // Skip if capsule number is invalid
    if (capsuleNumero < 1) {
      logger.warn({ userId, capsuleNumero }, "Invalid capsule_number in celebration event — skipping");
      continue;
    }

    const nextCapsule = capsuleNumero + 1;

    // Don't celebrate the last capsule with "next capsule" — it's the end
    const isLastCapsule = capsuleNumero >= config.engine.totalCapsules;

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
