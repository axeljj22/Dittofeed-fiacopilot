/**
 * HTTP server for:
 * 1. Incoming WhatsApp webhook responses
 * 2. Admin engagement API (stats, logs)
 * 3. Health check
 * 4. Manual trigger endpoint
 * 5. Click tracking redirects (/r/:logId)
 */
import http from "http";
import { config } from "./config";
import { logger } from "./logger";
import { processIncomingResponse } from "./senders/responses";
import { sendWhatsAppMessage } from "./senders/whatsapp";
import { evolutionManager } from "./senders/whatsappEvolution";
import { getSupabaseClient, getPathTotals, resolveUserPaths, getSofiaFeatures } from "./db/supabase";
import { runWeeklyReport } from "./orchestrator";
import { getAdminPanelHtml } from "./admin/panel";
import { isCodexAvailable, invalidateCodexAuthCache } from "./generators/codexGenerator";
import { warmCache, setCachedConfig, getReportSchedule } from "./config/engineConfigCache";
import { rescheduleWeeklyReport } from "./reportScheduler";
import fs from "fs";

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * Bearer-token auth gate for admin endpoints.
 * Accepts either ADMIN_API_TOKEN (long hex, for scripts/curl) or ADMIN_PASSWORD
 * (short human password, for the web UI). Returns true if authorized; otherwise
 * writes the response and returns false. Caller should `return` immediately if false.
 */
function requireAdminAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const authHeader = req.headers["authorization"];
  const expectedToken = process.env["ADMIN_API_TOKEN"];
  const adminPassword = process.env["ADMIN_PASSWORD"];

  if (!expectedToken || expectedToken === "admin-secret") {
    jsonResponse(res, 503, { error: "ADMIN_API_TOKEN not configured (or set to default)" });
    return false;
  }

  const provided = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const isValid =
    provided !== null &&
    (provided === expectedToken || (adminPassword != null && adminPassword.length > 0 && provided === adminPassword));

  if (!isValid) {
    jsonResponse(res, 401, { error: "Unauthorized" });
    return false;
  }
  return true;
}

// ─── Route handlers ───

async function handleHealthCheck(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const [codexOk, evolutionState] = await Promise.all([
    isCodexAvailable().catch(() => false),
    evolutionManager.getStatus().catch(() => "unknown" as const),
  ]);
  jsonResponse(res, 200, {
    status: "ok",
    service: "fia-engagement-engine",
    version: process.env["APP_VERSION"] ?? "unknown",
    gitSha: process.env["GIT_SHA"] ?? "unknown",
    buildTime: process.env["BUILD_TIME"] ?? "unknown",
    whatsapp: {
      primary: config.whatsapp.provider,
      cloudApi: config.whatsapp.cloudApi.token ? "configured" : "not_configured",
      evolution: {
        connected: evolutionState === "open",
        state: evolutionState,
        instance: config.whatsapp.evolution.instanceName,
      },
      fallback: config.whatsapp.fallbackProvider || "none",
    },
    codex: codexOk ? "available" : "unavailable",
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}

/**
 * WhatsApp webhook verification (GET) — Meta Cloud API requires this.
 */
async function handleWebhookVerify(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const verifyToken = process.env["WHATSAPP_VERIFY_TOKEN"] ?? "fia-engine";

  if (mode === "subscribe" && token === verifyToken) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(challenge);
  } else {
    jsonResponse(res, 403, { error: "Verification failed" });
  }
}

/**
 * WhatsApp webhook (POST) — incoming messages from users.
 */
async function handleWebhookIncoming(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const body = JSON.parse(await parseBody(req));

    // Meta Cloud API format
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message) {
      jsonResponse(res, 200, { status: "no_message" });
      return;
    }

    const from = message.from;
    const text = message.text?.body ?? "";

    const action = await processIncomingResponse({ from, body: text });

    // Send reply back via WhatsApp
    if (config.whatsapp.provider === "cloud_api" && action.replyText) {
      const axios = (await import("axios")).default;
      await axios.post(
        `https://graph.facebook.com/v18.0/${config.whatsapp.cloudApi.phoneNumberId}/messages`,
        {
          messaging_product: "whatsapp",
          to: from,
          type: "text",
          text: { body: action.replyText },
        },
        {
          headers: {
            Authorization: `Bearer ${config.whatsapp.cloudApi.token}`,
            "Content-Type": "application/json",
          },
        },
      );
    }

    jsonResponse(res, 200, { status: "processed", type: action.type });
  } catch (error) {
    logger.error({ error }, "Webhook processing failed");
    jsonResponse(res, 500, { error: "Internal error" });
  }
}

/**
 * POST /webhook/whatsapp/evolution — Evolution API webhook for inbound messages.
 *
 * Evolution sends events when a message lands on the Sofia instance. We only
 * care about MESSAGES_UPSERT events where the message is NOT from us.
 *
 * Body shape (Evolution v2):
 *   { event: "messages.upsert", instance: "Sofia",
 *     data: { key: { remoteJid, fromMe, id }, message: { conversation } | { extendedTextMessage: { text } }, ... } }
 *
 * We mirror what the Evolution webhook does on `messages.upsert`: skip fromMe,
 * resolve phone, hand off to processIncomingResponse, then reply + optional
 * notify-admin. Defensive parsing — log and ignore unknown shapes.
 */
async function handleWebhookEvolution(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const raw = await parseBody(req);
    const body = JSON.parse(raw) as {
      event?: string;
      instance?: string;
      data?: {
        key?: { remoteJid?: string; fromMe?: boolean; id?: string; participant?: string };
        message?: {
          conversation?: string;
          extendedTextMessage?: { text?: string; contextInfo?: { mentionedJid?: string[] } };
        } | null;
      };
    };

    // Acknowledge immediately so Evolution doesn't retry; do the work in background.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));

    if (body.event !== "messages.upsert") return;
    const key = body.data?.key;
    if (!key?.remoteJid || key.fromMe) return;

    const text = body.data?.message?.conversation
      ?? body.data?.message?.extendedTextMessage?.text
      ?? "";

    // ── Group messages (@g.us): listen + reply only when mentioned ──
    if (key.remoteJid.endsWith("@g.us")) {
      if (!key.participant || !text) return;
      const mentionedJid = body.data?.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      const { processGroupMessage } = await import("./senders/responses");
      await processGroupMessage({
        groupJid: key.remoteJid,
        senderJid: key.participant,
        text,
        mentionedJid,
        messageId: key.id ?? undefined,
      });
      return;
    }

    // ── Direct chats (@s.whatsapp.net): the 1:1 flow. Broadcasts etc. are ignored. ──
    if (!key.remoteJid.endsWith("@s.whatsapp.net")) return;

    const from = key.remoteJid.replace("@s.whatsapp.net", "");
    if (!from || !text) return;

    logger.info({ from, body: text.slice(0, 80) }, "Evolution inbound message");

    const action = await processIncomingResponse({ from, body: text, messageId: key.id ?? undefined });

    if (action.replyText) {
      // Typing indicator → small humanizing delay before the actual reply
      const typingMs = Math.min(1000 + action.replyText.length * 30, 4000);
      await evolutionManager.sendTyping(from, typingMs);
      await evolutionManager.sendMessage(from, action.replyText);
    }

    // Notify Axel when a whitelisted pilot user sends a message
    const normalizedSender = from.replace(/\D/g, "");
    const isWhitelisted = config.engine.pilotWhitelistPhones.some((p) => normalizedSender.includes(p));
    if (isWhitelisted && config.engine.notifyPhone && normalizedSender !== config.engine.notifyPhone) {
      const replyPreview = action.replyText ? action.replyText.slice(0, 200) : "(sin respuesta)";
      const notifText = `🔔 *${from}* escribió\n📥 "${text.slice(0, 200)}"\n💬 Sofía: "${replyPreview}"`;
      await evolutionManager.sendMessage(config.engine.notifyPhone, notifText);
    }
  } catch (error) {
    logger.error({ error }, "Evolution webhook processing failed");
    // Already responded 200 — don't try to write again
  }
}

/**
 * POST /api/trigger — manually run the weekly report (admin only)
 */
