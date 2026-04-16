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
    .not("phone", "is", null)
    .eq("whatsapp_opt_in", true);

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
    .eq("org_role", "sponsor")
    .not("phone", "is", null)
    .eq("whatsapp_opt_in", true);

  if (error) {
    logger.error({ error }, "Failed to fetch sponsors");
    return [];
  }
  return (data ?? []) as Profile[];
}

/**
 * Returns true if the user has an active subscription or active program access.
 * Used to skip paid users from "cold lead" journey.
 */
export async function isUserPaid(userId: string): Promise<boolean> {
  const [subRes, accessRes] = await Promise.all([
    getSupabaseClient()
      .from("subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "active"),
    getSupabaseClient()
      .from("user_program_access")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "active"),
  ]);

  return (subRes.count ?? 0) > 0 || (accessRes.count ?? 0) > 0;
}

// ─── READ: Capsules ───

export async function getCapsules(): Promise<Capsule[]> {
  const { data, error } = await getSupabaseClient()
    .from("capsules")
    .select("*")
    .order("number", { ascending: true });

  if (error) {
    logger.error({ error }, "Failed to fetch capsules");
    return [];
  }
  return (data ?? []) as Capsule[];
}

// ─── READ: Capsule Progress ───

/**
 * Returns progress for a user with capsule number resolved via JOIN.
 */
export async function getCapsuleProgressForUser(
  userId: string,
): Promise<CapsuleProgress[]> {
  const { data, error } = await getSupabaseClient()
    .from("capsule_progress")
    .select("*, capsules(number, title, path_id)")
    .eq("lead_id", userId)
    .order("created_at", { ascending: true });

  if (error) {
    logger.error({ error, userId }, "Failed to fetch capsule progress");
    return [];
  }

  return ((data ?? []) as unknown[]).map(transformCapsuleProgressRow);
}

/**
 * Returns all capsule_progress rows with status 'viewed' or 'in_progress'
 * (i.e. started but not completed), with capsule number resolved.
 */
export async function getUsersWithPendingCapsules(): Promise<CapsuleProgress[]> {
  const { data, error } = await getSupabaseClient()
    .from("capsule_progress")
    .select("*, capsules(number, title, path_id)")
    .in("status", ["viewed", "in_progress"]);

  if (error) {
    logger.error({ error }, "Failed to fetch pending capsule progress");
    return [];
  }

  return ((data ?? []) as unknown[]).map(transformCapsuleProgressRow);
}

// ─── READ: Vault (Bóveda / Memoria) ───

export async function getVaultOutputsForUser(
  userId: string,
): Promise<VaultOutput[]> {
  const { data, error } = await getSupabaseClient()
    .from("vault_outputs")
    .select("*")
    .eq("lead_id", userId)
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
    .eq("lead_id", userId)
    .order("last_calculated_at", { ascending: false })
    .limit(1)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null; // no rows
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
    .eq("lead_id", userId)
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
    .eq("lead_id", userId)
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
    .eq("lead_id", userId)
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

// ─── WRITE: Campaign Lead Upsert ───

/**
 * Find or create a minimal profile for a campaign lead.
 * Returns the existing userId if the phone is already in DB,
 * otherwise creates a new profile and returns its id.
 */
export async function upsertCampaignLead(
  phone: string, // digits only, already normalized
  name: string,
): Promise<string> {
  const supabase = getSupabaseClient();

  // Check if profile already exists
  const { data: existing } = await supabase
    .from("profiles")
    .select("id")
    .eq("phone", phone)
    .single();

  if (existing?.id) {
    logger.info({ phone, userId: existing.id }, "Campaign lead: existing profile found");
    return existing.id as string;
  }

  // Create auth user first (profiles.id is FK → auth.users.id)
  const fakeEmail = `campaign-${phone}@campaign.fiacopilot.com`;
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email: fakeEmail,
    email_confirm: true,
    user_metadata: { name, phone, source: "campaign" },
  });

  let userId: string;

  if (authError) {
    // If user already exists (prior failed attempt), look it up by email
    if ((authError as { code?: string }).code === "email_exists") {
      const { data: listData } = await supabase.auth.admin.listUsers({ perPage: 1000 });
      const existingUser = listData?.users.find((u) => u.email === fakeEmail);
      if (!existingUser) {
        logger.error({ phone }, "email_exists but user not found in list");
        throw new Error("upsertCampaignLead: email_exists but could not retrieve user");
      }
      userId = existingUser.id;
      logger.info({ phone, userId }, "Campaign lead: recovered existing auth user");
    } else {
      logger.error({ authError, phone }, "Failed to create auth user for campaign lead");
      throw new Error(`upsertCampaignLead auth failed: ${authError.message}`);
    }
  } else if (!authData.user) {
    throw new Error("upsertCampaignLead: no user returned from createUser");
  } else {
    userId = authData.user.id;
  }

  // The auth trigger auto-creates the profile row — update it with campaign fields
  const { error: profileError } = await supabase
    .from("profiles")
    .update({
      phone,
      name: name || null,
      whatsapp_opt_in: true,
      temperature: "tibio",
    })
    .eq("id", userId);

  if (profileError) {
    logger.error({ profileError, phone }, "Failed to update campaign lead profile");
    throw new Error(`upsertCampaignLead profile failed: ${profileError.message}`);
  }

  logger.info({ phone, userId, name }, "Campaign lead: new profile created");
  return userId;
}

