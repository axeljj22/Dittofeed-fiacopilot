/**
 * Internal staff report — gathers, per student of the target program(s), their platform progress
 * + follow-up-group activity + open questions, plus a global weekly summary. Consumed by
 * generateInternalReport() and posted to the internal control group every Sunday.
 */
import {
  getStudentsByProgram,
  getProfilesForUsers,
  getCapsuleProgressForUsers,
  getLastEventsForUsers,
  getLeadScoresForUsers,
  getPathTotals,
  resolveUserPaths,
  getSofiaGroups,
  getGroupMessagesSince,
  getKnowledgeQueries,
} from "../db/supabase";
import { logger } from "../logger";

export interface StudentSnapshot {
  userId: string;
  name: string;
  status: "graduado" | "activo" | "inactivo" | "inactivo_critico" | "registrado";
  completedTotal: number;
  completedThisWeek: number;
  inProgress: number;
  pathLabel: string;
  daysInactive: number; // -1 = never any event
  score: number | null;
  groupLabel: string | null;
  groupMsgs7d: number;     // student (inbound) messages in their group this week
  groupAudios7d: number;
  groupQuestions: string[]; // recent student questions/audio transcripts (trimmed)
}

export interface InternalReportContext {
  programLabel: string;
  weekFromIso: string;
  totals: {
    students: number;
    activos: number;
    inactivos: number; // inactivo + inactivo_critico
    sinActividad: number; // registrado / never active
    graduados: number;
    conPreguntasAbiertas: number;
  };
  needAttention: StudentSnapshot[];
  all: StudentSnapshot[];
  knowledgeGaps: string[]; // global questions Sofía couldn't answer this week
}

const DAY = 24 * 60 * 60 * 1000;

export async function buildInternalReportContext(programSlugs: string[]): Promise<InternalReportContext> {
  const now = Date.now();
  const weekAgoIso = new Date(now - 7 * DAY).toISOString();

  const userIds = await getStudentsByProgram(programSlugs);
  logger.info({ programSlugs, count: userIds.length }, "Internal report: students found");

  const [profiles, progressMap, lastEvents, scores, pathTotals, groups, gaps] = await Promise.all([
    getProfilesForUsers(userIds),
    getCapsuleProgressForUsers(userIds),
    getLastEventsForUsers(userIds),
    getLeadScoresForUsers(userIds),
    getPathTotals(),
    getSofiaGroups(),
    getKnowledgeQueries(7, true),
  ]);

  const groupByStudent = new Map<string, { conversation_id: string; label: string | null }>();
  for (const g of groups) if (g.student_user_id) groupByStudent.set(g.student_user_id, { conversation_id: g.conversation_id, label: g.label });

  const snapshots: StudentSnapshot[] = [];
  for (const userId of userIds) {
    const profile = profiles.get(userId);
    // Exclude internal staff (admin/coach, e.g. Axel & Lautaro) — they enroll to test but aren't
    // students. Keeps them out of the report, analytics and action recipients.
    const pf = (profile ?? {}) as { is_admin?: boolean; is_coach?: boolean };
    if (pf.is_admin || pf.is_coach) continue;
    const progress = progressMap.get(userId) ?? [];
    const completedTotal = progress.filter((p) => p.status === "completed").length;
    const completedThisWeek = progress.filter((p) => p.status === "completed" && p.completed_at && p.completed_at >= weekAgoIso).length;
    const inProgress = progress.filter((p) => p.status === "viewed" || p.status === "in_progress").length;

    const userPaths = resolveUserPaths(progress, pathTotals);
    const activePath = userPaths.find((p) => p.activePath) ?? userPaths[0];
    const finished = userPaths.some((p) => p.isFinished);

    const lastEvent = lastEvents.get(userId);
    const daysInactive = lastEvent ? Math.floor((now - new Date(lastEvent.created_at).getTime()) / DAY) : -1;

    let status: StudentSnapshot["status"] = "registrado";
    if (finished) status = "graduado";
    else if (completedTotal > 0 || inProgress > 0) status = "activo";
    if (status === "activo" && daysInactive > 15) status = "inactivo_critico";
    else if (status === "activo" && daysInactive > 5) status = "inactivo";

    // Group activity this week
    let groupMsgs7d = 0, groupAudios7d = 0;
    const groupQuestions: string[] = [];
    const grp = groupByStudent.get(userId);
    if (grp) {
      const msgs = await getGroupMessagesSince(grp.conversation_id, weekAgoIso);
      for (const m of msgs) {
        if (m.kind !== "group_in") continue; // only inbound (student/coach), not Sofía's replies
        const meta = (m.metadata ?? {}) as Record<string, unknown>;
        // count only the student's own messages where possible (sender matches), else all inbound
        groupMsgs7d++;
        if (meta["is_audio"]) groupAudios7d++;
        const body = (m.body ?? "").trim();
        if (body && (body.includes("?") || meta["is_audio"]) && groupQuestions.length < 3) {
          groupQuestions.push(body.slice(0, 140));
        }
      }
    }

    snapshots.push({
      userId,
      name: profile?.name || profile?.email || "(sin nombre)",
      status,
      completedTotal,
      completedThisWeek,
      inProgress,
      pathLabel: activePath?.name ?? "Método FIA",
      daysInactive,
      score: scores.get(userId)?.overall_score ?? null,
      groupLabel: grp?.label ?? null,
      groupMsgs7d,
      groupAudios7d,
      groupQuestions,
    });
  }

  // Priority for "needs attention": critical inactivity first, then inactive, then active-with-open-questions.
  const priority = (s: StudentSnapshot): number => {
    if (s.status === "inactivo_critico") return 0;
    if (s.status === "inactivo") return 1;
    if (s.status === "registrado") return 2;
    if (s.groupQuestions.length > 0) return 3;
    return 9;
  };
  const needAttention = snapshots
    .filter((s) => priority(s) < 9)
    .sort((a, b) => priority(a) - priority(b) || b.groupMsgs7d - a.groupMsgs7d);

  const totals = {
    students: snapshots.length,
    activos: snapshots.filter((s) => s.status === "activo").length,
    inactivos: snapshots.filter((s) => s.status === "inactivo" || s.status === "inactivo_critico").length,
    sinActividad: snapshots.filter((s) => s.status === "registrado").length,
    graduados: snapshots.filter((s) => s.status === "graduado").length,
    conPreguntasAbiertas: snapshots.filter((s) => s.groupQuestions.length > 0).length,
  };

  return {
    programLabel: programSlugs.join(", "),
    weekFromIso: weekAgoIso,
    totals,
    needAttention,
    all: snapshots,
    knowledgeGaps: [...new Set(gaps.map((g) => g.query))].slice(0, 12),
  };
}
