import { randomUUID } from "crypto";
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

/**
 * Recipients of the weekly report: users who have Sofía active.
 * Sofía is a paid feature → activation requires phone + opt-in + a confirmed activation.
 */
export async function getSofiaActiveUsers(): Promise<Profile[]> {
  const { data, error } = await getSupabaseClient()
    .from("profiles")
    .select("*")
    .not("phone", "is", null)
    .eq("whatsapp_opt_in", true)
    .not("sofia_activated_at", "is", null);

  if (error) {
    logger.error({ error }, "Failed to fetch Sofía-active users");
    return [];
  }
  return (data ?? []) as Profile[];
}

/**
 * Deactivate Sofía for a user (on STOP / opt-out).
 * Clears whatsapp_opt_in AND sofia_activated_at so the front renders "desactivada"
 * and the weekly report excludes them. Re-activation re-runs the wa.me flow.
 */
export async function deactivateSofia(userId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("profiles")
    .update({
      whatsapp_opt_in: false,
      sofia_activated_at: null,
      sofia_deactivated_at: new Date().toISOString(),
    })
    .eq("id", userId);
  if (error) {
    logger.error({ error, userId }, "Failed to deactivate Sofía");
  } else {
    logger.info({ userId }, "Sofía deactivated (opt-out)");
  }
}

/**
 * Activate Sofía for a user (inbound-first flow): the user clicked "Activar Sofía" in the
 * front, which opened WhatsApp; their first inbound message confirms activation.
 * Sets sofia_activated_at so the front poll flips to "✓ Sofía activa" and weekly reports include them.
 */
