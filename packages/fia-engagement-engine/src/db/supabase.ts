import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config";
import { logger } from "../logger";
import type {
  Profile,
  Capsule,
  CapsuleProgress,
  LearningPath,
  UserPathStatus,
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

// ─── READ: Learning Paths ───

let _pathsCache: LearningPath[] | null = null;
let _pathsCacheExpiry = 0;

/**
 * Returns all active learning paths ordered by display_order.
 * Cached for 1h. Falls back to a program_slug_path_map stored in engine_config
 * when the DB columns program_slug/is_paid are not yet migrated (zero-downtime).
 */
export async function getLearningPaths(): Promise<LearningPath[]> {
  if (_pathsCache && Date.now() < _pathsCacheExpiry) return _pathsCache;

  try {
    const { data, error } = await getSupabaseClient()
      .from("learning_paths")
      .select("id, name, program_slug, is_paid, display_order, is_active")
      .eq("is_active", true)
      .order("display_order", { ascending: true });

    if (!error && data && data.length > 0) {
      // Check if program_slug column exists (migrated) by inspecting first row
      const firstRow = data[0] as Record<string, unknown>;
      if ("program_slug" in firstRow) {
        _pathsCache = (data as LearningPath[]);
        _pathsCacheExpiry = Date.now() + 60 * 60 * 1000;
        return _pathsCache;
      }
    }
  } catch {
    // Columns may not exist yet — fall through to fallback
  }

  // Fallback: read from engine_config key "program_slug_path_map"
  // This allows path resolution before the DB migration is applied.
  _pathsCache = await _buildPathsFromFallbackConfig();
  _pathsCacheExpiry = Date.now() + 5 * 60 * 1000; // shorter TTL for fallback
  return _pathsCache;
}

async function _buildPathsFromFallbackConfig(): Promise<LearningPath[]> {
  try {
    const { data } = await getSupabaseClient()
      .from("engine_config")
      .select("value")
      .eq("key", "program_slug_path_map")
      .single();

    if (data?.value) {
      const map = JSON.parse(data.value) as Record<string, { slug: string; isPaid: boolean; name?: string; displayOrder?: number }>;
      return Object.entries(map).map(([pathId, info], idx) => ({
        id: pathId,
        name: info.name ?? info.slug,
        program_slug: info.slug,
        is_paid: info.isPaid,
        display_order: info.displayOrder ?? idx + 2,
        is_active: true,
      }));
    }
  } catch {
    logger.warn("Could not load program_slug_path_map from engine_config");
  }
  return [];
}

/** Invalidates the in-memory paths cache (call after config changes). */
export function invalidatePathsCache(): void {
  _pathsCache = null;
  _pathsCacheExpiry = 0;
}

/**
 * Builds a map from path_id → { name, total, isPaid, programSlug }
 * by joining all capsules with the paths list.
 */
export async function getPathTotals(): Promise<Map<string, { name: string; total: number; isPaid: boolean; programSlug: string | null }>> {
  const [capsules, paths] = await Promise.all([getCapsules(), getLearningPaths()]);

  const pathMap = new Map(paths.map((p) => [p.id, p]));
  const totals = new Map<string, { name: string; total: number; isPaid: boolean; programSlug: string | null }>();

  for (const capsule of capsules) {
    const pid = capsule.path_id ?? "__core__";
    const existing = totals.get(pid);
    if (existing) {
      existing.total++;
    } else {
      const path = pathMap.get(pid);
      totals.set(pid, {
        name: path?.name ?? "Método FIA",
        total: 1,
        isPaid: path?.is_paid ?? false,
        programSlug: path?.program_slug ?? null,
      });
    }
  }
  return totals;
}

/**
 * Resolves the status of each learning path for a given user's capsule progress.
 * Returns one entry per path that the user has any progress on, plus a flag
 * indicating which path is the "active" one (most recent engagement, preferring paid).
 */
export function resolveUserPaths(
  capsuleProgress: CapsuleProgress[],
  pathTotals: Map<string, { name: string; total: number; isPaid: boolean; programSlug: string | null }>,
): UserPathStatus[] {
  // Group progress by path_id
  const byPath = new Map<string, CapsuleProgress[]>();
  for (const p of capsuleProgress) {
    const pid = p.path_id ?? "__core__";
    const arr = byPath.get(pid) ?? [];
    arr.push(p);
    byPath.set(pid, arr);
  }

  if (byPath.size === 0) return [];

  const results: (UserPathStatus & { lastActivity: string | null })[] = [];

  for (const [pid, progress] of byPath) {
    const info = pathTotals.get(pid);
    const completed = progress.filter((p) => p.status === "completed").length;
    const total = info?.total ?? progress.length;

    // Next capsule within THIS path: lowest capsule number not yet completed
    const completedNumbers = new Set(
      progress.filter((p) => p.status === "completed").map((p) => p.capsule_number),
    );
    const pending = progress
      .filter((p) => p.status !== "completed" && p.capsule_number > 0)
      .sort((a, b) => a.capsule_number - b.capsule_number)[0];

    const nextUncompleted = progress
      .filter((p) => !completedNumbers.has(p.capsule_number) && p.capsule_number > 0)
      .sort((a, b) => a.capsule_number - b.capsule_number)[0];

    const next = pending ?? nextUncompleted;

    const lastActivity = progress
      .map((p) => p.started_at ?? p.completed_at)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;

    results.push({
      pathId: pid,
      name: info?.name ?? "Método FIA",
      programSlug: info?.programSlug ?? null,
      isPaid: info?.isPaid ?? false,
      completed,
      total,
      nextCapsuleNumber: next?.capsule_number ?? null,
      nextCapsuleTitle: next?.capsule_title ?? null,
      isFinished: completed >= total && total > 0,
      activePath: false, // set below
      lastActivity,
    });
  }

  // Pick active path: paid with recent activity first, then free
  const paidWithProgress = results.filter((r) => r.isPaid && !r.isFinished);
  const activeCandidate =
    (paidWithProgress.sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""))[0]) ??
    (results.sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""))[0]);

  for (const r of results) {
    r.activePath = r.pathId === activeCandidate?.pathId;
  }

  // Strip internal lastActivity before returning
  return results.map(({ lastActivity: _la, ...rest }) => rest);
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
    .order("started_at", { ascending: true });

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
    .order("created_at", { ascending: false })
    .limit(10);

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

