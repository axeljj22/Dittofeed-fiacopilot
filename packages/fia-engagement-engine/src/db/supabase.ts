import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config";
import { logger } from "../logger";
import type {
  Profile,
  Capsule,
  CapsuleProgress,
  VaultOutput,
  LeadScore,
  UserEvent,
  AssessmentSubmission,
  EngagementLogInsert,
  EngagementLog,
} from "./types";

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!client) {
    client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false },
    });
    logger.info("Supabase client initialized");
  }
  return client;
}

// ─── READ: Profiles ───

export async function getProfileWithWhatsapp(
  userId: string,
): Promise<Profile | null> {
  const { data, error } = await getSupabaseClient()
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();

  if (error) {
    logger.error({ error, userId }, "Failed to fetch profile");
    return null;
  }
  return data as Profile;
}

export async function getActiveUsersWithWhatsapp(): Promise<Profile[]> {
  const { data, error } = await getSupabaseClient()
    .from("profiles")
    .select("*")
    .not("whatsapp", "is", null)
    .eq("wp_opted_out", false);

  if (error) {
    logger.error({ error }, "Failed to fetch active users with whatsapp");
    return [];
  }
  return (data ?? []) as Profile[];
}

export async function getSponsors(): Promise<Profile[]> {
  const { data, error } = await getSupabaseClient()
    .from("profiles")
    .select("*")
    .eq("rol", "sponsor");

  if (error) {
    logger.error({ error }, "Failed to fetch sponsors");
    return [];
  }
  return (data ?? []) as Profile[];
}

// ─── READ: Capsules ───

export async function getCapsules(): Promise<Capsule[]> {
  const { data, error } = await getSupabaseClient()
    .from("capsules")
    .select("*")
    .order("numero", { ascending: true });

  if (error) {
    logger.error({ error }, "Failed to fetch capsules");
    return [];
  }
  return (data ?? []) as Capsule[];
}

// ─── READ: Capsule Progress ───

export async function getCapsuleProgressForUser(
  userId: string,
): Promise<CapsuleProgress[]> {
  const { data, error } = await getSupabaseClient()
    .from("capsule_progress")
    .select("*")
    .eq("user_id", userId)
    .order("capsule_numero", { ascending: true });

  if (error) {
    logger.error({ error, userId }, "Failed to fetch capsule progress");
    return [];
  }
  return (data ?? []) as CapsuleProgress[];
}

export async function getUsersWithPendingCapsules(): Promise<
  CapsuleProgress[]
> {
  const { data, error } = await getSupabaseClient()
    .from("capsule_progress")
    .select("*")
    .in("status", ["started", "in_progress"]);

  if (error) {
    logger.error({ error }, "Failed to fetch pending capsule progress");
    return [];
  }
  return (data ?? []) as CapsuleProgress[];
}

// ─── READ: Vault (Bóveda) ───

export async function getVaultOutputsForUser(
  userId: string,
): Promise<VaultOutput[]> {
  const { data, error } = await getSupabaseClient()
    .from("vault_outputs")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    logger.error({ error, userId }, "Failed to fetch vault outputs");
    return [];
  }
  return (data ?? []) as VaultOutput[];
}

// ─── READ: Lead Scores ───

export async function getLeadScoreForUser(
  userId: string,
): Promise<LeadScore | null> {
  const { data, error } = await getSupabaseClient()
    .from("lead_scores")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error) {
    logger.error({ error, userId }, "Failed to fetch lead score");
    return null;
  }
  return data as LeadScore;
}

// ─── READ: Events ───

export async function getLastEventForUser(
  userId: string,
): Promise<UserEvent | null> {
  const { data, error } = await getSupabaseClient()
    .from("events")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null; // no rows
    logger.error({ error, userId }, "Failed to fetch last event");
    return null;
  }
  return data as UserEvent;
}

export async function getEventsForUserSince(
  userId: string,
  since: string,
): Promise<UserEvent[]> {
  const { data, error } = await getSupabaseClient()
    .from("events")
    .select("*")
    .eq("user_id", userId)
    .gte("created_at", since)
    .order("created_at", { ascending: false });

  if (error) {
    logger.error({ error, userId, since }, "Failed to fetch events since");
    return [];
  }
  return (data ?? []) as UserEvent[];
}

export async function getRecentEventsByType(
  eventType: string,
  sinceMinutes: number,
): Promise<UserEvent[]> {
  const since = new Date(
    Date.now() - sinceMinutes * 60 * 1000,
  ).toISOString();
  const { data, error } = await getSupabaseClient()
    .from("events")
    .select("*")
    .eq("event_type", eventType)
    .gte("created_at", since);

  if (error) {
    logger.error(
      { error, eventType, sinceMinutes },
      "Failed to fetch recent events",
    );
    return [];
  }
  return (data ?? []) as UserEvent[];
}

// ─── READ: Assessment Submissions ───

export async function getAssessmentForUser(
  userId: string,
): Promise<AssessmentSubmission | null> {
  const { data, error } = await getSupabaseClient()
    .from("assessment_submissions")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null;
    logger.error({ error, userId }, "Failed to fetch assessment");
    return null;
  }
  return data as AssessmentSubmission;
}

// ─── WRITE: Engagement Log (only writable table) ───

export async function insertEngagementLog(
  entry: EngagementLogInsert,
): Promise<EngagementLog | null> {
  const { data, error } = await getSupabaseClient()
    .from("engagement_log")
    .insert(entry)
    .select()
    .single();

  if (error) {
    logger.error({ error, entry }, "Failed to insert engagement log");
    return null;
  }
  logger.info(
    { userId: entry.user_id, journey: entry.journey_name },
    "Engagement log recorded",
  );
  return data as EngagementLog;
}

// ─── READ: Engagement Log (for dedup / rate limiting) ───

export async function getRecentEngagementForUser(
  userId: string,
  hours: number = 24,
): Promise<EngagementLog[]> {
  const since = new Date(
    Date.now() - hours * 60 * 60 * 1000,
  ).toISOString();
  const { data, error } = await getSupabaseClient()
    .from("engagement_log")
    .select("*")
    .eq("user_id", userId)
    .gte("created_at", since);

  if (error) {
    logger.error({ error, userId }, "Failed to fetch recent engagement");
    return [];
  }
  return (data ?? []) as EngagementLog[];
}

export async function hasBeenContactedForJourney(
  userId: string,
  journeyName: string,
): Promise<boolean> {
  const { count, error } = await getSupabaseClient()
    .from("engagement_log")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("journey_name", journeyName)
    .eq("status", "sent");

  if (error) {
    logger.error({ error, userId, journeyName }, "Failed to check journey contact");
    return false;
  }
  return (count ?? 0) > 0;
}
