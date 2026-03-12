/**
 * Journey 1 — Reactivación por inactividad
 *
 * Detecta usuarios sin actividad en X días con cápsulas pendientes.
 * Tres niveles: día 5 (suave), día 10 (con contexto Bóveda), día 20 (última llamada).
 */
import { subDays, differenceInDays } from "date-fns";
import { config } from "../config";
import { logger } from "../logger";
import {
  getActiveUsersWithWhatsapp,
  getLastEventForUser,
  getUsersWithPendingCapsules,
  getRecentEngagementForUser,
  getCapsuleProgressForUser,
} from "../db/supabase";
import type { EngagementOpportunity, CapsuleProgress } from "../db/types";

function getInactivityLevel(daysSinceLastEvent: number): number | null {
  if (daysSinceLastEvent >= 20) return 3;
  if (daysSinceLastEvent >= 10) return 2;
  if (daysSinceLastEvent >= config.engine.inactivityDays) return 1;
  return null;
}

function findPendingCapsule(
  progress: CapsuleProgress[],
): CapsuleProgress | undefined {
  return progress.find(
    (p) => p.status === "started" || p.status === "in_progress",
  );
}

export async function detectInactiveUsers(): Promise<EngagementOpportunity[]> {
  const opportunities: EngagementOpportunity[] = [];

  const users = await getActiveUsersWithWhatsapp();
  const pendingProgress = await getUsersWithPendingCapsules();

  // Group pending capsules by user
  const pendingByUser = new Map<string, CapsuleProgress[]>();
  for (const p of pendingProgress) {
    const existing = pendingByUser.get(p.user_id) ?? [];
    existing.push(p);
    pendingByUser.set(p.user_id, existing);
  }

  for (const user of users) {
    const userPending = pendingByUser.get(user.id);
    if (!userPending || userPending.length === 0) continue;

    const lastEvent = await getLastEventForUser(user.id);
    if (!lastEvent) continue;

    const daysSince = differenceInDays(
      new Date(),
      new Date(lastEvent.created_at),
    );
    const level = getInactivityLevel(daysSince);
    if (level === null) continue;

    // Check rate limiting — don't re-send same level
    const recentEngagement = await getRecentEngagementForUser(
      user.id,
      level === 1 ? 120 : level === 2 ? 240 : 480, // hours between levels
    );
    const alreadySentThisLevel = recentEngagement.some(
      (e) =>
        e.journey_name === "reactivacion_inactividad" &&
        e.status === "sent",
    );
    if (alreadySentThisLevel) continue;

    const pending = findPendingCapsule(userPending);
    if (!pending) continue;

    const deepLink = `${config.engine.appBaseUrl}/capsulas/${pending.capsule_numero}`;

    opportunities.push({
      userId: user.id,
      journeyName: "reactivacion_inactividad",
      profile: user,
      level,
      deepLink,
      context: {
        daysSinceLastEvent: daysSince,
        pendingCapsuleNumero: pending.capsule_numero,
        pendingCapsuleStatus: pending.status,
      },
    });
  }

  logger.info(
    { count: opportunities.length },
    "Inactivity detector completed",
  );
  return opportunities;
}
