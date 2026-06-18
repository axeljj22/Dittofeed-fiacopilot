/**
 * Journey 1 — Reactivación por inactividad
 *
 * Detecta usuarios sin actividad en X días con cápsulas pendientes.
 * Tres niveles configurables por segmento (paid vs free) via engine_config.
 */
import { differenceInDays } from "date-fns";
import { config } from "../config";
import { logger } from "../logger";
import {
  getActiveUsersWithWhatsapp,
  getUsersWithPendingCapsules,
  getLastEventsForUsers,
  getRecentEngagementForUsers,
  getPathTotals,
  resolveUserPaths,
} from "../db/supabase";
import { getSegmentFollowupConfig } from "../config/engineConfigCache";
import type { EngagementOpportunity, CapsuleProgress, EngagementLog } from "../db/types";

function getInactivityLevel(daysSinceLastEvent: number, levels: number[]): number | null {
  const sorted = [...levels].sort((a, b) => b - a); // descending: highest threshold first
  for (let i = 0; i < sorted.length; i++) {
    if (daysSinceLastEvent >= (sorted[i] ?? 0)) return sorted.length - i; // level = position from lowest
  }
  return null;
}

function findPendingCapsuleInActivePath(
  progress: CapsuleProgress[],
  pathTotals: Map<string, { name: string; total: number; isPaid: boolean; programSlug: string | null }>,
): CapsuleProgress | undefined {
  // First try pending capsule in the active path (paid-first preference)
  const userPaths = resolveUserPaths(progress, pathTotals);
  const activePath = userPaths.find((p) => p.activePath) ?? userPaths[0];

  if (activePath) {
    // Find the progress entry matching the next capsule in the active path
    const next = progress.find(
      (p) => p.capsule_number === activePath.nextCapsuleNumber && p.path_id === activePath.pathId,
    );
    if (next) return next;
    // Fallback: any pending in active path
    const inActivePath = progress.filter((p) => p.path_id === activePath.pathId);
    const pendingInPath = inActivePath
      .filter((p) => p.status === "viewed" || p.status === "in_progress")
      .sort((a, b) => (a.capsule_number ?? 0) - (b.capsule_number ?? 0))[0];
    if (pendingInPath) return pendingInPath;
  }

  // Final fallback: any pending globally
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

  const [users, pendingProgress, followupConfig, pathTotals] = await Promise.all([
    getActiveUsersWithWhatsapp(),
    getUsersWithPendingCapsules(),
    getSegmentFollowupConfig(),
    getPathTotals(),
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

    const userPending = pendingByUser.get(user.id)!;
    const userPaths = resolveUserPaths(userPending, pathTotals);
    const isPaid = userPaths.some((p) => p.isPaid);
    const cadence = isPaid ? followupConfig.paid : followupConfig.free;

    const level = getInactivityLevel(daysSince, cadence.levels);
    if (level === null) continue;

    // Check rate limiting — don't re-send same level (window scales with level index)
    const levelIdx = level - 1;
    const nextLevelDays = cadence.levels[levelIdx + 1] ?? cadence.levels[levelIdx] ?? cadence.inactivityDays;
    const hoursWindow = nextLevelDays * 24;
    const userLogs = engagementMap.get(user.id) ?? [];
    if (alreadySentThisLevel(userLogs, level, hoursWindow)) continue;

    const pending = findPendingCapsuleInActivePath(userPending, pathTotals);
    if (!pending) continue;

    const activePath = userPaths.find((p) => p.activePath) ?? userPaths[0];
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
        nextCapsuleTitle: pending.capsule_title ?? null,
        programName: activePath?.name ?? null,
        pathProgress: activePath ? `${activePath.completed}/${activePath.total}` : null,
        isPaidProgram: isPaid,
      },
    });
  }

  logger.info(
    { count: opportunities.length },
    "Inactivity detector completed",
  );
  return opportunities;
}
