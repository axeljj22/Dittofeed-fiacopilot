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
  getPathTotals,
  resolveUserPaths,
} from "../db/supabase";
import { getSegmentFollowupConfig } from "../config/engineConfigCache";
import type { EngagementOpportunity, CapsuleProgress, UserPathStatus } from "../db/types";

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

  const [contactedIds, lastEventsMap, progressMap, pathTotals, followupConfig] = await Promise.all([
    getContactedUserIdsForJourney(userIds, "campana_activa", 7 * 24),
    getLastEventsForUsers(userIds),
    getCapsuleProgressForUsers(userIds),
    getPathTotals(),
    getSegmentFollowupConfig(),
  ]);

  for (const user of users) {
    if (contactedIds.has(user.id)) continue;

    const lastEvent = lastEventsMap.get(user.id);
    const daysSince = lastEvent
      ? differenceInDays(new Date(), new Date(lastEvent.created_at))
      : Infinity;

    const userProgress = progressMap.get(user.id) ?? [];
    const userPaths = resolveUserPaths(userProgress, pathTotals);
    const isPaid = userPaths.some((p) => p.isPaid);
    const cadence = isPaid ? followupConfig.paid : followupConfig.free;

    if (daysSince < cadence.campaignCooldownDays) continue; // still active by cadence

    const activePath = userPaths.find((p) => p.activePath) ?? userPaths[0];
    const nextCapsuleNumber = activePath?.nextCapsuleNumber ?? null;
    const nextCapsuleTitle = activePath?.nextCapsuleTitle ?? null;
    const totalCompleted = userProgress.filter((p) => p.status === "completed").length;

    const deepLink = nextCapsuleNumber
      ? `${config.engine.appBaseUrl}/capsulas/${nextCapsuleNumber}`
      : `${config.engine.appBaseUrl}/capsulas`;

    opportunities.push({
      userId: user.id,
      journeyName: "campana_activa",
      profile: user,
      deepLink,
      context: {
        daysSinceLastEvent: isFinite(daysSince) ? daysSince : null,
        nextCapsuleNumber,
        nextCapsuleTitle,
        totalCompleted,
        programName: activePath?.name ?? null,
        pathProgress: activePath ? `${activePath.completed}/${activePath.total}` : null,
        isPaidProgram: isPaid,
      },
    });
  }

  logger.info(
    { count: opportunities.length },
    "Campaña activa detector completed",
  );
  return opportunities;
}
