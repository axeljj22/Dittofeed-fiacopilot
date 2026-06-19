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
  getUserSegment,
  getEventsForUserSince,
  getCapsules,
} from "../db/supabase";
import type { EngagementOpportunity, Profile, Capsule } from "../db/types";

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

/** Internal key for grouping by path; the free Método (path_id NULL) gets a stable key. */
const METODO_KEY = "__metodo__";
const pathKey = (pathId: string | null): string => pathId ?? METODO_KEY;

interface PathEval {
  completedCount: number;
  total: number;
  isFinished: boolean;
  next: Capsule | null;
}

/**
 * Builds the weekly report context.
 *
 * Track selection (per product rule): focus on the enrolled, NON-finished track with the most
 * recent activity; tie-break by most recent enrollment. The Método de 25 pasos is used ONLY for
 * users with no enrolled tracks. Progress + next action are computed from the capsule CATALOG
 * (so a track you're enrolled in but haven't started still counts, and "next" is the next
 * uncompleted capsule in sequence — forward, not an old abandoned one).
 */
async function buildWeeklyContext(profile: Profile): Promise<WeeklyReportContext> {
  const userId = profile.id;
  const weekAgo = weekAgoIso();
  const [segment, capsuleProgress, capsules, events] = await Promise.all([
    getUserSegment(userId),
    getCapsuleProgressForUser(userId),
    getCapsules(),
    getEventsForUserSince(userId, weekAgo),
  ]);

  // ── Per-path aggregates from the user's progress ──
  const completedByPath = new Map<string, Set<number>>();
  const lastActivityByPath = new Map<string, string>();
  const completedThisWeekByPath = new Map<string, Array<{ number: number; title: string | null }>>();
  for (const p of capsuleProgress) {
    const key = pathKey(p.path_id);
    if (p.status === "completed") {
      let done = completedByPath.get(key);
      if (!done) { done = new Set<number>(); completedByPath.set(key, done); }
      done.add(p.capsule_number);
      if (p.completed_at && p.completed_at >= weekAgo) {
        const arr = completedThisWeekByPath.get(key) ?? [];
        arr.push({ number: p.capsule_number, title: p.capsule_title });
        completedThisWeekByPath.set(key, arr);
      }
    }
    const ts = p.completed_at ?? p.started_at;
    if (ts) {
      const prev = lastActivityByPath.get(key);
      if (!prev || ts > prev) lastActivityByPath.set(key, ts);
    }
  }

  // ── Catalog grouped by path (sorted by number) ──
  const catalogByPath = new Map<string, Capsule[]>();
  for (const c of capsules) {
    const key = pathKey(c.path_id ?? null);
    const arr = catalogByPath.get(key) ?? [];
    arr.push(c);
    catalogByPath.set(key, arr);
  }
  for (const arr of catalogByPath.values()) arr.sort((a, b) => a.number - b.number);

  const evalPath = (key: string): PathEval => {
    const catalog = catalogByPath.get(key) ?? [];
    const done = completedByPath.get(key) ?? new Set<number>();
    const completedCount = catalog.filter((c) => done.has(c.number)).length;
    const total = catalog.length;
    return {
      completedCount,
      total,
      isFinished: total > 0 && completedCount >= total,
      next: catalog.find((c) => !done.has(c.number)) ?? null,
    };
  };

  const base = config.engine.appBaseUrl;

  // ── Evaluate enrolled tracks ──
  const tracks = segment.enrolledPrograms.map((ep) => {
    const key = pathKey(ep.pathId);
    return {
      slug: ep.slug,
      name: ep.name,
      enrolledAt: ep.enrolledAt,
      lastActivity: lastActivityByPath.get(key) ?? null,
      key,
      ...evalPath(key),
    };
  });

  // Focus rule: the NEWEST program the user enrolled in (= "lo último que estoy cursando"),
  // tie-broken by most recent activity. Only non-finished tracks are candidates (filtered below).
  const byRelevance = (a: typeof tracks[number], b: typeof tracks[number]) => {
    const ea = a.enrolledAt ?? "", eb = b.enrolledAt ?? "";
    if (ea !== eb) return eb.localeCompare(ea); // most recent enrollment first
    return (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""); // tie-break: recent activity
  };

  const focus = tracks.filter((t) => !t.isFinished).sort(byRelevance)[0] ?? null;

  if (focus) {
    const next = focus.next;
    return {
      isTrack: true,
      programName: focus.name,
      programSlug: focus.slug,
      pathProgress: `${focus.completedCount}/${focus.total}`,
      completedThisWeek: completedThisWeekByPath.get(focus.key) ?? [],
      weekActivityCount: events.length,
      nextCapsuleNumber: next?.number ?? null,
      nextCapsuleTitle: next?.title ?? null,
      nextMiniAction: next?.mini_action ?? null,
      // Front route: track capsules live at /pasos?path={slug} (the program panel). There is NO
      // /capsulas/{n} route, and capsule numbers repeat across tracks, so we link to the panel.
      deepLink: `${base}/pasos?path=${focus.slug}`,
    };
  }

  // Enrolled but ALL tracks finished → congratulate on the most recent one, point to dashboard.
  if (tracks.length > 0) {
    const recent = tracks.slice().sort(byRelevance)[0]!;
    return {
      isTrack: true,
      programName: recent.name,
      programSlug: recent.slug,
      pathProgress: `${recent.completedCount}/${recent.total}`,
      completedThisWeek: completedThisWeekByPath.get(recent.key) ?? [],
      weekActivityCount: events.length,
      nextCapsuleNumber: null,
      nextCapsuleTitle: null,
      nextMiniAction: null,
      deepLink: `${base}/dashboard`,
    };
  }

  // No enrolled tracks (premium) → Método de 25 pasos (path_id NULL).
  const metodo = evalPath(METODO_KEY);
  return {
    isTrack: false,
    programName: "Método FIA",
    programSlug: null,
    pathProgress: `${metodo.completedCount}/${metodo.total}`,
    completedThisWeek: completedThisWeekByPath.get(METODO_KEY) ?? [],
    weekActivityCount: events.length,
    nextCapsuleNumber: metodo.next?.number ?? null,
    nextCapsuleTitle: metodo.next?.title ?? null,
    nextMiniAction: metodo.next?.mini_action ?? null,
    // Front route: the 25-pasos method lives at /pasos/{number} (numbers 1..25 are unique).
    deepLink: metodo.next ? `${base}/pasos/${metodo.next.number}` : `${base}/pasos`,
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
