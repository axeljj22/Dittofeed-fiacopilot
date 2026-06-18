/**
 * Weekly report detector — the ONLY journey.
 *
 * For every user with Sofía active (whatsapp_opt_in + phone + sofia_activated_at),
 * builds a personalized weekly report opportunity:
 *  - recap of what they did this week (capsules/steps completed + activity)
 *  - the next pending action in their active track (or the Método de 25 pasos for premium)
 *
 * The heavy formatting + knowledge injection happens in messageGenerator.buildWeeklyReportContext;
 * this detector resolves the per-user facts (active path, recap, next action, deep link).
 */
import { config } from "../config";
import { logger } from "../logger";
import {
  getSofiaActiveUsers,
  getCapsuleProgressForUser,
  getPathTotals,
  resolveUserPaths,
  getUserSegment,
  getEventsForUserSince,
  getCapsules,
} from "../db/supabase";
import type { EngagementOpportunity, Profile } from "../db/types";

export interface WeeklyReportContext {
  isTrack: boolean; // true = formative track, false = Método de 25 pasos (premium)
  programName: string;
  programSlug: string | null;
  pathProgress: string; // "X/N"
  completedThisWeek: Array<{ number: number; title: string | null }>;
  weekActivityCount: number;
  nextCapsuleNumber: number | null;
  nextCapsuleTitle: string | null;
  nextMiniAction: string | null;
  deepLink: string;
  [key: string]: unknown;
}

function weekAgoIso(): string {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
}

async function buildWeeklyContext(profile: Profile): Promise<WeeklyReportContext> {
  const userId = profile.id;
  const [segment, capsuleProgress, pathTotals, capsules, events] = await Promise.all([
    getUserSegment(userId),
    getCapsuleProgressForUser(userId),
    getPathTotals(),
    getCapsules(),
    getEventsForUserSince(userId, weekAgoIso()),
  ]);

  const userPaths = resolveUserPaths(capsuleProgress, pathTotals);
  // Prefer the enrolled formative track; else the active path (Método de 25 pasos).
  const trackSlugs = new Set(segment.enrolledPrograms.map((p) => p.slug));
  const trackPath =
    userPaths.find((p) => p.programSlug && trackSlugs.has(p.programSlug)) ??
    userPaths.find((p) => p.activePath) ??
    userPaths[0] ??
    null;

  const isTrack = Boolean(trackPath?.programSlug && trackSlugs.has(trackPath.programSlug));
  const programName = trackPath?.name ?? "Método FIA";
  const programSlug = trackPath?.programSlug ?? null;
  // resolveUserPaths groups the free method (path_id NULL) under the "__core__" key.
  // Normalize back to NULL so we match capsule_progress / capsules rows correctly.
  const targetPathId = !trackPath || trackPath.pathId === "__core__" ? null : trackPath.pathId;
  const samePath = (rowPathId: string | null) =>
    targetPathId === null ? rowPathId == null : rowPathId === targetPathId;

  // Capsules completed in the last 7 days within the relevant path
  const weekAgo = weekAgoIso();
  const completedThisWeek = capsuleProgress
    .filter(
      (p) =>
        p.status === "completed" &&
        p.completed_at != null &&
        p.completed_at >= weekAgo &&
        samePath(p.path_id),
    )
    .map((p) => ({ number: p.capsule_number, title: p.capsule_title }));

  const nextCapsuleNumber = trackPath?.nextCapsuleNumber ?? null;
  const nextCapsuleTitle = trackPath?.nextCapsuleTitle ?? null;
  // Match the next capsule by number AND path so the mini_action is the right one
  // (capsule numbers can repeat across paths).
  const nextCapsule =
    nextCapsuleNumber != null
      ? capsules.find((c) => c.number === nextCapsuleNumber && samePath(c.path_id ?? null)) ?? null
      : null;
  const nextMiniAction = nextCapsule?.mini_action ?? null;

  // Deep link: next capsule for a track, /pasos for the free method, dashboard if finished.
  const base = config.engine.appBaseUrl;
  let deepLink: string;
  if (nextCapsuleNumber == null) {
    deepLink = `${base}/dashboard`;
  } else if (isTrack) {
    deepLink = `${base}/capsulas/${nextCapsuleNumber}`;
  } else {
    deepLink = `${base}/pasos`;
  }

  return {
    isTrack,
    programName,
    programSlug,
    pathProgress: trackPath ? `${trackPath.completed}/${trackPath.total}` : "0/0",
    completedThisWeek,
    weekActivityCount: events.length,
    nextCapsuleNumber,
    nextCapsuleTitle,
    nextMiniAction,
    deepLink,
  };
}

/** Builds a single weekly-report opportunity for one user (used by the detector + test endpoint). */
export async function buildWeeklyReportOpportunity(profile: Profile): Promise<EngagementOpportunity> {
  const context = await buildWeeklyContext(profile);
  return {
    userId: profile.id,
    journeyName: "reporte_semanal",
    profile,
    context,
    deepLink: context.deepLink,
  };
}

export async function detectWeeklyReportRecipients(): Promise<EngagementOpportunity[]> {
  const users = await getSofiaActiveUsers();
  logger.info({ count: users.length }, "Weekly report: Sofía-active recipients found");

  const opportunities: EngagementOpportunity[] = [];
  for (const profile of users) {
    try {
      opportunities.push(await buildWeeklyReportOpportunity(profile));
    } catch (error) {
      logger.error({ error, userId: profile.id }, "Failed to build weekly report context — skipping user");
    }
  }
  return opportunities;
}