// ─── Segmentation ───

export interface UserSegment {
  isPaid: boolean;
  isFiaVentas: boolean;
  isFiaEmpresas: boolean;
  orgRole: string | null;
  planId: string | null;
  trialOfferExpiresAt: string | null;
  /** Data-driven list of programs the user is enrolled in (from user_program_access + learning_paths). */
  enrolledPrograms: Array<{ slug: string; name: string; pathId: string; isPaid: boolean }>;
}

/**
 * Returns the user's segment for inbound AI personalization.
 * Priority: FIA Empresas > FIA Ventas > Pro > Lead frío
 * Also hydrates enrolledPrograms from learning_paths (data-driven, no hardcoded slugs).
 */
export async function getUserSegment(userId: string): Promise<UserSegment> {
  const [programAccess, subscription, profile, paths] = await Promise.all([
    getSupabaseClient()
      .from("user_program_access")
      .select("program_slug")
      .eq("user_id", userId)
      .eq("status", "active"),
    getSupabaseClient()
      .from("subscriptions")
      .select("plan_id, status")
      .eq("user_id", userId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    getSupabaseClient()
      .from("profiles")
      .select("org_role, trial_offer_expires_at")
      .eq("id", userId)
      .single(),
    getLearningPaths(),
  ]);

  const slugs = (programAccess.data ?? []).map((r) => (r as { program_slug: string }).program_slug);
  const sub = subscription.data as { plan_id: string; status: string } | null;
  const prof = profile.data as { org_role: string | null; trial_offer_expires_at: string | null } | null;

  // org-level FIA Empresas access (sponsor/implementador roles get automatic access)
  const hasOrgEmpresasAccess = prof?.org_role === "sponsor" || prof?.org_role === "implementador";

  // Build enrolledPrograms by crossing slugs with learning_paths (data-driven)
  const enrolledPrograms: Array<{ slug: string; name: string; pathId: string; isPaid: boolean }> = [];
  for (const path of paths) {
    if (!path.program_slug) continue; // skip free method (no slug needed)
    const hasAccess = slugs.includes(path.program_slug) ||
      (path.program_slug === "fia-empresas" && hasOrgEmpresasAccess);
    if (hasAccess) {
      enrolledPrograms.push({
        slug: path.program_slug,
        name: path.name,
        pathId: path.id,
        isPaid: path.is_paid,
      });
    }
  }

  return {
    isPaid: !!sub || slugs.length > 0,
    // Backward-compat booleans derived from the data-driven list
    isFiaVentas: enrolledPrograms.some((p) => p.slug === "fia-ventas"),
    isFiaEmpresas: enrolledPrograms.some((p) => p.slug === "fia-empresas") || hasOrgEmpresasAccess,
    orgRole: prof?.org_role ?? null,
    planId: sub?.plan_id ?? null,
    trialOfferExpiresAt: prof?.trial_offer_expires_at ?? null,
    enrolledPrograms,
  };
}

// ─── Conversation State ───

export interface ConversationState {
  consecutiveLowEngagement: number;
  lastAiReplyAt: string | null;
  /** Facts mentioned by the user in past turns (rotating, max 8 items). */
  userFacts: string[];
  /** ISO timestamp until which outbound messages should be paused for this user. */
  pausedUntil: string | null;
  /** Recent AI reply timestamps (for hourly rate limiting). Stored as ISO array, max 20. */
  aiReplyTimestamps: string[];
}

export async function getConversationState(userId: string): Promise<ConversationState> {
  const { data } = await getSupabaseClient()
    .from("wa_conversation_state")
    .select("consecutive_low_engagement, last_ai_reply_at, metadata")
    .eq("user_id", userId)
    .maybeSingle();

  const empty: ConversationState = {
    consecutiveLowEngagement: 0,
    lastAiReplyAt: null,
    userFacts: [],
    pausedUntil: null,
    aiReplyTimestamps: [],
  };
  if (!data) return empty;

  const row = data as {
    consecutive_low_engagement: number;
    last_ai_reply_at: string | null;
    metadata?: { userFacts?: string[]; pausedUntil?: string | null; aiReplyTimestamps?: string[] } | null;
  };
  return {
    consecutiveLowEngagement: row.consecutive_low_engagement,
    lastAiReplyAt: row.last_ai_reply_at,
    userFacts: row.metadata?.userFacts ?? [],
    pausedUntil: row.metadata?.pausedUntil ?? null,
    aiReplyTimestamps: row.metadata?.aiReplyTimestamps ?? [],
  };
}

/**
 * Per-user serialization map for upsertConversationState.
 * Prevents lost-write races when two messages from the same user are processed
 * in overlapping fashion (which can happen via the async messages.upsert handler).
 */
const _stateUpsertChain = new Map<string, Promise<void>>();

export async function upsertConversationState(
  userId: string,
  updates: {
    consecutiveLowEngagement?: number;
    lastAiReplyAt?: string;
    userFacts?: string[];
    pausedUntil?: string | null;
    aiReplyTimestamps?: string[];
  },
): Promise<void> {
  // Serialize per user — chain new updates after the previous one finishes.
  const prev = _stateUpsertChain.get(userId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(async () => {
    const row: Record<string, unknown> = { user_id: userId, updated_at: new Date().toISOString() };
    if (updates.consecutiveLowEngagement !== undefined) row["consecutive_low_engagement"] = updates.consecutiveLowEngagement;
    if (updates.lastAiReplyAt !== undefined) row["last_ai_reply_at"] = updates.lastAiReplyAt;

    // Merge metadata fields — read existing first to avoid clobbering OTHER metadata fields
    if (updates.userFacts !== undefined || updates.pausedUntil !== undefined || updates.aiReplyTimestamps !== undefined) {
      const { data: existing } = await getSupabaseClient()
        .from("wa_conversation_state")
        .select("metadata")
        .eq("user_id", userId)
        .maybeSingle();
      const prevMeta = (existing?.metadata as Record<string, unknown> | null) ?? {};
      row["metadata"] = {
        ...prevMeta,
        ...(updates.userFacts !== undefined ? { userFacts: updates.userFacts } : {}),
        ...(updates.pausedUntil !== undefined ? { pausedUntil: updates.pausedUntil } : {}),
        ...(updates.aiReplyTimestamps !== undefined ? { aiReplyTimestamps: updates.aiReplyTimestamps } : {}),
      };
    }

    const { error } = await getSupabaseClient()
      .from("wa_conversation_state")
      .upsert(row, { onConflict: "user_id" });

    if (error) logger.warn({ error, userId }, "Failed to upsert conversation state");
  });
  _stateUpsertChain.set(userId, next);
  // Garbage-collect: if this is the latest in the chain, delete after settled
  void next.finally(() => {
    if (_stateUpsertChain.get(userId) === next) _stateUpsertChain.delete(userId);
  });
  await next;
}

// ─── Engine Config (Configurable Prompts, Templates, Responses) ───

export async function getEngineConfig(key: string): Promise<string | null> {
  const { data, error } = await getSupabaseClient()
    .from("engine_config")
    .select("value")
    .eq("key", key)
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      // Not found — return null instead of logging error
      return null;
    }
    logger.warn({ error, key }, "Failed to fetch engine config");
    return null;
  }
  return data?.value ?? null;
}

