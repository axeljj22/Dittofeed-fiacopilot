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
import { getSupabaseClient } from "./db/supabase";
import { runAllDetectors, runSponsorReports } from "./orchestrator";
import { getAdminPanelHtml } from "./admin/panel";

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

// ─── Route handlers ───

async function handleHealthCheck(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  jsonResponse(res, 200, {
    status: "ok",
    service: "fia-engagement-engine",
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
 * POST /api/trigger — manually run detectors (admin only)
 */
async function handleManualTrigger(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const authHeader = req.headers["authorization"];
  const expectedToken = process.env["ADMIN_API_TOKEN"] ?? "admin-secret";

  if (authHeader !== `Bearer ${expectedToken}`) {
    jsonResponse(res, 401, { error: "Unauthorized" });
    return;
  }

  try {
    const body = JSON.parse(await parseBody(req));
    const detector = body.detector ?? "all";

    if (detector === "sponsor") {
      await runSponsorReports();
    } else {
      await runAllDetectors();
    }

    jsonResponse(res, 200, { status: "triggered", detector });
  } catch (error) {
    logger.error({ error }, "Manual trigger failed");
    jsonResponse(res, 500, { error: "Trigger failed" });
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
          .eq("clicked", true)
          .gte("created_at", weekAgo),
        supabase
          .from("engagement_log")
          .select("*", { count: "exact", head: true })
          .eq("responded", true)
          .gte("created_at", weekAgo),
        supabase
          .from("profiles")
          .select("*", { count: "exact", head: true })
          .eq("wp_opted_out", true),
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
      query = query.eq("user_id", userId);
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
 * GET /api/dashboard — Full platform overview for CEO/Coaches
 */
async function handleDashboard(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

    // Parallel queries for maximum speed
    const [
      profilesRes,
      profilesWithWARes,
      optedOutRes,
      capsuleProgressRes,
      eventsRecentRes,
      leadScoresRes,
      engagementSentRes,
      engagementClickedRes,
      engagementRespondedRes,
      vaultRes,
    ] = await Promise.all([
      supabase.from("profiles").select("id, nombre, empresa, industria, plan, rol, created_at"),
      supabase.from("profiles").select("id, nombre, empresa, whatsapp").not("whatsapp", "is", null),
      supabase.from("profiles").select("*", { count: "exact", head: true }).eq("wp_opted_out", true),
      supabase.from("capsule_progress").select("user_id, capsule_numero, status, updated_at"),
      supabase.from("events").select("user_id, event_type, created_at").gte("created_at", weekAgo).order("created_at", { ascending: false }).limit(100),
      supabase.from("lead_scores").select("user_id, fit_score, intent_score, overall_score"),
      supabase.from("engagement_log").select("*", { count: "exact", head: true }).eq("status", "sent").gte("created_at", weekAgo),
      supabase.from("engagement_log").select("*", { count: "exact", head: true }).eq("clicked", true).gte("created_at", weekAgo),
      supabase.from("engagement_log").select("*", { count: "exact", head: true }).eq("responded", true).gte("created_at", weekAgo),
      supabase.from("vault_outputs").select("user_id, capsule_numero, created_at").order("created_at", { ascending: false }).limit(200),
    ]);

    const profiles = profilesRes.data ?? [];
    const progress = capsuleProgressRes.data ?? [];
    const events = eventsRecentRes.data ?? [];
    const scores = leadScoresRes.data ?? [];
    const vaultOutputs = vaultRes.data ?? [];

    // ─── Users overview ───
    const totalUsers = profiles.length;
    const usersWithWA = (profilesWithWARes.data ?? []).length;
    const planBreakdown: Record<string, number> = {};
    const industryBreakdown: Record<string, number> = {};
    for (const p of profiles) {
      planBreakdown[p.plan || "sin_plan"] = (planBreakdown[p.plan || "sin_plan"] ?? 0) + 1;
      industryBreakdown[p.industria || "sin_industria"] = (industryBreakdown[p.industria || "sin_industria"] ?? 0) + 1;
    }

    // ─── Active vs inactive users ───
    const activeUserIds = new Set(events.map(e => e.user_id));
    const activeUsersCount = activeUserIds.size;

    // ─── Capsule progress analysis ───
    const progressByUser = new Map<string, typeof progress>();
    for (const p of progress) {
      const arr = progressByUser.get(p.user_id) ?? [];
      arr.push(p);
      progressByUser.set(p.user_id, arr);
    }

    let usersNotStarted = 0;
    let usersInProgress = 0;
    let usersCompleted = 0;
    const capsuleBottlenecks: Record<number, number> = {};
    const stuckUsers: Array<{ userId: string; nombre: string; empresa: string; capsule: number; daysSinceUpdate: number }> = [];

    for (const profile of profiles) {
      const userProgress = progressByUser.get(profile.id);
      if (!userProgress || userProgress.length === 0) {
        usersNotStarted++;
        continue;
      }

      const completed = userProgress.filter(p => p.status === "completed").length;
      if (completed >= 25) {
        usersCompleted++;
        continue;
      }
      usersInProgress++;

      // Find stuck capsules
      const pending = userProgress.filter(p => p.status === "started" || p.status === "in_progress");
      for (const p of pending) {
        capsuleBottlenecks[p.capsule_numero] = (capsuleBottlenecks[p.capsule_numero] ?? 0) + 1;
        const daysSince = Math.floor((Date.now() - new Date(p.updated_at).getTime()) / (1000 * 60 * 60 * 24));
        if (daysSince >= 5) {
          stuckUsers.push({
            userId: profile.id,
            nombre: profile.nombre,
            empresa: profile.empresa,
            capsule: p.capsule_numero,
            daysSinceUpdate: daysSince,
          });
        }
      }
    }

    // Sort stuck users by days (worst first)
    stuckUsers.sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate);

    // ─── Scores distribution ───
    const scoreRanges = { alto: 0, medio: 0, bajo: 0 };
    const avgScores = { fit: 0, intent: 0, overall: 0 };
    if (scores.length > 0) {
      for (const s of scores) {
        avgScores.fit += s.fit_score;
        avgScores.intent += s.intent_score;
        avgScores.overall += s.overall_score;
        if (s.overall_score >= 70) scoreRanges.alto++;
        else if (s.overall_score >= 40) scoreRanges.medio++;
        else scoreRanges.bajo++;
      }
      avgScores.fit = Math.round(avgScores.fit / scores.length);
      avgScores.intent = Math.round(avgScores.intent / scores.length);
      avgScores.overall = Math.round(avgScores.overall / scores.length);
    }

    // ─── Recent events timeline ───
    const eventsByType: Record<string, number> = {};
    for (const e of events) {
      eventsByType[e.event_type] = (eventsByType[e.event_type] ?? 0) + 1;
    }

    // ─── Vault productivity ───
    const usersWithOutputs = new Set(vaultOutputs.map(v => v.user_id)).size;

    // ─── Engagement stats ───
    const msgSent = engagementSentRes.count ?? 0;
    const msgClicked = engagementClickedRes.count ?? 0;
    const msgResponded = engagementRespondedRes.count ?? 0;

    jsonResponse(res, 200, {
      timestamp: new Date().toISOString(),
      users: {
        total: totalUsers,
        with_whatsapp: usersWithWA,
        opted_out: optedOutRes.count ?? 0,
        active_this_week: activeUsersCount,
        inactive: totalUsers - activeUsersCount,
        by_plan: planBreakdown,
        by_industry: industryBreakdown,
      },
      funnel: {
        not_started: usersNotStarted,
        in_progress: usersInProgress,
        completed_all_25: usersCompleted,
      },
      capsules: {
        bottlenecks: Object.entries(capsuleBottlenecks)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 10)
          .map(([num, count]) => ({ capsule: parseInt(num), stuck_users: count })),
      },
      risk: {
        stuck_users: stuckUsers.slice(0, 20),
        total_at_risk: stuckUsers.length,
      },
      scores: {
        total_assessed: scores.length,
        averages: avgScores,
        distribution: scoreRanges,
      },
      activity: {
        events_this_week: events.length,
        by_type: eventsByType,
      },
      vault: {
        total_outputs: vaultOutputs.length,
        users_with_outputs: usersWithOutputs,
      },
      engagement: {
        messages_sent_7d: msgSent,
        click_rate: msgSent > 0 ? Math.round((msgClicked / msgSent) * 1000) / 10 : 0,
        response_rate: msgSent > 0 ? Math.round((msgResponded / msgSent) * 1000) / 10 : 0,
      },
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
      .select("deep_link")
      .eq("id", logId)
      .single();

    if (error || !logEntry) {
      // If not found, redirect to homepage
      res.writeHead(302, { Location: config.engine.appBaseUrl });
      res.end();
      return;
    }

    // Mark as clicked (fire-and-forget)
    supabase
      .from("engagement_log")
      .update({ clicked: true })
      .eq("id", logId)
      .then(() => {
        logger.info({ logId }, "Click tracked");
      });

    // Redirect to actual destination
    res.writeHead(302, { Location: logEntry.deep_link });
    res.end();
  } catch (error) {
    logger.error({ error, logId }, "Click redirect failed");
    res.writeHead(302, { Location: config.engine.appBaseUrl });
    res.end();
  }
}

// ─── Router ───

async function router(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = req.url?.split("?")[0] ?? "/";
  const method = req.method ?? "GET";

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
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

  if (url === "/api/trigger" && method === "POST") {
    return handleManualTrigger(req, res);
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

  // Admin panel
  if (url === "/admin/engagement" && method === "GET") {
    const html = getAdminPanelHtml(config.engine.appBaseUrl);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // Click tracking: /r/:logId
  const clickMatch = url.match(/^\/r\/([a-f0-9-]+)$/);
  if (clickMatch && method === "GET") {
    return handleClickRedirect(req, res, clickMatch[1]);
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
  });

  return server;
}