async function handleManualTrigger(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!requireAdminAuth(req, res)) return;

  try {
    await runWeeklyReport();
    jsonResponse(res, 200, { status: "triggered", job: "weekly_report" });
  } catch (error) {
    logger.error({ error }, "Manual trigger failed");
    jsonResponse(res, 500, { error: "Trigger failed" });
  }
}

/**
 * POST /api/test/message — send a test weekly report through the full Sofía pipeline (admin only)
 * Body: { userId: "uuid" }                              (builds the real weekly-report context)
 * Or:   { phone: "5491125120212", text: "hardcoded text" }  (raw send, no AI)
 */
async function handleTestMessage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!requireAdminAuth(req, res)) return;

  try {
    const body = JSON.parse(await parseBody(req)) as {
      userId?: string;
      phone?: string;
      text?: string;
      dryRun?: boolean;
    };

    // Raw send (no AI generation) — route through active provider
    if (body.phone && body.text) {
      const provider = config.whatsapp.provider;
      const result = await evolutionManager.sendMessage(body.phone, body.text);
      jsonResponse(res, result.success ? 200 : 500, { ...result, provider });
      return;
    }

    // Full pipeline: fetch profile → build weekly report context → generate → (send | dryRun)
    if (!body.userId) {
      jsonResponse(res, 400, { error: "userId or phone+text required" });
      return;
    }

    const { getProfileWithWhatsapp } = await import("./db/supabase");
    const { generateMessage } = await import("./generators/messageGenerator");
    const { sendWhatsAppMessage } = await import("./senders/whatsapp");
    const { buildWeeklyReportOpportunity } = await import("./detectors/weeklyReport");

    const profile = await getProfileWithWhatsapp(body.userId);
    if (!profile) {
      jsonResponse(res, 404, { error: "Profile not found" });
      return;
    }

    const opportunity = await buildWeeklyReportOpportunity(profile);
    const message = await generateMessage(opportunity);
    if (!message) {
      jsonResponse(res, 500, { error: "Message generation failed" });
      return;
    }

    // dryRun = generate + return the text WITHOUT sending (preview without spamming the user)
    if (body.dryRun) {
      jsonResponse(res, 200, { success: true, dryRun: true, text: message.text, deepLink: message.deepLink, journey: opportunity.journeyName, source: message.source, context: opportunity.context });
      return;
    }

    await sendWhatsAppMessage(opportunity, message);
    jsonResponse(res, 200, { success: true, text: message.text, journey: opportunity.journeyName, source: message.source });
  } catch (error) {
    logger.error({ error }, "Test message failed");
    jsonResponse(res, 500, { error: "Failed to send test message" });
  }
}

/**
 * GET /api/engagement/stats — global engagement stats
 */
async function handleEngagementStats(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const supabase = getSupabaseClient();

    const weekAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const [sentThisWeek, clickedThisWeek, respondedThisWeek, optedOut] =
      await Promise.all([
        supabase
          .from("engagement_log")
          .select("*", { count: "exact", head: true })
          .eq("status", "sent")
          .gte("created_at", weekAgo),
        supabase
          .from("engagement_log")
          .select("*", { count: "exact", head: true })
          .contains("metadata", { clicked: true })
          .gte("created_at", weekAgo),
        supabase
          .from("engagement_log")
          .select("*", { count: "exact", head: true })
          .contains("metadata", { responded: true })
          .gte("created_at", weekAgo),
        supabase
          .from("profiles")
          .select("*", { count: "exact", head: true })
          .eq("whatsapp_opt_in", false),
      ]);

    const totalSent = sentThisWeek.count ?? 0;
    const totalClicked = clickedThisWeek.count ?? 0;
    const totalResponded = respondedThisWeek.count ?? 0;

    jsonResponse(res, 200, {
      period: "last_7_days",
      messages_sent: totalSent,
      click_rate: totalSent > 0 ? (totalClicked / totalSent) * 100 : 0,
      response_rate: totalSent > 0 ? (totalResponded / totalSent) * 100 : 0,
      users_opted_out: optedOut.count ?? 0,
    });
  } catch (error) {
    logger.error({ error }, "Failed to fetch engagement stats");
    jsonResponse(res, 500, { error: "Failed to fetch stats" });
  }
}

/**
 * GET /api/engagement/logs — recent engagement log entries
 */
async function handleEngagementLogs(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
    const userId = url.searchParams.get("user_id");

    let query = getSupabaseClient()
      .from("engagement_log")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (userId) {
      query = query.eq("lead_id", userId);
    }

    const { data, error } = await query;

    if (error) {
      jsonResponse(res, 500, { error: error.message });
      return;
    }

    jsonResponse(res, 200, { count: data?.length ?? 0, logs: data });
  } catch (error) {
    logger.error({ error }, "Failed to fetch engagement logs");
    jsonResponse(res, 500, { error: "Failed to fetch logs" });
  }
}

/**
 * GET /api/dashboard — Full platform data for CEO/Coaches dashboard.
 * Queries ALL tables, returns comprehensive analytics.
 */
