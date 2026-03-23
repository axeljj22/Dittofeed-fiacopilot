/**
 * Journey 5 — Resumen semanal para el Sponsor (Plan Pyme)
 *
 * Genera reporte de avance del equipo para usuarios con rol 'sponsor'.
 * Se ejecuta los lunes a las 9 AM.
 */
import { subDays } from "date-fns";
import { config } from "../config";
import { logger } from "../logger";
import {
  getSupabaseClient,
  getSponsors,
  getActiveUsersWithWhatsapp,
  hasBeenContactedForJourney,
} from "../db/supabase";
import type { EngagementOpportunity, Profile } from "../db/types";

interface TeamMemberProgress {
  name: string | null;
  capsulesCompleted: number;
  capsulesInProgress: number;
  lastActivity: string | null;
  isBlocked: boolean;
}

async function getTeamProgress(
  teamMembers: Profile[],
): Promise<TeamMemberProgress[]> {
  const weekAgo = subDays(new Date(), 7).toISOString();
  const memberIds = teamMembers.map((m) => m.id);

  // Batch queries — fetch all data in 2 calls instead of 2*N
  const [allProgressRes, allEventsRes] = await Promise.all([
    getSupabaseClient()
      .from("capsule_progress")
      .select("*")
      .in("lead_id", memberIds),
    getSupabaseClient()
      .from("events")
      .select("lead_id, created_at")
      .in("lead_id", memberIds)
      .gte("created_at", weekAgo)
      .order("created_at", { ascending: false }),
  ]);

  const progressByMember = new Map<string, typeof allProgressRes.data>();
  for (const p of allProgressRes.data ?? []) {
    const arr = progressByMember.get(p.lead_id) ?? [];
    arr.push(p);
    progressByMember.set(p.lead_id, arr);
  }

  const eventsByMember = new Map<string, string>(); // userId → latest created_at
  for (const e of allEventsRes.data ?? []) {
    if (!eventsByMember.has(e.lead_id)) {
      eventsByMember.set(e.lead_id, e.created_at);
    }
  }
  const memberIdsWithEvents = new Set(eventsByMember.keys());

  return teamMembers.map((member) => {
    const memberProgress = progressByMember.get(member.id) ?? [];
    const completed = memberProgress.filter((p) => p.status === "completed").length;
    const inProgress = memberProgress.filter(
      (p) => p.status === "viewed" || p.status === "in_progress",
    ).length;
    const hasRecentActivity = memberIdsWithEvents.has(member.id);

    return {
      name: member.name,
      capsulesCompleted: completed,
      capsulesInProgress: inProgress,
      lastActivity: eventsByMember.get(member.id) ?? null,
      isBlocked: inProgress > 0 && !hasRecentActivity,
    };
  });
}

export async function detectSponsorReports(): Promise<
  EngagementOpportunity[]
> {
  const opportunities: EngagementOpportunity[] = [];

  const [sponsors, allUsers] = await Promise.all([
    getSponsors(),
    getActiveUsersWithWhatsapp(),
  ]);

  for (const sponsor of sponsors) {
    if (!sponsor.phone || !sponsor.whatsapp_opt_in) continue;

    // Rate limiting — only send once per week
    const alreadySentThisWeek = await hasBeenContactedForJourney(
      sponsor.id,
      "resumen_semanal_sponsor",
      168, // 7 days in hours
    );
    if (alreadySentThisWeek) continue;

    // Get team members (same empresa, not the sponsor) — reuse pre-fetched list
    const teamMembers = allUsers.filter(
      (u) => u.company_name === sponsor.company_name && u.id !== sponsor.id,
    );

    if (teamMembers.length === 0) continue;

    const teamProgress = await getTeamProgress(teamMembers);
    const deepLink = `${config.engine.appBaseUrl}/admin/equipo`;

    opportunities.push({
      userId: sponsor.id,
      journeyName: "resumen_semanal_sponsor",
      profile: sponsor,
      deepLink,
      context: {
        teamSize: teamMembers.length,
        teamProgress,
        totalCompletedThisWeek: teamProgress.reduce(
          (sum, m) => sum + m.capsulesCompleted,
          0,
        ),
        blockedMembers: teamProgress
          .filter((m) => m.isBlocked)
          .map((m) => m.name),
      },
    });
  }

  logger.info(
    { count: opportunities.length },
    "Sponsor report detector completed",
  );
  return opportunities;
}
