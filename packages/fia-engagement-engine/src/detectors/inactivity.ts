/**
 * Journey 1 — Reactivación por inactividad
 *
 * Detecta usuarios sin actividad en X días con cápsulas pendientes.
 * Tres niveles: día 5 (suave), día 10 (con contexto Bóveda), día 20 (última llamada).
 */
import { differenceInDays } from "date-fns";
import { config } from "../config";
import { logger } from "../logger";
import {
  getActiveUsersWithWhatsapp,
  getUsersWithPendingCapsules,
  getLastEventsForUsers,
  getRecentEngagementForUsers,
} from "../db/supabase";
import type { EngagementOpportunity, CapsuleProgress, EngagementLog } from "../db/types";

function getInactivityLevel(daysSinceLastEvent: number): number | null {
  if (daysSinceLastEvent >= 20) return 3;
  if (daysSinceLastEvent >= 10) return 2;
  if (daysSinceLastEvent >= config.engine.inactivityDays) return 1;
  return null;
}

function findPendingCapsule(
  progress: CapsuleProgress[],
): CapsuleProgress | undefined {
  // Return the most recently started pending capsule (lowest number = earliest)
  return [...progress]
    .filter((p) => p.status === "viewed" || p.status === "in_progress")
    .sort((a, b) => (a.capsule_number ?? 0) - (b.capsule_number ?? 0))[0];
}

function alreadySentThisLevel(
  logs: EngagementLog[],
  level: number,
  hoursWindow: number,
): boolean {
  const since = new Date(Date.now() - hoursWindow * 60 * 60 * 1000).toISOString();
  return logs.some(
    (e) =>
      e.created_at >= since &&
      (e.metadata as { journey_name?: string; level?: number })?.journey_name === "reactivacion_inactividad" &&
      (e.metadata as { level?: number })?.level === level &&
      e.status === "sent",
  );
}

export async function detectInactiveUsers(): Promise<EngagementOpportunity[]> {
  const opportunities: EngagementOpportunity[] = [];

  const [users, pendingProgress] = await Promise.all([
    getActiveUsersWithWhatsapp(),
    getUsersWithPendingCapsules(),
  ]);

  if (users.length === 0) return opportunities;

  // Group pending capsules by user
  const pendingByUser = new Map<string, CapsuleProgress[]>();
  for (const p of pendingProgress) {
    const existing = pendingByUser.get(p.lead_id) ?? [];
    existing.push(p);
    pendingByUser.set(p.lead_id, existing);
  }

  // Only process users that actually have pending capsules
  const candidateUsers = users.filter((u) => (pendingByUser.get(u.id)?.length ?? 0) > 0);
  if (candidateUsers.length === 0) return opportunities;

  const candidateIds = candidateUsers.map((u) => u.id);

  // Batch: last event per user + recent engagement (max window = 480h)
  const [lastEventsMap, engagementMap] = await Promise.all([
    getLastEventsForUsers(candidateIds),
    getRecentEngagementForUsers(candidateIds, 480),
  ]);

  for (const user of candidateUsers) {
    const lastEvent = lastEventsMap.get(user.id);
    if (!lastEvent) continue;

    const daysSince = differenceInDays(
      new Date(),
      new Date(lastEvent.created_at),
    );
    const level = getInactivityLevel(daysSince);
    if (level === null) continue;

    // Check rate limiting — don't re-send same level
    const hoursWindow = level === 1 ? 120 : level === 2 ? 240 : 480;
    const userLogs = engagementMap.get(user.id) ?? [];
    if (alreadySentThisLevel(userLogs, level, hoursWindow)) continue;

    const userPending = pendingByUser.get(user.id)!;
    const pending = findPendingCapsule(userPending);
    if (!pending) continue;

    const deepLink = `${config.engine.appBaseUrl}/capsulas/${pending.capsule_number}`;

    opportunities.push({
      userId: user.id,
      journeyName: "reactivacion_inactividad",
      profile: user,
      level,
      deepLink,
      context: {
        daysSinceLastEvent: daysSince,
        pendingCapsuleNumber: pending.capsule_number,
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