async function handleDashboard(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!requireAdminAuth(req, res)) return;
  try {
    const supabase = getSupabaseClient();
    const now = Date.now();
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

    // ─── Pull ALL data from ALL tables in parallel ───
    const [
      profilesRes,
      capsulesRes,
      capsuleProgressRes,
      eventsAllRes,
      eventsMonthRes,
      leadScoresRes,
      vaultRes,
      assessmentsRes,
      engagementAllRes,
      engagementRecentRes,
      pathTotals,
    ] = await Promise.all([
      supabase.from("profiles").select("*"),
      supabase.from("capsules").select("*").order("number", { ascending: true }),
      supabase.from("capsule_progress").select("*"),
      supabase.from("events").select("*").order("created_at", { ascending: false }).limit(500),
      supabase.from("events").select("lead_id, event_type, metadata, created_at").gte("created_at", monthAgo).order("created_at", { ascending: false }),
      supabase.from("lead_scores").select("*"),
      supabase.from("vault_outputs").select("*").order("created_at", { ascending: false }),
      supabase.from("assessment_submissions").select("*").order("created_at", { ascending: false }),
      supabase.from("engagement_log").select("*").order("created_at", { ascending: false }),
      supabase.from("engagement_log").select("*").gte("created_at", weekAgo).order("created_at", { ascending: false }),
      getPathTotals(),
    ]);

    const profiles = profilesRes.data ?? [];
    const capsules = capsulesRes.data ?? [];
    const allProgress = capsuleProgressRes.data ?? [];

    // Map capsule UUID → capsule number for client-side joins
    const capsuleNumberById = new Map<string, number>();
    for (const c of capsules) capsuleNumberById.set(c.id, c.number);
    const allEvents = eventsAllRes.data ?? [];
    const monthEvents = eventsMonthRes.data ?? [];
    const allScores = leadScoresRes.data ?? [];
    const allVault = vaultRes.data ?? [];
    const allAssessments = assessmentsRes.data ?? [];
    const allEngagement = engagementAllRes.data ?? [];
    const recentEngagement = engagementRecentRes.data ?? [];

    // ─── INDEX data for fast lookups ───
    // Note: events/progress/scores/vault use lead_id (= profiles.id)
    const scoresByUser = new Map<string, { fit_score: number; intent_score: number; overall_score: number }>();
    for (const s of allScores) scoresByUser.set(s.lead_id, s);

    const progressByUser = new Map<string, typeof allProgress>();
    for (const p of allProgress) {
      const arr = progressByUser.get(p.lead_id) ?? [];
      arr.push(p);
      progressByUser.set(p.lead_id, arr);
    }

    const vaultByUser = new Map<string, typeof allVault>();
    for (const v of allVault) {
      const arr = vaultByUser.get(v.lead_id) ?? [];
      arr.push(v);
      vaultByUser.set(v.lead_id, arr);
    }

    const eventsByUser = new Map<string, typeof allEvents>();
    for (const e of allEvents) {
      const arr = eventsByUser.get(e.lead_id) ?? [];
      arr.push(e);
      eventsByUser.set(e.lead_id, arr);
    }

    const assessmentByUser = new Map<string, typeof allAssessments[0]>();
    for (const a of allAssessments) {
      if (!assessmentByUser.has(a.lead_id)) assessmentByUser.set(a.lead_id, a);
    }

    // Pre-index engagement by lead_id (engagement_log uses lead_id = profiles.id)
    const engagementByUser = new Map<string, typeof allEngagement>();
    for (const e of allEngagement) {
      const arr = engagementByUser.get(e.lead_id) ?? [];
      arr.push(e);
      engagementByUser.set(e.lead_id, arr);
    }

    // ─── 1. PER-USER DETAIL TABLE ───
    const userDetails = profiles.map((p) => {
      const userProg = progressByUser.get(p.id) ?? [];
      const completedCaps = userProg.filter((c) => c.status === "completed").length;
      const inProgressCaps = userProg.filter((c) => c.status === "viewed" || c.status === "in_progress");
      const userEvents = eventsByUser.get(p.id) ?? [];
      const lastEvent = userEvents[0];
      const daysSinceLastEvent = lastEvent
        ? Math.floor((now - new Date(lastEvent.created_at).getTime()) / (1000 * 60 * 60 * 24))
        : -1;
      const score = scoresByUser.get(p.id);
      const vaultCount = (vaultByUser.get(p.id) ?? []).length;
      const hasAssessment = assessmentByUser.has(p.id);
      const userEngagement = engagementByUser.get(p.id) ?? [];

      const userPaths = resolveUserPaths(userProg, pathTotals);
      const activePath = userPaths.find((path) => path.activePath) ?? userPaths[0] ?? null;

      let status = "registrado";
      if (activePath?.isFinished) status = "graduado";
      else if (completedCaps > 0 || inProgressCaps.length > 0) status = "activo";
      else if (hasAssessment) status = "diagnosticado";

      if (status === "activo" && daysSinceLastEvent > 15) status = "inactivo_critico";
      else if (status === "activo" && daysSinceLastEvent > 5) status = "inactivo";

      return {
        id: p.id,
        nombre: p.name || "Sin nombre",
        email: p.email || "",
        empresa: p.company_name || "Sin empresa",
        industria: p.industry || "Sin industria",
        plan: p.temperature || "sin_plan",
        rol: p.org_role || p.role || "user",
        whatsapp: p.phone ? "si" : "no",
        whatsapp_opt_in: p.whatsapp_opt_in,
        created_at: p.created_at,
        status,
        capsules_completed: completedCaps,
        capsules_in_progress: inProgressCaps.length,
        current_capsule: capsuleNumberById.get((inProgressCaps[0] as { capsule_id?: string } | undefined)?.capsule_id ?? "") ?? (completedCaps + 1),
        path_total: activePath?.total ?? config.engine.totalCapsules,
        program_name: activePath?.name ?? "Método FIA",
        days_since_last_event: daysSinceLastEvent,
        last_event_type: lastEvent?.event_type ?? null,
        overall_score: score?.overall_score ?? null,
        fit_score: score?.fit_score ?? null,
        intent_score: score?.intent_score ?? null,
        vault_outputs: vaultCount,
        has_assessment: hasAssessment,
        messages_received: userEngagement.length,
        messages_clicked: userEngagement.filter((e) => (e.metadata as { clicked?: boolean } | null)?.clicked === true).length,
        messages_responded: userEngagement.filter((e) => (e.metadata as { responded?: boolean } | null)?.responded === true).length,
        objetivo: p.objective || "",
      };
    });

    // ─── 2. KPI SUMMARY ───
    const totalUsers = profiles.length;
    const usersWithWA = profiles.filter((p) => p.phone).length;
    const optedOut = profiles.filter((p) => !p.whatsapp_opt_in).length;
    const weekActiveIds = new Set(monthEvents.filter((e) => e.created_at >= weekAgo).map((e) => e.lead_id));
    const diagnosed = userDetails.filter((u) => u.has_assessment).length;
    const graduated = userDetails.filter((u) => u.status === "graduado").length;
    const activeUsers = userDetails.filter((u) => u.status === "activo").length;
    const inactiveUsers = userDetails.filter((u) => u.status === "inactivo" || u.status === "inactivo_critico").length;
    const criticalUsers = userDetails.filter((u) => u.status === "inactivo_critico").length;
    const avgCompletion = totalUsers > 0
      ? Math.round(userDetails.reduce((sum, u) => sum + u.capsules_completed, 0) / totalUsers * 10) / 10
      : 0;

    // ─── 3. FUNNEL (step-by-step conversion) ───
    const funnel = {
      registered: totalUsers,
      diagnosed,
      started_capsules: userDetails.filter((u) => u.capsules_completed > 0 || u.capsules_in_progress > 0).length,
      completed_5_plus: userDetails.filter((u) => u.capsules_completed >= 5).length,
      completed_10_plus: userDetails.filter((u) => u.capsules_completed >= 10).length,
      completed_20_plus: userDetails.filter((u) => u.capsules_completed >= 20).length,
      graduated,
    };

    // ─── 4. PER-CAPSULE ANALYTICS (all capsules across all programs) ───
    const capsuleAnalytics = [];
    for (const capsuleInfo of capsules) {
      const num = capsuleInfo.number;
      const progressForCap = allProgress.filter((p) => p.capsule_id === capsuleInfo.id);
      const completedCount = progressForCap.filter((p) => p.status === "completed").length;
      const startedCount = progressForCap.filter((p) => p.status === "viewed" || p.status === "in_progress").length;
      const vaultForCap = allVault.filter((v) => v.capsule_id === capsuleInfo.id);
      const completionRate = (completedCount + startedCount) > 0
        ? Math.round((completedCount / (completedCount + startedCount)) * 100)
        : 0;

      capsuleAnalytics.push({
        numero: num,
        titulo: capsuleInfo.title ?? `Capsula ${num}`,
        total_started: completedCount + startedCount,
        completed: completedCount,
        in_progress: startedCount,
        completion_rate: completionRate,
        vault_outputs: vaultForCap.length,
        drop_off: startedCount, // users stuck here
      });
    }

    // ─── 5. SCORES ANALYTICS ───
    const scoreDistribution = { alto: 0, medio: 0, bajo: 0 };
    const fitBuckets: Record<string, number> = { "0-20": 0, "21-40": 0, "41-60": 0, "61-80": 0, "81-100": 0 };
    const intentBuckets: Record<string, number> = { "0-20": 0, "21-40": 0, "41-60": 0, "61-80": 0, "81-100": 0 };
    const overallBuckets: Record<string, number> = { "0-20": 0, "21-40": 0, "41-60": 0, "61-80": 0, "81-100": 0 };
    let fitSum = 0, intentSum = 0, overallSum = 0;

    function toBucket(val: number): string {
      if (val <= 20) return "0-20";
      if (val <= 40) return "21-40";
      if (val <= 60) return "41-60";
      if (val <= 80) return "61-80";
      return "81-100";
    }

    for (const s of allScores) {
      fitSum += s.fit_score;
      intentSum += s.intent_score;
      overallSum += s.overall_score;
      if (s.overall_score >= 70) scoreDistribution.alto++;
      else if (s.overall_score >= 40) scoreDistribution.medio++;
      else scoreDistribution.bajo++;
      fitBuckets[toBucket(s.fit_score)]++;
      intentBuckets[toBucket(s.intent_score)]++;
      overallBuckets[toBucket(s.overall_score)]++;
    }

    const scoreCount = allScores.length || 1;

    // ─── 6. EVENTS TIMELINE (daily counts, last 30 days) ───
    const dailyEvents: Record<string, number> = {};
    const eventTypes: Record<string, number> = {};
    for (const e of monthEvents) {
      const day = e.created_at.slice(0, 10);
      dailyEvents[day] = (dailyEvents[day] ?? 0) + 1;
      eventTypes[e.event_type] = (eventTypes[e.event_type] ?? 0) + 1;
    }

    // Fill missing days
    const dailyTimeline: Array<{ date: string; count: number }> = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      dailyTimeline.push({ date: d, count: dailyEvents[d] ?? 0 });
    }

    // DAU (daily active users last 7 days)
    const dauTimeline: Array<{ date: string; users: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const dayUsers = new Set(monthEvents.filter((e) => e.created_at.slice(0, 10) === d).map((e) => e.lead_id));
      dauTimeline.push({ date: d, users: dayUsers.size });
    }

    // ─── 7. VAULT ANALYTICS ───
    const vaultByType: Record<string, number> = {};
    const vaultByCapsule: Record<number, number> = {};
    for (const v of allVault) {
      vaultByType[v.content_type || "unknown"] = (vaultByType[v.content_type || "unknown"] ?? 0) + 1;
      const vCapsuleNum = capsuleNumberById.get(v.capsule_id) ?? 0;
      vaultByCapsule[vCapsuleNum] = (vaultByCapsule[vCapsuleNum] ?? 0) + 1;
    }

    // ─── 8. ENGAGEMENT ANALYTICS ───
    const engByJourney: Record<string, { sent: number; clicked: number; responded: number }> = {};
    for (const e of allEngagement) {
      const meta = e.metadata as { journey_name?: string; clicked?: boolean; responded?: boolean } | null;
      const j = meta?.journey_name ?? "unknown";
      if (!engByJourney[j]) engByJourney[j] = { sent: 0, clicked: 0, responded: 0 };
      if (e.status === "sent") engByJourney[j].sent++;
      if (meta?.clicked) engByJourney[j].clicked++;
      if (meta?.responded) engByJourney[j].responded++;
    }

    const engDailyTimeline: Array<{ date: string; sent: number }> = [];
    const engDailyMap: Record<string, number> = {};
    for (const e of allEngagement) {
      const day = e.created_at.slice(0, 10);
      engDailyMap[day] = (engDailyMap[day] ?? 0) + 1;
    }
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      engDailyTimeline.push({ date: d, sent: engDailyMap[d] ?? 0 });
    }

    const totalSent = allEngagement.filter((e) => e.status === "sent").length;
    const totalClicked = allEngagement.filter((e) => (e.metadata as { clicked?: boolean } | null)?.clicked === true).length;
    const totalResponded = allEngagement.filter((e) => (e.metadata as { responded?: boolean } | null)?.responded === true).length;
    const recentSent = recentEngagement.filter((e) => e.status === "sent").length;
    const recentClicked = recentEngagement.filter((e) => (e.metadata as { clicked?: boolean } | null)?.clicked === true).length;
    const recentResponded = recentEngagement.filter((e) => (e.metadata as { responded?: boolean } | null)?.responded === true).length;

    // ─── 9. USER SIGNUPS OVER TIME ───
    const signupsByWeek: Record<string, number> = {};
    for (const p of profiles) {
      if (!p.created_at) continue;
      const d = new Date(p.created_at);
      const weekStart = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
      const key = weekStart.toISOString().slice(0, 10);
      signupsByWeek[key] = (signupsByWeek[key] ?? 0) + 1;
    }

    // ─── 10. AI SUGGESTIONS ───
    const suggestions: Array<{ type: string; priority: string; message: string; data?: unknown }> = [];

    // Users about to churn
    const aboutToChurn = userDetails
      .filter((u) => u.status === "inactivo" && u.days_since_last_event >= 5 && u.days_since_last_event < 15 && u.capsules_completed > 0)
      .sort((a, b) => b.days_since_last_event - a.days_since_last_event);
    if (aboutToChurn.length > 0) {
      suggestions.push({
        type: "churn_risk",
        priority: "alta",
        message: `${aboutToChurn.length} usuarios activos estan perdiendo impulso (5-15 dias sin actividad). Contactarlos ahora puede prevenir el abandono.`,
        data: aboutToChurn.slice(0, 5).map((u) => ({ nombre: u.nombre, empresa: u.empresa, dias: u.days_since_last_event, capsulas: u.capsules_completed })),
      });
    }

    // Diagnosed but not started
    const diagnosedNotStarted = userDetails.filter((u) => u.has_assessment && u.capsules_completed === 0 && u.capsules_in_progress === 0);
    if (diagnosedNotStarted.length > 0) {
      suggestions.push({
        type: "conversion",
        priority: "alta",
        message: `${diagnosedNotStarted.length} usuarios completaron el diagnostico pero no empezaron ninguna capsula. Enviar bienvenida personalizada.`,
      });
    }

    // Capsule bottleneck
    const worstCapsule = capsuleAnalytics
      .filter((c) => c.in_progress > 0)
      .sort((a, b) => a.completion_rate - b.completion_rate)[0];
    if (worstCapsule && worstCapsule.completion_rate < 50) {
      suggestions.push({
        type: "content",
        priority: "media",
        message: `Capsula ${worstCapsule.numero} ("${worstCapsule.titulo}") tiene solo ${worstCapsule.completion_rate}% de completacion. Revisar contenido o dificultad.`,
      });
    }

    // Low vault output
    const usersLowVault = userDetails.filter((u) => u.capsules_completed >= 5 && u.vault_outputs < 2);
    if (usersLowVault.length > 0) {
      suggestions.push({
        type: "engagement",
        priority: "media",
        message: `${usersLowVault.length} usuarios avanzaron 5+ capsulas pero tienen pocos outputs en la Boveda. Motivar a usar los deliverables.`,
      });
    }

    // WhatsApp coverage
    const noWA = totalUsers - usersWithWA;
    if (noWA > 0 && totalUsers > 0) {
      suggestions.push({
        type: "reach",
        priority: noWA > totalUsers * 0.3 ? "alta" : "baja",
        message: `${noWA} usuarios (${Math.round((noWA / totalUsers) * 100)}%) no tienen WhatsApp registrado. No se les puede enviar mensajes.`,
      });
    }

    // ─── 11. BREAKDOWNS ───
    const planBreakdown: Record<string, number> = {};
    const industryBreakdown: Record<string, number> = {};
    const rolBreakdown: Record<string, number> = {};
    for (const p of profiles) {
      planBreakdown[p.temperature || "sin_plan"] = (planBreakdown[p.temperature || "sin_plan"] ?? 0) + 1;
      industryBreakdown[p.industry || "sin_industria"] = (industryBreakdown[p.industry || "sin_industria"] ?? 0) + 1;
      rolBreakdown[p.org_role || p.role || "user"] = (rolBreakdown[p.org_role || p.role || "user"] ?? 0) + 1;
    }

    // ─── RESPONSE ───
    jsonResponse(res, 200, {
      timestamp: new Date().toISOString(),
      kpis: {
        total_users: totalUsers,
        with_whatsapp: usersWithWA,
        opted_out: optedOut,
        active_this_week: weekActiveIds.size,
        diagnosed,
        active: activeUsers,
        inactive: inactiveUsers,
        critical: criticalUsers,
        graduated,
        avg_capsules_completed: avgCompletion,
        total_vault_outputs: allVault.length,
        total_assessments: allAssessments.length,
        total_events_30d: monthEvents.length,
      },
      funnel,
      users: userDetails.sort((a, b) => b.capsules_completed - a.capsules_completed),
      capsule_analytics: capsuleAnalytics,
      capsule_catalog: capsules.map((c) => ({ numero: c.number, titulo: c.title })),
      scores: {
        total: allScores.length,
        averages: { fit: Math.round(fitSum / scoreCount), intent: Math.round(intentSum / scoreCount), overall: Math.round(overallSum / scoreCount) },
        distribution: scoreDistribution,
        fit_histogram: fitBuckets,
        intent_histogram: intentBuckets,
        overall_histogram: overallBuckets,
        all_scores: allScores.map((s) => ({ user_id: s.lead_id, fit: s.fit_score, intent: s.intent_score, overall: s.overall_score })),
      },
      activity: {
        daily_events: dailyTimeline,
        dau: dauTimeline,
        event_types: eventTypes,
      },
      vault: {
        total: allVault.length,
        users_with_outputs: vaultByUser.size,
        by_type: vaultByType,
        by_capsule: vaultByCapsule,
      },
      engagement: {
        all_time: { sent: totalSent, clicked: totalClicked, responded: totalResponded, click_rate: totalSent > 0 ? Math.round((totalClicked / totalSent) * 1000) / 10 : 0, response_rate: totalSent > 0 ? Math.round((totalResponded / totalSent) * 1000) / 10 : 0 },
        last_7d: { sent: recentSent, clicked: recentClicked, responded: recentResponded },
        by_journey: engByJourney,
        daily_timeline: engDailyTimeline,
        recent_logs: recentEngagement.slice(0, 30),
      },
      breakdowns: { by_plan: planBreakdown, by_industry: industryBreakdown, by_rol: rolBreakdown },
      signups_by_week: Object.entries(signupsByWeek).sort(([a], [b]) => a.localeCompare(b)).map(([week, count]) => ({ week, count })),
      suggestions,
    });
  } catch (error) {
    logger.error({ error }, "Failed to build dashboard");
    jsonResponse(res, 500, { error: "Dashboard failed" });
  }
}