// ─── WRITE: Incoming WhatsApp Messages ───

export async function insertIncomingMessage(
  fromJid: string,
  body: string,
  resolvedUserId: string | null,
  messageId: string | null,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("wa_incoming_messages")
    .insert({
      from_jid: fromJid,
      body: body.slice(0, 2000),
      message_id: messageId,
      resolved_user_id: resolvedUserId,
    });

  if (error) {
    // Table might not exist yet — log but don't crash
    logger.error({ error, fromJid }, "Failed to insert incoming message");
  } else {
    logger.info({ fromJid, resolvedUserId, bodyPreview: body.slice(0, 50) }, "Incoming message saved");
  }
}

// ─── WRITE: Engagement Log ───

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
    { userId: entry.lead_id, journey: entry.metadata.journey_name },
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
    .eq("lead_id", userId)
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
  withinHours?: number,
): Promise<boolean> {
  let query = getSupabaseClient()
    .from("engagement_log")
    .select("*", { count: "exact", head: true })
    .eq("lead_id", userId)
    .contains("metadata", { journey_name: journeyName })
    .eq("status", "sent");

  if (withinHours !== undefined) {
    const since = new Date(Date.now() - withinHours * 60 * 60 * 1000).toISOString();
    query = query.gte("created_at", since);
  }

  const { count, error } = await query;

  if (error) {
    logger.error({ error, userId, journeyName }, "Failed to check journey contact");
    return false;
  }
  return (count ?? 0) > 0;
}

/**
 * Returns the most recent assessment per user as a map userId -> AssessmentSubmission.
 */
export async function getAssessmentsForUsers(
  userIds: string[],
): Promise<Map<string, AssessmentSubmission>> {
  if (userIds.length === 0) return new Map();

  const { data, error } = await getSupabaseClient()
    .from("assessment_submissions")
    .select("*")
    .in("lead_id", userIds)
    .order("created_at", { ascending: false });

  if (error) {
    logger.error({ error }, "Failed to batch-fetch assessments");
    return new Map();
  }

  const result = new Map<string, AssessmentSubmission>();
  for (const row of (data ?? []) as AssessmentSubmission[]) {
    if (!result.has(row.lead_id)) result.set(row.lead_id, row);
  }
  return result;
}

// ─── BATCH queries (used by detectors to avoid N+1) ───

/**
 * Returns the set of user IDs that have an active subscription or program access.
 */
export async function getPaidUserIds(userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();

  const [subRes, accessRes] = await Promise.all([
    getSupabaseClient()
      .from("subscriptions")
      .select("user_id")
      .in("user_id", userIds)
      .eq("status", "active"),
    getSupabaseClient()
      .from("user_program_access")
      .select("user_id")
      .in("user_id", userIds)
      .eq("status", "active"),
  ]);

  const paid = new Set<string>();
  for (const r of (subRes.data ?? []) as { user_id: string }[]) paid.add(r.user_id);
  for (const r of (accessRes.data ?? []) as { user_id: string }[]) paid.add(r.user_id);
  return paid;
}

/**
 * Returns the set of user IDs already contacted for a given journey.
 */
export async function getContactedUserIdsForJourney(
  userIds: string[],
  journeyName: string,
  withinHours?: number,
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();

  let query = getSupabaseClient()
    .from("engagement_log")
    .select("lead_id")
    .in("lead_id", userIds)
    .contains("metadata", { journey_name: journeyName })
    .eq("status", "sent");

  if (withinHours !== undefined) {
    const since = new Date(Date.now() - withinHours * 60 * 60 * 1000).toISOString();
    query = query.gte("created_at", since);
  }

  const { data, error } = await query;
  if (error) {
    logger.error({ error, journeyName }, "Failed to batch-check journey contacts");
    return new Set();
  }
  return new Set((data ?? []).map((r) => (r as { lead_id: string }).lead_id));
}

/**
 * Returns the most recent event per user as a map userId -> UserEvent.
 */
export async function getLastEventsForUsers(
  userIds: string[],
): Promise<Map<string, UserEvent>> {
  if (userIds.length === 0) return new Map();

  const { data, error } = await getSupabaseClient()
    .from("events")
    .select("*")
    .in("lead_id", userIds)
    .order("created_at", { ascending: false });

  if (error) {
    logger.error({ error }, "Failed to batch-fetch last events");
    return new Map();
  }

  const result = new Map<string, UserEvent>();
  for (const row of (data ?? []) as UserEvent[]) {
    if (!result.has(row.lead_id)) result.set(row.lead_id, row);
  }
  return result;
}

/**
 * Returns the most recent lead score per user as a map userId -> LeadScore.
 */