export async function getAllEngineConfig(): Promise<Record<string, string>> {
  const { data, error } = await getSupabaseClient()
    .from("engine_config")
    .select("key, value");

  if (error) {
    logger.warn({ error }, "Failed to fetch all engine config");
    return {};
  }

  const result: Record<string, string> = {};
  if (Array.isArray(data)) {
    for (const row of data) {
      result[row.key] = row.value;
    }
  }
  return result;
}

export async function setEngineConfig(
  key: string,
  value: string,
  updatedBy?: string,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("engine_config")
    .upsert(
      {
        key,
        value,
        updated_at: new Date().toISOString(),
        updated_by: updatedBy,
      },
      { onConflict: "key" },
    );

  if (error) {
    logger.error({ error, key }, "Failed to set engine config");
    throw error;
  }

  logger.info({ key }, "Engine config updated");
}

// ─── Scheduled Messages ───

export interface ScheduledMessage {
  id: string;
  name: string;
  journey_name: string;
  segment: string;
  schedule_cron: string;
  message_key: string | null;
  active: boolean;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function getActiveScheduledMessages(): Promise<ScheduledMessage[]> {
  const { data, error } = await getSupabaseClient()
    .from("engine_scheduled_messages")
    .select("*")
    .eq("active", true)
    .order("created_at", { ascending: true });

  if (error) {
    logger.warn({ error }, "Failed to fetch active scheduled messages");
    return [];
  }
  return (data ?? []) as ScheduledMessage[];
}

export async function getAllScheduledMessages(): Promise<ScheduledMessage[]> {
  const { data, error } = await getSupabaseClient()
    .from("engine_scheduled_messages")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    logger.warn({ error }, "Failed to fetch scheduled messages");
    return [];
  }
  return (data ?? []) as ScheduledMessage[];
}