export async function activateSofia(userId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("profiles")
    .update({ sofia_activated_at: new Date().toISOString(), sofia_deactivated_at: null })
    .eq("id", userId);
  if (error) {
    logger.error({ error, userId }, "Failed to activate Sofía");
  } else {
    logger.info({ userId }, "Sofía activated (inbound)");
  }
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

// ─── Unified conversation log (sofia_conversations) ───

export interface SofiaConversationInsert {
  user_id: string;
  direction: "in" | "out";
  kind: string; // 'reporte_semanal' | 'inbound_reply' | 'command' | 'activation'
  body: string;
  status?: string; // 'sent' | 'failed' | 'received'
  truncated?: boolean;
  generation_source?: string | null;
  error_reason?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Reuses the most recent thread within a 72h window for this user, else starts a new one.
 * Keeps related back-and-forth grouped under one conversation_id for the dashboard.
 */
async function resolveConversationId(userId: string): Promise<string> {
  const since = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
  const { data } = await getSupabaseClient()
    .from("sofia_conversations")
    .select("conversation_id")
    .eq("user_id", userId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.conversation_id as string | undefined) ?? randomUUID();
}

/** Logs one message (inbound or outbound) to the unified conversation table. Best-effort. */
export async function logConversation(entry: SofiaConversationInsert): Promise<void> {
  try {
    const conversation_id = await resolveConversationId(entry.user_id);
    const { error } = await getSupabaseClient()
      .from("sofia_conversations")
      .insert({
        user_id: entry.user_id,
        conversation_id,
        direction: entry.direction,
        kind: entry.kind,
        body: entry.body.slice(0, 4000),
        status: entry.status ?? (entry.direction === "in" ? "received" : "sent"),
        truncated: entry.truncated ?? false,
        generation_source: entry.generation_source ?? null,
        error_reason: entry.error_reason ?? null,
        metadata: entry.metadata ?? {},
      });
    if (error) logger.warn({ error, userId: entry.user_id }, "Failed to log sofia_conversation");
  } catch (error) {
    logger.warn({ error, userId: entry.user_id }, "logConversation threw");
  }
}

/**
 * Conversation history for inbound AI memory — reads from the unified table.
 * Maps direction → role so callers keep the same shape.
 */
export async function getConversationHistory(
  userId: string,
  limit = 10,
): Promise<Array<{ role: string; content: string }>> {
  const { data, error } = await getSupabaseClient()
    .from("sofia_conversations")
    .select("direction, body")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    logger.error({ error, userId }, "Failed to fetch conversation history");
    return [];
  }

  // Reverse to chronological order and map to role/content
  return ((data ?? []) as Array<{ direction: string; body: string }>)
    .reverse()
    .map((r) => ({ role: r.direction === "in" ? "user" : "assistant", content: r.body }));
}

/**
 * Append inbound-conversation messages (user/assistant) to the unified log.
 * Kept signature-compatible with the previous wa_conversation_history writer.
 */
export async function appendConversationMessages(
  userId: string,
  messages: Array<{ role: string; content: string }>,
): Promise<void> {
  for (const m of messages) {
    await logConversation({
      user_id: userId,
      direction: m.role === "user" ? "in" : "out",
      kind: "inbound_reply",
      body: m.content,
    });
  }
}

// ─── Knowledge base (read-only; lives in FIA Copilot DB, owned/maintained by Axel) ───
// Table: knowledge_base (NO "sofia" prefix). Schema per Axel's doc:
//   id, slug, category, title, summary, content, voice_notes, tags, related, priority, source, status
// Categories: framework | principio | metafora | voz | caso | producto | icp

export interface KnowledgeEntry {
  slug: string;
  category: string;
  title: string;
  summary: string | null;
  content: string;
  voice_notes: string | null;
  tags: string[] | null;
  priority: number | null;
  status: string | null;
}

const INACTIVE_KNOWLEDGE_STATUS = new Set(["draft", "archived", "disabled", "inactive"]);

let _knowledgeCache: KnowledgeEntry[] | null = null;
let _knowledgeCacheExpiry = 0;

/**
 * Returns the active knowledge-base entries (frameworks, principles, metaphors, voice, ICP,
 * products) ordered by priority desc. Reads `knowledge_base`; returns [] gracefully if the
 * table doesn't exist yet. Cached 5 min. These are global to Sofía — program-specific detail
 * comes from `capsules.content_md`, not from here.
 */
export async function getKnowledge(): Promise<KnowledgeEntry[]> {
  if (!_knowledgeCache || Date.now() >= _knowledgeCacheExpiry) {
    try {
      const { data, error } = await getSupabaseClient()
        .from("knowledge_base")
        .select("slug, category, title, summary, content, voice_notes, tags, priority, status");
      if (error) {
        // Table may not exist yet — degrade gracefully
        _knowledgeCache = [];
      } else {
        const rows = (data ?? []) as KnowledgeEntry[];
        _knowledgeCache = rows
          .filter((k) => !k.status || !INACTIVE_KNOWLEDGE_STATUS.has(k.status.toLowerCase()))
          .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
      }
    } catch {
      _knowledgeCache = [];
    }
    _knowledgeCacheExpiry = Date.now() + 5 * 60 * 1000;
  }
  return _knowledgeCache;
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

export async function deleteEngineConfig(key: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("engine_config")
    .delete()
    .eq("key", key);

  if (error) {
    logger.error({ error, key }, "Failed to delete engine config key");
    throw error;
  }

  logger.info({ key }, "Engine config key deleted");
}

// ─── Observability (dashboard aggregations over sofia_conversations) ───

interface ConvRow {
  user_id: string;
  conversation_id: string;
  direction: "in" | "out";
  kind: string;
  body: string;
  status: string;
  truncated: boolean;
  generation_source: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface ObservabilityStats {
  windowDays: number;
  totalMessages: number;
  inbound: number;
  outbound: number;
  threads: number;
  byKind: Record<string, number>;
  failed: number; // status='failed' → delivery/generation bugs
  templateFallbacks: number; // generation_source='template' → AI fell back
  truncated: number;
  weeklyReports: number;
  weeklyReportsResponded: number;
  responseRate: number; // 0..1
  truncatedThreads: number; // threads whose last message is inbound (unanswered)
  byLabel: Record<string, number>; // AI classification labels (metadata.label)
  byDay: Array<{ day: string; inbound: number; outbound: number }>;
}

async function fetchConvRows(windowDays: number): Promise<ConvRow[]> {
  const since = new Date(Date.now() - windowDays * 86400000).toISOString();
  const { data, error } = await getSupabaseClient()
    .from("sofia_conversations")
    .select("user_id, conversation_id, direction, kind, body, status, truncated, generation_source, metadata, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: true });
  if (error) {
    logger.warn({ error }, "Failed to fetch sofia_conversations for observability");
    return [];
  }
  return (data ?? []) as ConvRow[];
}

export async function getObservabilityStats(windowDays = 30): Promise<ObservabilityStats> {
  const rows = await fetchConvRows(windowDays);

  const byKind: Record<string, number> = {};
  const byLabel: Record<string, number> = {};
  const byDayMap = new Map<string, { inbound: number; outbound: number }>();
  const threadsSet = new Set<string>();
  let inbound = 0, outbound = 0, failed = 0, templateFallbacks = 0, truncated = 0;

  // Per-thread tracking for response-rate and unanswered detection
  const reportThreads = new Set<string>(); // threads containing a reporte_semanal
  const inboundAfterReport = new Set<string>(); // threads with inbound after the report
  const reportTimeByThread = new Map<string, string>();
  const lastDirByThread = new Map<string, "in" | "out">();

  for (const r of rows) {
    threadsSet.add(r.conversation_id);
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    if (r.direction === "in") inbound++; else outbound++;
    if (r.status === "failed") failed++;
    if (r.generation_source === "template") templateFallbacks++;
    if (r.truncated) truncated++;

    const label = (r.metadata?.["label"] as string | undefined) ?? null;
    if (label) byLabel[label] = (byLabel[label] ?? 0) + 1;

    const day = r.created_at.slice(0, 10);
    const d = byDayMap.get(day) ?? { inbound: 0, outbound: 0 };
    if (r.direction === "in") d.inbound++; else d.outbound++;
    byDayMap.set(day, d);

    lastDirByThread.set(r.conversation_id, r.direction);

    if (r.kind === "reporte_semanal" && r.direction === "out") {
      reportThreads.add(r.conversation_id);
      if (!reportTimeByThread.has(r.conversation_id)) reportTimeByThread.set(r.conversation_id, r.created_at);
    }
    if (r.direction === "in") {
      const reportTime = reportTimeByThread.get(r.conversation_id);
      if (reportTime && r.created_at > reportTime) inboundAfterReport.add(r.conversation_id);
    }
  }

  const weeklyReports = reportThreads.size;
  const weeklyReportsResponded = inboundAfterReport.size;
  const truncatedThreads = Array.from(lastDirByThread.entries()).filter(([, dir]) => dir === "in").length;

  const byDay = Array.from(byDayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, v]) => ({ day, inbound: v.inbound, outbound: v.outbound }));

  return {
    windowDays,
    totalMessages: rows.length,
    inbound,
    outbound,
    threads: threadsSet.size,
    byKind,
    failed,
    templateFallbacks,
    truncated,
    weeklyReports,
    weeklyReportsResponded,
    responseRate: weeklyReports > 0 ? weeklyReportsResponded / weeklyReports : 0,
    truncatedThreads,
    byLabel,
    byDay,
  };
}

export interface ThreadSummary {
  conversationId: string;
  userId: string;
  messageCount: number;
  lastDirection: "in" | "out";
  lastKind: string;
  lastBody: string;
  lastAt: string;
  hasFailure: boolean;
  label: string | null;
}

/** Recent conversation threads, newest activity first, for the observability list. */
export async function getConversationThreads(windowDays = 30, limit = 100): Promise<ThreadSummary[]> {
  const rows = await fetchConvRows(windowDays);
  const byThread = new Map<string, ConvRow[]>();
  for (const r of rows) {
    const arr = byThread.get(r.conversation_id) ?? [];
    arr.push(r);
    byThread.set(r.conversation_id, arr);
  }

  const summaries: ThreadSummary[] = [];
  for (const [conversationId, msgs] of byThread) {
    const last = msgs[msgs.length - 1] as ConvRow;
    const label = msgs.map((m) => m.metadata?.["label"] as string | undefined).find(Boolean) ?? null;
    summaries.push({
      conversationId,
      userId: last.user_id,
      messageCount: msgs.length,
      lastDirection: last.direction,
      lastKind: last.kind,
      lastBody: (last.body ?? "").slice(0, 140),
      lastAt: last.created_at,
      hasFailure: msgs.some((m) => m.status === "failed"),
      label,
    });
  }
  summaries.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return summaries.slice(0, limit);
}

/** Full message list of a single thread, chronological. */
export async function getThread(conversationId: string): Promise<Array<{ direction: string; kind: string; body: string; status: string; created_at: string }>> {
  const { data, error } = await getSupabaseClient()
    .from("sofia_conversations")
    .select("direction, kind, body, status, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  if (error) {
    logger.warn({ error, conversationId }, "Failed to fetch thread");
    return [];
  }
  return (data ?? []) as Array<{ direction: string; kind: string; body: string; status: string; created_at: string }>;
}

/** Recent conversations not yet classified (for the AI labeling job). */
export async function getUnlabeledConversations(limit = 50): Promise<Array<{ id: string; body: string; direction: string }>> {
  const { data, error } = await getSupabaseClient()
    .from("sofia_conversations")
    .select("id, body, direction, metadata")
    .eq("direction", "in")
    .order("created_at", { ascending: false })
    .limit(limit * 3);
  if (error) {
    logger.warn({ error }, "Failed to fetch unlabeled conversations");
    return [];
  }
  const rows = (data ?? []) as Array<{ id: string; body: string; direction: string; metadata: Record<string, unknown> | null }>;
  return rows
    .filter((r) => !(r.metadata && typeof r.metadata["label"] === "string"))
    .slice(0, limit)
    .map((r) => ({ id: r.id, body: r.body, direction: r.direction }));
}

/** Persist a classification label onto a conversation row (merges into metadata). */
export async function setConversationLabel(id: string, label: string): Promise<void> {
  const { data } = await getSupabaseClient()
    .from("sofia_conversations")
    .select("metadata")
    .eq("id", id)
    .maybeSingle();
  const meta = ((data?.metadata as Record<string, unknown> | null) ?? {});
  meta["label"] = label;
  await getSupabaseClient().from("sofia_conversations").update({ metadata: meta }).eq("id", id);
}