export async function getLeadScoresForUsers(
  userIds: string[],
): Promise<Map<string, LeadScore>> {
  if (userIds.length === 0) return new Map();

  const { data, error } = await getSupabaseClient()
    .from("lead_scores")
    .select("*")
    .in("lead_id", userIds)
    .order("last_calculated_at", { ascending: false });

  if (error) {
    logger.error({ error }, "Failed to batch-fetch lead scores");
    return new Map();
  }

  const result = new Map<string, LeadScore>();
  for (const row of (data ?? []) as LeadScore[]) {
    if (!result.has(row.lead_id)) result.set(row.lead_id, row);
  }
  return result;
}

/**
 * Returns the set of user IDs that have at least one event since the given ISO timestamp.
 */
export async function getUserIdsWithEventsSince(
  userIds: string[],
  since: string,
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();

  const { data, error } = await getSupabaseClient()
    .from("events")
    .select("lead_id")
    .in("lead_id", userIds)
    .gte("created_at", since);

  if (error) {
    logger.error({ error }, "Failed to batch-fetch events since");
    return new Set();
  }
  return new Set((data ?? []).map((r) => (r as { lead_id: string }).lead_id));
}

/**
 * Returns all engagement log entries within the given hours window, grouped by user.
 * Fetches the max window (480h) so callers can filter down in memory.
 */
export async function getRecentEngagementForUsers(
  userIds: string[],
  hours: number,
): Promise<Map<string, EngagementLog[]>> {
  if (userIds.length === 0) return new Map();

  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const { data, error } = await getSupabaseClient()
    .from("engagement_log")
    .select("*")
    .in("lead_id", userIds)
    .gte("created_at", since);

  if (error) {
    logger.error({ error }, "Failed to batch-fetch recent engagement");
    return new Map();
  }

  const result = new Map<string, EngagementLog[]>();
  for (const row of (data ?? []) as EngagementLog[]) {
    const existing = result.get(row.lead_id) ?? [];
    existing.push(row);
    result.set(row.lead_id, existing);
  }
  return result;
}

/**
 * Returns all profiles for the given user IDs as a map userId -> Profile.
 */
export async function getProfilesForUsers(
  userIds: string[],
): Promise<Map<string, Profile>> {
  if (userIds.length === 0) return new Map();

  const { data, error } = await getSupabaseClient()
    .from("profiles")
    .select("*")
    .in("id", userIds);

  if (error) {
    logger.error({ error }, "Failed to batch-fetch profiles");
    return new Map();
  }

  const result = new Map<string, Profile>();
  for (const row of (data ?? []) as Profile[]) {
    result.set(row.id, row);
  }
  return result;
}

// ─── Conversation history (Sofía inbound memory) ───

export async function getConversationHistory(
  userId: string,
  limit = 10,
): Promise<Array<{ role: string; content: string }>> {
  const { data, error } = await getSupabaseClient()
    .from("wa_conversation_history")
    .select("role, content")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    logger.error({ error, userId }, "Failed to fetch conversation history");
    return [];
  }

  // Reverse to chronological order
  return ((data ?? []) as Array<{ role: string; content: string }>).reverse();
}

export async function appendConversationMessages(
  userId: string,
  messages: Array<{ role: string; content: string }>,
): Promise<void> {
  if (messages.length === 0) return;

  const rows = messages.map((m) => ({ user_id: userId, role: m.role, content: m.content }));

  const { error } = await getSupabaseClient()
    .from("wa_conversation_history")
    .insert(rows);

  if (error) {
    logger.error({ error, userId }, "Failed to save conversation messages");
  }
}

/** Shared transform for capsule_progress rows joined with capsules */
function transformCapsuleProgressRow(row: unknown): CapsuleProgress {
  const r = row as Record<string, unknown>;
  const capsule = r["capsules"] as { number: number; title: string | null; path_id: string | null } | null;
  return {
    id: r["id"] as string,
    lead_id: r["lead_id"] as string,
    capsule_id: r["capsule_id"] as string,
    capsule_number: capsule?.number ?? 0,
    capsule_title: capsule?.title ?? null,
    status: r["status"] as CapsuleProgress["status"],
    started_at: r["started_at"] as string | null,
    completed_at: r["completed_at"] as string | null,
    video_watched: r["video_watched"] as boolean,
    path_id: capsule?.path_id ?? null,
  };
}

/**
 * Returns all capsule progress for the given user IDs, grouped by user.
 */
export async function getCapsuleProgressForUsers(
  userIds: string[],
): Promise<Map<string, CapsuleProgress[]>> {
  if (userIds.length === 0) return new Map();

  const { data, error } = await getSupabaseClient()
    .from("capsule_progress")
    .select("*, capsules(number, title, path_id)")
    .in("lead_id", userIds)
    .order("started_at", { ascending: true });

  if (error) {
    logger.error({ error }, "Failed to batch-fetch capsule progress");
    return new Map();
  }

  const result = new Map<string, CapsuleProgress[]>();
  for (const row of (data ?? []) as unknown[]) {
    const progress = transformCapsuleProgressRow(row);
    const existing = result.get(progress.lead_id) ?? [];
    existing.push(progress);
    result.set(progress.lead_id, existing);
  }
  return result;
}