/**
 * GET /r/:logId — Click tracking redirect.
 *
 * Deep links in WhatsApp messages point here instead of directly to FIA Copilot.
 * When the user clicks, we mark clicked=true in engagement_log and redirect
 * to the real destination.
 *
 * Example: engine.axeljutoran.com/r/abc-123 → marks click → 302 → fiacopilot.com/capsulas/5
 */
async function handleClickRedirect(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  logId: string,
): Promise<void> {
  try {
    const supabase = getSupabaseClient();

    // Fetch the engagement log entry
    const { data: logEntry, error } = await supabase
      .from("engagement_log")
      .select("metadata")
      .eq("id", logId)
      .single();

    if (error || !logEntry) {
      // If not found, redirect to homepage
      res.writeHead(302, { Location: config.engine.appBaseUrl });
      res.end();
      return;
    }

    const logMeta = (logEntry.metadata as { deep_link?: string; clicked?: boolean } | null) ?? {};

    // Mark as clicked (fire-and-forget — redirect is not blocked by this)
    void supabase
      .from("engagement_log")
      .update({ metadata: { ...logMeta, clicked: true } })
      .eq("id", logId)
      .then(
        () => logger.info({ logId }, "Click tracked"),
        (err: unknown) => logger.error({ error: err, logId }, "Click tracking update failed"),
      );

    // Validate deep_link domain to prevent open redirect
    const allowedBase = config.engine.appBaseUrl;
    const destination = logMeta.deep_link?.startsWith(allowedBase)
      ? logMeta.deep_link
      : allowedBase;

    res.writeHead(302, { Location: destination });
    res.end();
  } catch (error) {
    logger.error({ error, logId }, "Click redirect failed");
    res.writeHead(302, { Location: config.engine.appBaseUrl });
    res.end();
  }
}

