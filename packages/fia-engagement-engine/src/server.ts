/**
 * HTTP server for:
 * 1. Incoming WhatsApp webhook responses
 * 2. Admin engagement API (stats, logs)
 * 3. Health check
 * 4. Manual trigger endpoint
 */
import http from "http";
import { config } from "./config";
import { logger } from "./logger";
import { processIncomingResponse } from "./senders/responses";
import { sendWhatsAppMessage } from "./senders/whatsapp";
import { getSupabaseClient } from "./db/supabase";
import { runAllDetectors, runSponsorReports } from "./orchestrator";

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
