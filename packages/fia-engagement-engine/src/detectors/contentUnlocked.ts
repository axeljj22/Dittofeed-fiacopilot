/**
 * Journey 6 — Campaña activa (content_unlocked)
 *
 * Detecta usuarios con acceso especial desbloqueado (content_unlocked = true)
 * que llevan X días sin actividad. Un empujón para que aprovechen el acceso.
 *
 * Cooldown: 7 días entre contactos para el mismo usuario.
 */
import { differenceInDays } from "date-fns";
import { config } from "../config";
import { logger } from "../logger";
import {
  getActiveUsersWithWhatsapp,
  getLastEventsForUsers,
  getContactedUserIdsForJourney,
  getCapsuleProgressForUsers,
} from "../db/supabase";
import type { EngagementOpportunity, CapsuleProgress } from "../db/types";

const COOLDOWN_HOURS = 7 * 24; // 7 days between contacts

function findNextCapsule(progress: CapsuleProgress[]): CapsuleProgress | undefined {
  // First pending (viewed/in_progress), then first not_started
  const pending = progress
    .filter((p) => p.status === "viewed" || p.status === "in_progress")
    .sort((a, b) => a.capsule_number - b.capsule_number)[0];

  if (pending) return pending;

  const completedNumbers = new Set(
    progress.filter((p) => p.status === "completed").map((p) => p.capsule_number),
  );

  // Find the lowest capsule not yet completed
  const notStarted = progress
    .filter((p) => !completedNumbers.has(p.capsule_number) && p.status === "not_started")
    .sort((a, b) => a.capsule_number - b.capsule_number)[0];

  return notStarted;
}

export async function detectContentUnlocked(): Promise<EngagementOpportunity[]> {
  const opportunities: EngagementOpportunity[] = [];

  const allUsers = await getActiveUsersWithWhatsapp();

  // Only users with special campaign access
  const users = allUsers.filter((u) => u.content_unlocked);
  if (users.length === 0) {
    logger.info({ count: 0 }, "Campaña activa detector completed");
    return opportunities;
  }

  const userIds = users.map((u) => u.id);

  const [contactedIds, lastEventsMap, progressMap] = await Promise.all([
    getContactedUserIdsForJourney(userIds, "campana_activa", COOLDOWN_HOURS),
    getLastEventsForUsers(userIds),
    getCapsuleProgressForUsers(userIds),
  ]);

  for (const user of users) {
    if (contactedIds.has(user.id)) continue;

    const lastEvent = lastEventsMap.get(user.id);
    const daysSince = lastEvent
      ? differenceInDays(new Date(), new Date(lastEvent.created_at))
      : Infinity;

    if (daysSince < config.engine.inactivityDays) continue; // still active

    const userProgress = progressMap.get(user.id) ?? [];
    const totalCompleted = userProgress.filter((p) => p.status === "completed").length;
    const nextCapsule = findNextCapsule(userProgress);

    const deepLink = nextCapsule
      ? `${config.engine.appBaseUrl}/capsulas/${nextCapsule.capsule_number}`
      : `${config.engine.appBaseUrl}/capsulas`;

    opportunities.push({
      userId: user.id,
      journeyName: "campana_activa",
      profile: user,
      deepLink,
      context: {
        daysSinceLastEvent: isFinite(daysSince) ? daysSince : null,
        nextCapsuleNumber: nextCapsule?.capsule_number ?? null,
        nextCapsuleTitle: nextCapsule?.capsule_title ?? null,
        totalCompleted,
      },
    });
  }

  logger.info(
    { count: opportunities.length },
    "Campaña activa detector completed",
  );
  return opportunities;
}