/**
 * GET /admin/stats — quality metrics for last 24h.
 * Requires Bearer token (ADMIN_API_TOKEN).
 */
async function handleAdminStats(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!requireAdminAuth(req, res)) return;
  try {
    const supabase = getSupabaseClient();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [logsRes, incomingRes] = await Promise.all([
      supabase.from("engagement_log").select("status, metadata, created_at").gte("created_at", since),
      supabase.from("wa_incoming_messages").select("created_at, resolved_user_id").gte("created_at", since),
    ]);

    const logs = (logsRes.data ?? []) as Array<{ status: string; metadata: { journey_name?: string; clicked?: boolean; responded?: boolean; recovered?: boolean } | null; created_at: string }>;
    const incoming = (incomingRes.data ?? []) as Array<{ created_at: string; resolved_user_id: string | null }>;

    const sent = logs.filter((l) => l.status === "sent").length;
    const failed = logs.filter((l) => l.status === "failed").length;
    const pendingRetry = logs.filter((l) => l.status === "failed_pending_retry").length;
    const skippedPaused = logs.filter((l) => l.status === "skipped_paused").length;
    const optedOut = logs.filter((l) => l.status === "opted_out").length;
    const recovered = logs.filter((l) => l.metadata?.recovered).length;
    const clicked = logs.filter((l) => l.metadata?.clicked).length;
    const responded = logs.filter((l) => l.metadata?.responded).length;

    const inboundReplies = logs.filter((l) => l.metadata?.journey_name === "inbound_ai_reply").length;
    const incomingTotal = incoming.length;
    const incomingResolved = incoming.filter((i) => i.resolved_user_id).length;
    const incomingUnresolved = incomingTotal - incomingResolved;

    // Group by journey
    const byJourney: Record<string, number> = {};
    for (const l of logs) {
      if (l.status !== "sent") continue;
      const j = l.metadata?.journey_name ?? "unknown";
      byJourney[j] = (byJourney[j] ?? 0) + 1;
    }

    jsonResponse(res, 200, {
      period: "last_24h",
      timestamp: new Date().toISOString(),
      outbound: {
        sent,
        failed_terminal: failed,
        failed_pending_retry: pendingRetry,
        skipped_paused: skippedPaused,
        opted_out: optedOut,
        recovered_via_retry: recovered,
        delivery_rate: (sent + failed) > 0 ? Math.round((sent / (sent + failed)) * 1000) / 10 : 100,
      },
      engagement: {
        click_rate: sent > 0 ? Math.round((clicked / sent) * 1000) / 10 : 0,
        response_rate: sent > 0 ? Math.round((responded / sent) * 1000) / 10 : 0,
        clicked,
        responded,
      },
      inbound: {
        messages_received: incomingTotal,
        resolved_to_user: incomingResolved,
        unresolved: incomingUnresolved,
        ai_replies_sent: inboundReplies,
      },
      by_journey: byJourney,
      whatsapp_provider: {
        primary: config.whatsapp.provider,
        fallback_configured: config.whatsapp.fallbackProvider || "none",
      },
    });
  } catch (error) {
    logger.error({ error }, "Failed to build admin stats");
    jsonResponse(res, 500, { error: "Stats failed" });
  }
}

// ─── Router ───