export async function createScheduledMessage(
  params: Omit<ScheduledMessage, "id" | "last_run_at" | "created_at" | "updated_at">,
): Promise<ScheduledMessage | null> {
  const { data, error } = await getSupabaseClient()
    .from("engine_scheduled_messages")
    .insert(params)
    .select("*")
    .single();

  if (error) {
    logger.error({ error }, "Failed to create scheduled message");
    return null;
  }
  return data as ScheduledMessage;
}

export async function updateScheduledMessage(
  id: string,
  updates: Partial<Omit<ScheduledMessage, "id" | "created_at" | "updated_at">>,
): Promise<ScheduledMessage | null> {
  const { data, error } = await getSupabaseClient()
    .from("engine_scheduled_messages")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    logger.error({ error, id }, "Failed to update scheduled message");
    return null;
  }
  return data as ScheduledMessage;
}

export async function deleteScheduledMessage(id: string): Promise<boolean> {
  const { error } = await getSupabaseClient()
    .from("engine_scheduled_messages")
    .delete()
    .eq("id", id);

  if (error) {
    logger.error({ error, id }, "Failed to delete scheduled message");
    return false;
  }
  return true;
}

export async function getAbTestStats(testName: string): Promise<{
  a: { impressions: number; responses: number };
  b: { impressions: number; responses: number };
}> {
  const { data } = await getSupabaseClient()
    .from("engagement_log")
    .select("metadata")
    .eq("status", "sent")
    .not("metadata->>ab_test_name", "is", null);

  const rows = (data ?? []) as Array<{ metadata: Record<string, unknown> }>;
  const filtered = rows.filter((r) => r.metadata?.["ab_test_name"] === testName);

  const result = { a: { impressions: 0, responses: 0 }, b: { impressions: 0, responses: 0 } };
  for (const row of filtered) {
    const v = row.metadata?.["ab_variant"] as "a" | "b" | undefined;
    if (v !== "a" && v !== "b") continue;
    result[v].impressions++;
    if (row.metadata?.["responded"] === true) result[v].responses++;
  }
  return result;
}

