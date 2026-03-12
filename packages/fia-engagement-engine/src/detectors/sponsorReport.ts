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
  getSponsors,
  getActiveUsersWithWhatsapp,
  getCapsuleProgressForUser,
  getEventsForUserSince,
} from "../db/supabase";
import type { EngagementOpportunity, Profile } from "../db/types";

interface TeamMemberProgress {
  nombre: string;
  capsulesCompleted: number;
  capsulesInProgress: number;
  lastActivity: string | null;
  isBlocked: boolean;
}

async function getTeamProgress(
  teamMembers: Profile[],
): Promise<TeamMemberProgress[]> {
  const weekAgo = subDays(new Date(), 7).toISOString();
  const progress: TeamMemberProgress[] = [];

  for (const member of teamMembers) {
    const capsuleProgress = await getCapsuleProgressForUser(member.id);
    const recentEvents = await getEventsForUserSince(member.id, weekAgo);

    const completed = capsuleProgress.filter(
      (p) => p.status === "completed",
    ).length;
    const inProgress = capsuleProgress.filter(
      (p) => p.status === "started" || p.status === "in_progress",
    ).length;

    progress.push({
      nombre: member.nombre,
      capsulesCompleted: completed,
      capsulesInProgress: inProgress,
      lastActivity:
        recentEvents.length > 0 ? recentEvents[0].created_at : null,
      isBlocked: inProgress > 0 && recentEvents.length === 0,
    });
  }

  return progress;
}

export async function detectSponsorReports(): Promise<
  EngagementOpportunity[]
> {
  const opportunities: EngagementOpportunity[] = [];

  const sponsors = await getSponsors();

  for (const sponsor of sponsors) {
    if (!sponsor.whatsapp || sponsor.wp_opted_out) continue;

    // Get team members (same empresa, not the sponsor)
    const allUsers = await getActiveUsersWithWhatsapp();
    const teamMembers = allUsers.filter(
      (u) => u.empresa === sponsor.empresa && u.id !== sponsor.id,
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
          .map((m) => m.nombre),
      },
    });
  }

  logger.info(
    { count: opportunities.length },
    "Sponsor report detector completed",
  );
  return opportunities;
}