async function router(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = req.url?.split("?")[0] ?? "/";
  const method = req.method ?? "GET";

  // CORS — restrict to known origins
  const origin = req.headers["origin"];
  const allowedOrigins = [config.engine.appBaseUrl, config.engine.engineBaseUrl];
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url === "/health" && method === "GET") {
    return handleHealthCheck(req, res);
  }

  if (url === "/webhook/whatsapp" && method === "GET") {
    return handleWebhookVerify(req, res);
  }

  if (url === "/webhook/whatsapp" && method === "POST") {
    return handleWebhookIncoming(req, res);
  }

  if (url === "/webhook/whatsapp/evolution" && method === "POST") {
    return handleWebhookEvolution(req, res);
  }

  if (url === "/api/trigger" && method === "POST") {
    return handleManualTrigger(req, res);
  }

  if (url === "/api/test/message" && method === "POST") {
    return handleTestMessage(req, res);
  }

  if (url === "/api/engagement/stats" && method === "GET") {
    return handleEngagementStats(req, res);
  }

  if (url === "/api/engagement/logs" && method === "GET") {
    return handleEngagementLogs(req, res);
  }

  if (url === "/api/dashboard" && method === "GET") {
    return handleDashboard(req, res);
  }

  if (url === "/admin/stats" && method === "GET") {
    return handleAdminStats(req, res);
  }

  // Admin panel
  if (url === "/admin/engagement" && method === "GET") {
    const html = getAdminPanelHtml(config.engine.appBaseUrl);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // WhatsApp status API
  if (url === "/api/whatsapp/status" && method === "GET") {
    const codexReady = await isCodexAvailable();
    const provider = config.whatsapp.provider;
    const evolutionState = await evolutionManager.getStatus().catch(() => "unknown" as const);
    jsonResponse(res, 200, {
      provider,
      status: evolutionState === "open" ? "connected" : evolutionState,
      phone: null,
      qr_ready: false,
      codex_available: codexReady,
    });
    return;
  }

  // ─── Codex OAuth management ───

  // GET /admin/codex — web UI to manage Codex auth
  if (url === "/admin/codex" && method === "GET") {
    const available = await isCodexAvailable();
    let authInfo: { accountId?: string; expiresMs?: number } = {};
    try {
      const raw = fs.readFileSync(config.codex.authFilePath, "utf8");
      const parsed = JSON.parse(raw) as { tokens?: { access_token?: string; account_id?: string } };
      const token = parsed.tokens?.access_token ?? "";
      let exp: number | null = null;
      try {
        const payload = token.split(".")[1];
        const decoded = JSON.parse(Buffer.from(payload, "base64url").toString()) as { exp?: number };
        exp = decoded.exp ? decoded.exp * 1000 : null;
      } catch { /* bad token */ }
      authInfo = { accountId: parsed.tokens?.account_id, expiresMs: exp ?? undefined };
    } catch { /* not configured yet */ }

    const expiresDate = authInfo.expiresMs ? new Date(authInfo.expiresMs).toLocaleString("es-AR") : null;
    const isExpired = authInfo.expiresMs ? Date.now() > authInfo.expiresMs : false;

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codex OAuth — FIA Engine</title>
<style>
body{font-family:system-ui,sans-serif;background:#0a0b10;color:#e4e4ef;display:flex;flex-direction:column;align-items:center;padding:40px 16px;margin:0;gap:20px}
.card{background:#12131a;border:1px solid #2a2b3d;border-radius:12px;padding:28px 32px;max-width:520px;width:100%}
h1{font-size:20px;margin:0 0 4px}
.sub{font-size:13px;color:#9394a5;margin:0 0 24px}
.badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;margin-bottom:16px}
.ok{background:#166534;color:#4ade80}.warn{background:#854d0e;color:#facc15}.no{background:#991b1b;color:#fca5a5}
.info-row{display:flex;justify-content:space-between;font-size:13px;padding:8px 0;border-bottom:1px solid #2a2b3d}
.info-row:last-child{border:none}
.label{color:#9394a5}
.section{margin-top:24px}
.section-title{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#5d5e72;margin-bottom:12px;font-weight:700}
pre{background:#0a0b10;border:1px solid #2a2b3d;border-radius:8px;padding:14px;font-size:12px;overflow-x:auto;color:#a5b4fc;margin:12px 0;white-space:pre-wrap}
textarea{width:100%;background:#0a0b10;border:1px solid #2a2b3d;border-radius:8px;padding:12px;font-size:12px;color:#e4e4ef;font-family:monospace;min-height:140px;resize:vertical;box-sizing:border-box}
.btn{background:#6366f1;color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:13px;font-weight:600;cursor:pointer;margin-top:12px;width:100%}
.btn:hover{background:#4f46e5}
.btn-danger{background:#7f1d1d;margin-top:8px}
.btn-danger:hover{background:#991b1b}
.msg{padding:10px 14px;border-radius:8px;font-size:13px;margin-top:12px;display:none}
.msg.ok{background:#14532d;color:#4ade80;display:block}.msg.err{background:#7f1d1d;color:#fca5a5;display:block}
a{color:#818cf8}
</style>
</head>
<body>
<div class="card">
  <h1>🤖 Codex OAuth</h1>
  <p class="sub">ChatGPT Plus como generador de mensajes (sin costo por token)</p>

  <span class="badge ${available && !isExpired ? "ok" : isExpired ? "warn" : "no"}">
    ${available && !isExpired ? "✓ Conectado" : isExpired ? "⚠ Token vencido" : "✗ No configurado"}
  </span>

  ${available ? `
  <div>
    <div class="info-row"><span class="label">Cuenta</span><span>${authInfo.accountId ?? "—"}</span></div>
    <div class="info-row"><span class="label">Expira</span><span style="color:${isExpired ? "#fca5a5" : "#4ade80"}">${expiresDate ?? "—"}</span></div>
    <div class="info-row"><span class="label">Modelo</span><span>${config.codex.model}</span></div>
  </div>` : ""}

  <div class="section">
    <div class="section-title">Paso 1 — Obtené el auth.json en tu máquina local</div>
    <pre>npx @openai/codex login</pre>
    <p style="font-size:12px;color:#9394a5">Esto abre el navegador, inicia sesión con tu cuenta ChatGPT Plus, y guarda el token en <code style="color:#a5b4fc">~/.codex/auth.json</code></p>
  </div>

  <div class="section">
    <div class="section-title">Paso 2 — Pegá el contenido del auth.json acá</div>
    <textarea id="authJson" placeholder='{"type":"oauth","access":"...","refresh":"...","expires":...,"accountId":"..."}'></textarea>
    <button class="btn" onclick="uploadAuth()">Guardar y conectar</button>
    <div id="msg" class="msg"></div>
  </div>

  ${available ? `
  <div class="section">
    <button class="btn btn-danger" onclick="deleteAuth()">Desconectar Codex</button>
  </div>` : ""}

  <p style="margin-top:20px;font-size:11px;color:#5d5e72"><a href="/admin/engagement">← Dashboard</a></p>
</div>

<script>
const TOKEN = prompt('Admin token:') || '';

async function uploadAuth() {
  const raw = document.getElementById('authJson').value.trim();
  const msg = document.getElementById('msg');
  if (!raw) { showMsg('Pegá el contenido del auth.json', false); return; }
  try {
    JSON.parse(raw); // validate JSON
  } catch {
    showMsg('JSON inválido — revisá el contenido', false);
    return;
  }
  const resp = await fetch('/api/codex/auth', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth: raw }),
  });
  const data = await resp.json();
  if (resp.ok) {
    showMsg('✓ Conectado correctamente. Recargando...', true);
    setTimeout(() => location.reload(), 1500);
  } else {
    showMsg('Error: ' + (data.error || resp.status), false);
  }
}

async function deleteAuth() {
  if (!confirm('¿Desconectar Codex?')) return;
  const resp = await fetch('/api/codex/auth', {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + TOKEN },
  });
  if (resp.ok) location.reload();
}

function showMsg(text, ok) {
  const el = document.getElementById('msg');
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : 'err');
}
</script>
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // POST /api/codex/auth — save auth.json content (admin only)
  if (url === "/api/codex/auth" && method === "POST") {
    if (!requireAdminAuth(req, res)) return;
    try {
      const body = JSON.parse(await parseBody(req)) as { auth?: string };
      if (!body.auth) { jsonResponse(res, 400, { error: "Missing auth field" }); return; }
      const parsed = JSON.parse(body.auth) as { tokens?: { access_token?: string; refresh_token?: string } };
      if (!parsed.tokens?.access_token || !parsed.tokens?.refresh_token) {
        jsonResponse(res, 400, { error: "Invalid auth.json — missing tokens.access_token or tokens.refresh_token" });
        return;
      }
      fs.mkdirSync(require("path").dirname(config.codex.authFilePath), { recursive: true });
      fs.writeFileSync(config.codex.authFilePath, body.auth);
      invalidateCodexAuthCache();
      logger.info("Codex auth.json saved via admin UI");
      jsonResponse(res, 200, { status: "ok" });
    } catch (error) {
      jsonResponse(res, 400, { error: "Invalid JSON" });
    }
    return;
  }

  // DELETE /api/codex/auth — remove auth.json (admin only)
  if (url === "/api/codex/auth" && method === "DELETE") {
    if (!requireAdminAuth(req, res)) return;
    try {
      fs.unlinkSync(config.codex.authFilePath);
      invalidateCodexAuthCache();
      logger.info("Codex auth.json deleted via admin UI");
    } catch { /* already gone */ }
    jsonResponse(res, 200, { status: "deleted" });
    return;
  }

  // ─── Engine Config Management (Prompts, Templates, Responses) ───

  // GET /api/config — get all config keys (admin only)
  if (url === "/api/config" && method === "GET") {
    if (!requireAdminAuth(req, res)) return;
    try {
      const { getAllEngineConfig } = await import("./db/supabase");
      const allConfig = await getAllEngineConfig();
      jsonResponse(res, 200, { data: allConfig });
    } catch (error) {
      logger.error({ error }, "Failed to fetch engine config");
      jsonResponse(res, 500, { error: "Failed to fetch config" });
    }
    return;
  }

  // POST /api/config/seed-defaults — fill missing keys with code defaults + purge stale keys (admin only)
  // Query: ?overwrite=true to also overwrite existing values.
  if (url === "/api/config/seed-defaults" && method === "POST") {
    if (!requireAdminAuth(req, res)) return;
    try {
      const overwrite = new URL(req.url ?? "", "http://x").searchParams.get("overwrite") === "true";
      const { CONFIG_DEFAULTS, STALE_CONFIG_KEYS, STALE_CONFIG_PREFIXES } = await import("./config/engineConfigCache");
      const { getAllEngineConfig, deleteEngineConfig } = await import("./db/supabase");
      const existing = await getAllEngineConfig();

      const seeded: string[] = [];
      const skipped: string[] = [];
      for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
        const cur = existing[key];
        const isEmpty = cur === undefined || cur === "" || cur === "[]" || cur === "{}";
        if (!overwrite && !isEmpty) { skipped.push(key); continue; }
        await setCachedConfig(key, value);
        seeded.push(key);
      }

      const deleted: string[] = [];
      for (const key of Object.keys(existing)) {
        const isStale = STALE_CONFIG_KEYS.includes(key) || STALE_CONFIG_PREFIXES.some((p) => key.startsWith(p));
        if (isStale) { await deleteEngineConfig(key); deleted.push(key); }
      }

      logger.info({ seeded: seeded.length, deleted: deleted.length, skipped: skipped.length }, "Config defaults seeded");
      jsonResponse(res, 200, { status: "ok", seeded, deleted, skipped });
    } catch (error) {
      logger.error({ error }, "Failed to seed config defaults");
      jsonResponse(res, 500, { error: "Seed failed" });
    }
    return;
  }

  // GET /api/config/:key — get specific config key (admin only)
  const getConfigMatch = url.match(/^\/api\/config\/([a-zA-Z0-9._-]+)$/);
  if (getConfigMatch && method === "GET") {
    if (!requireAdminAuth(req, res)) return;
    try {
      const { getEngineConfig } = await import("./db/supabase");
      const key = getConfigMatch[1];
      const value = await getEngineConfig(key);
      if (value === null) {
        jsonResponse(res, 404, { error: "Config key not found" });
      } else {
        jsonResponse(res, 200, { key, value });
      }
    } catch (error) {
      logger.error({ error }, "Failed to fetch engine config key");
      jsonResponse(res, 500, { error: "Failed to fetch config" });
    }
    return;
  }

  // PUT /api/config/:key — update config key (admin only)
  const putConfigMatch = url.match(/^\/api\/config\/([a-zA-Z0-9._-]+)$/);
  if (putConfigMatch && method === "PUT") {
    if (!requireAdminAuth(req, res)) return;
    try {
      const body = JSON.parse(await parseBody(req)) as { value?: string };
      if (!body.value) {
        jsonResponse(res, 400, { error: "Missing value field" });
        return;
      }
      const key = putConfigMatch[1];
      const adminToken = req.headers["authorization"]?.replace("Bearer ", "");
      await setCachedConfig(key, body.value, adminToken ?? "unknown");
      logger.info({ key }, "Engine config updated via API");
      jsonResponse(res, 200, { status: "updated", key, value: body.value });
    } catch (error) {
      logger.error({ error }, "Failed to update engine config");
      jsonResponse(res, 500, { error: "Failed to update config" });
    }
    return;
  }

  // ─── Weekly report cadence (replaces the old broadcast scheduler) ───

  // GET /api/schedule — current weekly-report cron expression (admin only)
  if (url === "/api/schedule" && method === "GET") {
    if (!requireAdminAuth(req, res)) return;
    const schedule = await getReportSchedule();
    jsonResponse(res, 200, { data: { schedule } });
    return;
  }

  // PUT /api/schedule — set the weekly-report cron + reschedule live (admin only)
  if (url === "/api/schedule" && method === "PUT") {
    if (!requireAdminAuth(req, res)) return;
    try {
      const body = JSON.parse(await parseBody(req)) as { schedule?: string };
      const cronMod = await import("node-cron");
      if (!body.schedule || !cronMod.default.validate(body.schedule)) {
        jsonResponse(res, 400, { error: "Invalid cron expression" });
        return;
      }
      await setCachedConfig("report_schedule", body.schedule);
      const applied = await rescheduleWeeklyReport();
      jsonResponse(res, 200, { status: "updated", schedule: applied });
    } catch (error) {
      logger.error({ error }, "Failed to update report schedule");
      jsonResponse(res, 500, { error: "Internal error" });
    }
    return;
  }

  // ─── Observability API (Sofía conversation quality) ───

  // GET /api/observability/stats?days=30
  if (url === "/api/observability/stats" && method === "GET") {
    if (!requireAdminAuth(req, res)) return;
    const days = parseInt(new URL(req.url ?? "", "http://x").searchParams.get("days") ?? "30", 10);
    const { getObservabilityStats } = await import("./db/supabase");
    const stats = await getObservabilityStats(Number.isFinite(days) ? days : 30);
    jsonResponse(res, 200, { data: stats });
    return;
  }

  // GET /api/observability/threads?days=30&limit=100
  if (url === "/api/observability/threads" && method === "GET") {
    if (!requireAdminAuth(req, res)) return;
    const params = new URL(req.url ?? "", "http://x").searchParams;
    const days = parseInt(params.get("days") ?? "30", 10);
    const limit = parseInt(params.get("limit") ?? "100", 10);
    const { getConversationThreads } = await import("./db/supabase");
    const threads = await getConversationThreads(Number.isFinite(days) ? days : 30, Number.isFinite(limit) ? limit : 100);
    jsonResponse(res, 200, { data: threads });
    return;
  }

  // GET /api/observability/thread/:conversationId
  const threadMatch = url.match(/^\/api\/observability\/thread\/([a-f0-9-]+)$/);
  if (threadMatch && method === "GET") {
    if (!requireAdminAuth(req, res)) return;
    const { getThread } = await import("./db/supabase");
    const messages = await getThread(threadMatch[1] as string);
    jsonResponse(res, 200, { data: messages });
    return;
  }

  // POST /api/observability/classify — run the classification job now (admin only)
  if (url === "/api/observability/classify" && method === "POST") {
    if (!requireAdminAuth(req, res)) return;
    const { classifyRecentConversations } = await import("./jobs/classifyConversations");
    const result = await classifyRecentConversations();
    jsonResponse(res, 200, { status: "ok", ...result });
    return;
  }

  // ─── Groups (Sofía in WhatsApp groups) ───

  // GET /api/observability/groups — list groups with roster summary
  if (url === "/api/observability/groups" && method === "GET") {
    if (!requireAdminAuth(req, res)) return;
    const { getSofiaGroups, getGroupMembers } = await import("./db/supabase");
    const groups = await getSofiaGroups();
    const out = [];
    for (const g of groups) {
      const members = await getGroupMembers(g.group_jid);
      const student = members.find((m) => m.user_id === g.student_user_id) ?? members.find((m) => m.role === "student");
      out.push({
        group_jid: g.group_jid,
        conversation_id: g.conversation_id,
        label: g.label,
        student_user_id: g.student_user_id,
        student_name: student?.name ?? null,
        member_count: members.length,
        members,
      });
    }
    jsonResponse(res, 200, { data: out });
    return;
  }

  // GET /api/observability/group?jid=... — roster + message thread of one group
  if (url.startsWith("/api/observability/group") && method === "GET") {
    if (!requireAdminAuth(req, res)) return;
    const jid = new URL(req.url ?? "", "http://x").searchParams.get("jid") ?? "";
    if (!jid) { jsonResponse(res, 400, { error: "jid required" }); return; }
    const { getSofiaGroupRow, getGroupMembers, getThread } = await import("./db/supabase");
    const group = await getSofiaGroupRow(jid);
    const members = await getGroupMembers(jid);
    const messages = group ? await getThread(group.conversation_id) : [];
    jsonResponse(res, 200, { data: { group, members, messages } });
    return;
  }

  // POST /api/observability/group/sync — re-sync a group's roster now (body {jid})
  if (url === "/api/observability/group/sync" && method === "POST") {
    if (!requireAdminAuth(req, res)) return;
    try {
      const { jid } = JSON.parse(await parseBody(req)) as { jid?: string };
      if (!jid) { jsonResponse(res, 400, { error: "jid required" }); return; }
      const { getOrCreateSofiaGroup, updateSofiaGroupStudent } = await import("./db/supabase");
      const { syncGroupMembers } = await import("./senders/responses");
      await getOrCreateSofiaGroup(jid); // ensure the group row exists
      const studentId = await syncGroupMembers(jid);
      if (studentId) await updateSofiaGroupStudent(jid, studentId);
      jsonResponse(res, 200, { status: "ok", assignedStudent: studentId ?? null });
    } catch (error) {
      logger.error({ error }, "Group sync failed");
      jsonResponse(res, 500, { error: "Internal error" });
    }
    return;
  }

  // POST /api/observability/group/student — manually (re)assign a group's student (body {jid, userId})
  if (url === "/api/observability/group/student" && method === "POST") {
    if (!requireAdminAuth(req, res)) return;
    try {
      const { jid, userId } = JSON.parse(await parseBody(req)) as { jid?: string; userId?: string };
      if (!jid || !userId) { jsonResponse(res, 400, { error: "jid and userId required" }); return; }
      const { updateSofiaGroupStudent } = await import("./db/supabase");
      await updateSofiaGroupStudent(jid, userId);
      jsonResponse(res, 200, { status: "ok" });
    } catch (error) {
      logger.error({ error }, "Group student assign failed");
      jsonResponse(res, 500, { error: "Internal error" });
    }
    return;
  }

  // GET /admin/observability — conversation observability dashboard
  if (url === "/admin/observability" && method === "GET") {
    try {
      const { getObservabilityHtml } = await import("./admin/observability");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getObservabilityHtml());
    } catch (error) {
      logger.error({ error }, "Failed to serve observability dashboard");
      jsonResponse(res, 500, { error: "Failed to load observability dashboard" });
    }
    return;
  }

  // GET /api/variables — list all available template variables with metadata (admin only)
  if (url === "/api/variables" && method === "GET") {
    if (!requireAdminAuth(req, res)) return;
    const { ENGINE_VARIABLES } = await import("./config/engineVariables");
    jsonResponse(res, 200, { data: ENGINE_VARIABLES });
    return;
  }

  // GET /admin/config — config editor UI (admin only via prompt for token)
  if (url === "/admin/config" && method === "GET") {
    try {
      const { getConfigEditorHtml } = await import("./admin/config");
      const html = getConfigEditorHtml(config.engine.appBaseUrl);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (error) {
      logger.error({ error }, "Failed to serve config editor");
      jsonResponse(res, 500, { error: "Failed to load config editor" });
    }
    return;
  }

  // GET /admin/schedule — scheduled messages admin page
  if (url === "/admin/schedule" && method === "GET") {
    try {
      const { getScheduleAdminHtml } = await import("./admin/schedule");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getScheduleAdminHtml());
    } catch (error) {
      logger.error({ error }, "Failed to serve schedule admin page");
      jsonResponse(res, 500, { error: "Failed to load schedule admin" });
    }
    return;
  }

  // GET /admin/design — visual designer SPA (three-pane editor with WA preview)
  if (url === "/admin/design" && method === "GET") {
    try {
      const { getVisualDesignerHtml } = await import("./admin/designer");
      const html = getVisualDesignerHtml();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (error) {
      logger.error({ error }, "Failed to serve visual designer");
      jsonResponse(res, 500, { error: "Failed to load visual designer" });
    }
    return;
  }

  // Click tracking: /r/:logId
  const clickMatch = url.match(/^\/r\/([a-f0-9-]+)$/);
  if (clickMatch && method === "GET") {
    return handleClickRedirect(req, res, clickMatch[1]);
  }

  // POST /api/activate-sofia — activates Sofía for a user and sends the welcome message.
  // Called by FIA Copilot frontend when the user clicks "Activar Sofía".
  // Auth: ADMIN_API_TOKEN (for testing) OR any request with a matching userId+email pair
  // verified against Supabase (email must match the profile on record).
  if (url === "/api/activate-sofia" && method === "POST") {
    try {
      const body = JSON.parse(await parseBody(req)) as { userId?: string; email?: string };
      if (!body.userId || !body.email) {
        jsonResponse(res, 400, { error: "Missing required fields: userId, email" });
        return;
      }

      const supabase = getSupabaseClient();

      // Verify the user exists and the email matches — this is the identity check
      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("id, name, email, phone, whatsapp_opt_in")
        .eq("id", body.userId)
        .single();

      if (profileError || !profile) {
        jsonResponse(res, 404, { error: "User not found" });
        return;
      }

      // Email verification: must match what's in the DB
      if ((profile.email as string).toLowerCase() !== body.email.toLowerCase()) {
        logger.warn({ userId: body.userId }, "activate-sofia: email mismatch — possible spoofing attempt");
        jsonResponse(res, 403, { error: "Email does not match user record" });
        return;
      }

      if (!profile.phone) {
        jsonResponse(res, 422, { error: "no_phone", message: "El usuario no tiene número de teléfono registrado" });
        return;
      }

      if (!profile.whatsapp_opt_in) {
        jsonResponse(res, 422, { error: "not_opted_in", message: "El usuario no tiene WhatsApp activado" });
        return;
      }

      // Build the welcome message (configurable from /admin/config)
      const { getActivationWelcomeMessage } = await import("./config/engineConfigCache");
      const welcomeTemplate = await getActivationWelcomeMessage();
      const welcomeMessage = welcomeTemplate
        .replace(/\{\{nombre\}\}/g, (profile.name as string | null) ?? "ahí");

      // Check pilot mode — sendCampaignMessage enforces it internally
      const { sendCampaignMessage } = await import("./senders/whatsapp");
      const sent = await sendCampaignMessage(
        profile.phone as string,
        profile.id as string,
        welcomeMessage,
        "activacion_sofia",
      );

      // Override the trigger_type in the log to 'activation' (sendCampaignMessage logs 'campaign')
      // We do this via a separate log insert with the correct type
      const { insertEngagementLog } = await import("./db/supabase");
      await insertEngagementLog({
        lead_id: profile.id as string,
        status: sent ? "sent" : "failed",
        message: welcomeMessage,
        channel: "whatsapp",
        trigger_type: "activation",
        metadata: {
          journey_name: "activacion_sofia",
          whatsapp_number: (profile.phone as string).replace(/\D/g, ""),
          deep_link: config.engine.appBaseUrl,
        },
      });

      if (sent) {
        logger.info({ userId: profile.id, phone: (profile.phone as string).replace(/\D/g, "").slice(-4) + "****" }, "Sofía activation message sent");
        jsonResponse(res, 200, { ok: true, message: "Mensaje de activación enviado" });
      } else {
        logger.warn({ userId: profile.id }, "Sofía activation: message send failed (pilot mode or provider error)");
        jsonResponse(res, 200, { ok: false, message: "No se pudo enviar el mensaje — verificá el modo piloto o el número" });
      }
    } catch (error) {
      logger.error({ error }, "Failed to activate sofia for user");
      jsonResponse(res, 500, { error: "Activation failed" });
    }
    return;
  }

  // GET /api/sofia/features — Sofia feature registry (public; no auth required)
  // ?status=live|beta|planned|deprecated|all (default: live)
  // Used by FIACO Pilot for context, developers as reference, landing page for copy.
  if (url.startsWith("/api/sofia/features") && method === "GET") {
    try {
      const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const statusParam = parsedUrl.searchParams.get("status");
      const filter = statusParam === "all" ? undefined : (statusParam ?? "live");
      const features = await getSofiaFeatures(filter);
      jsonResponse(res, 200, {
        features,
        count: features.length,
        filter: filter ?? "all",
        generated_at: new Date().toISOString(),
      });
    } catch (error) {
      logger.error({ error }, "Failed to fetch sofia features");
      jsonResponse(res, 500, { error: "Failed to fetch features" });
    }
    return;
  }

  jsonResponse(res, 404, { error: "Not found" });
}

export function startServer(port: number = 3001): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      await router(req, res);
    } catch (error) {
      logger.error({ error, url: req.url }, "Unhandled server error");
      jsonResponse(res, 500, { error: "Internal server error" });
    }
  });

  server.listen(port, "0.0.0.0", () => {
    logger.info({ port }, "FIA Engagement Engine HTTP server started");
    // Warm up config cache on startup (non-blocking)
    void warmCache();
  });

  return server;
}