export async function getUsersInSegment(segment: string): Promise<Array<{ id: string; phone: string; name: string | null; company_name: string | null }>> {
  const sb = getSupabaseClient();

  type ProfileRow = { id: string; phone: string | null; name: string | null; company_name: string | null; whatsapp_opt_in: boolean };
  type AccessRow = { profiles: ProfileRow | ProfileRow[] };

  const filterProfiles = (rows: unknown[]): Array<{ id: string; phone: string; name: string | null; company_name: string | null }> =>
    (rows as AccessRow[]).reduce<Array<{ id: string; phone: string; name: string | null; company_name: string | null }>>((acc, r) => {
      const profile = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles;
      if (profile?.whatsapp_opt_in && profile.phone) {
        acc.push({ id: profile.id, phone: profile.phone, name: profile.name, company_name: profile.company_name });
      }
      return acc;
    }, []);

  // ── Static segments ──────────────────────────────────────────────────────
  if (segment === "todos") {
    const { data, error } = await sb
      .from("profiles")
      .select("id, phone, name, company_name")
      .eq("whatsapp_opt_in", true)
      .not("phone", "is", null);
    if (error) { logger.warn({ error, segment }, "Failed to fetch segment users"); return []; }
    return (data ?? []) as Array<{ id: string; phone: string; name: string | null; company_name: string | null }>;
  }

  if (segment === "leads") {
    // Users with no active plan and no program access
    const { data: allUsers } = await sb.from("profiles").select("id, phone, name, company_name").eq("whatsapp_opt_in", true).not("phone", "is", null);
    const { data: paidIds } = await sb.from("subscriptions").select("user_id").eq("status", "active");
    const { data: accessIds } = await sb.from("user_program_access").select("user_id").eq("status", "active");
    const paid = new Set([...(paidIds ?? []).map((r: { user_id: string }) => r.user_id), ...(accessIds ?? []).map((r: { user_id: string }) => r.user_id)]);
    return ((allUsers ?? []) as Array<{ id: string; phone: string; name: string | null; company_name: string | null }>).filter((u) => !paid.has(u.id));
  }

  if (segment === "paid") {
    // Any user with an active subscription OR active program access
    const { data: accessRows, error: accessErr } = await sb
      .from("user_program_access")
      .select("user_id, profiles!inner(id, phone, name, company_name, whatsapp_opt_in)")
      .eq("status", "active");
    if (accessErr) { logger.warn({ accessErr, segment }, "Failed to fetch paid segment"); return []; }
    return filterProfiles(accessRows ?? []);
  }

  if (segment === "fia-copilot-pro") {
    const { data: subRows, error: subErr } = await sb
      .from("subscriptions")
      .select("user_id, profiles!inner(id, phone, name, company_name, whatsapp_opt_in)")
      .eq("status", "active");
    if (subErr) { logger.warn({ subErr, segment }, "Failed to fetch pro segment"); return []; }
    return filterProfiles(subRows ?? []);
  }

  // ── Data-driven: check if segment matches a program_slug in learning_paths ──
  const paths = await getLearningPaths();
  const matchedPath = paths.find((p) => p.program_slug === segment);
  if (matchedPath) {
    const { data: accessRows, error: accessErr } = await sb
      .from("user_program_access")
      .select("user_id, profiles!inner(id, phone, name, company_name, whatsapp_opt_in)")
      .eq("program_slug", segment)
      .eq("status", "active");
    if (accessErr) { logger.warn({ accessErr, segment }, "Failed to fetch segment users via access"); return []; }
    return filterProfiles(accessRows ?? []);
  }

  logger.warn({ segment }, "Unknown segment — returning empty");
  return [];
}
