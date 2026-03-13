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
 * GET /api/dashboard — Full platform data for CEO/Coaches dashboard.
 * Queries ALL tables, returns comprehensive analytics.
 */
async function handleDashboard(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
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
    ] = await Promise.all([
      supabase.from("profiles").select("*"),
      supabase.from("capsules").select("*").order("numero", { ascending: true }),
      supabase.from("capsule_progress").select("*"),
      supabase.from("events").select("*").order("created_at", { ascending: false }).limit(500),
      supabase.from("events").select("user_id, event_type, metadata, created_at").gte("created_at", monthAgo).order("created_at", { ascending: false }),
      supabase.from("lead_scores").select("*"),
      supabase.from("vault_outputs").select("*").order("created_at", { ascending: false }),
      supabase.from("assessment_submissions").select("*").order("created_at", { ascending: false }),
      supabase.from("engagement_log").select("*").order("created_at", { ascending: false }),
      supabase.from("engagement_log").select("*").gte("created_at", weekAgo).order("created_at", { ascending: false }),
    ]);

    const profiles = profilesRes.data ?? [];
    const capsules = capsulesRes.data ?? [];
    const allProgress = capsuleProgressRes.data ?? [];
    const allEvents = eventsAllRes.data ?? [];
    const monthEvents = eventsMonthRes.data ?? [];
    const allScores = leadScoresRes.data ?? [];
    const allVault = vaultRes.data ?? [];
    const allAssessments = assessmentsRes.data ?? [];
    const allEngagement = engagementAllRes.data ?? [];
    const recentEngagement = engagementRecentRes.data ?? [];

    // ─── INDEX data for fast lookups ───
    const scoresByUser = new Map<string, { fit_score: number; intent_score: number; overall_score: number }>();
    for (const s of allScores) scoresByUser.set(s.user_id, s);

    const progressByUser = new Map<string, typeof allProgress>();
    for (const p of allProgress) {
      const arr = progressByUser.get(p.user_id) ?? [];
      arr.push(p);
      progressByUser.set(p.user_id, arr);
    }

    const vaultByUser = new Map<string, typeof allVault>();
    for (const v of allVault) {
      const arr = vaultByUser.get(v.user_id) ?? [];
      arr.push(v);
      vaultByUser.set(v.user_id, arr);
    }

    const eventsByUser = new Map<string, typeof allEvents>();
    for (const e of allEvents) {
      const arr = eventsByUser.get(e.user_id) ?? [];
      arr.push(e);
      eventsByUser.set(e.user_id, arr);
    }

    const assessmentByUser = new Map<string, typeof allAssessments[0]>();
    for (const a of allAssessments) {
      if (!assessmentByUser.has(a.user_id)) assessmentByUser.set(a.user_id, a);
    }

    // ─── 1. PER-USER DETAIL TABLE ───
    const userDetails = profiles.map((p) => {
      const userProg = progressByUser.get(p.id) ?? [];
      const completedCaps = userProg.filter((c) => c.status === "completed").length;
      const inProgressCaps = userProg.filter((c) => c.status === "started" || c.status === "in_progress");
      const userEvents = eventsByUser.get(p.id) ?? [];
      const lastEvent = userEvents[0];
      const daysSinceLastEvent = lastEvent
        ? Math.floor((now - new Date(lastEvent.created_at).getTime()) / (1000 * 60 * 60 * 24))
        : -1;
      const score = scoresByUser.get(p.id);
      const vaultCount = (vaultByUser.get(p.id) ?? []).length;
      const hasAssessment = assessmentByUser.has(p.id);
      const userEngagement = allEngagement.filter((e) => e.user_id === p.id);

      let status = "registrado";
      if (completedCaps >= 25) status = "graduado";
      else if (completedCaps > 0 || inProgressCaps.length > 0) status = "activo";
      else if (hasAssessment) status = "diagnosticado";

      if (status === "activo" && daysSinceLastEvent > 15) status = "inactivo_critico";
      else if (status === "activo" && daysSinceLastEvent > 5) status = "inactivo";

      return {
        id: p.id,
        nombre: p.nombre || "Sin nombre",
        email: p.email || "",
        empresa: p.empresa || "Sin empresa",
        industria: p.industria || "Sin industria",
        plan: p.plan || "sin_plan",
        rol: p.rol || "user",
        whatsapp: p.whatsapp ? "si" : "no",
        wp_opted_out: p.wp_opted_out || false,
        created_at: p.created_at,
        status,
        capsules_completed: completedCaps,
        capsules_in_progress: inProgressCaps.length,
        current_capsule: inProgressCaps[0]?.capsule_numero ?? (completedCaps + 1),
        days_since_last_event: daysSinceLastEvent,
        last_event_type: lastEvent?.event_type ?? null,
        overall_score: score?.overall_score ?? null,
        fit_score: score?.fit_score ?? null,
        intent_score: score?.intent_score ?? null,
        vault_outputs: vaultCount,
        has_assessment: hasAssessment,
        messages_received: userEngagement.length,
        messages_clicked: userEngagement.filter((e) => e.clicked).length,
        messages_responded: userEngagement.filter((e) => e.responded).length,
        objetivo: p.objetivo || "",
      };
    });

    // ─── 2. KPI SUMMARY ───
    const totalUsers = profiles.length;
    const usersWithWA = profiles.filter((p) => p.whatsapp).length;
    const optedOut = profiles.filter((p) => p.wp_opted_out).length;
    const weekActiveIds = new Set(monthEvents.filter((e) => e.created_at >= weekAgo).map((e) => e.user_id));
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

    // ─── 4. PER-CAPSULE ANALYTICS (all 25) ───
    const capsuleAnalytics = [];
    for (let num = 1; num <= 25; num++) {
      const capsuleInfo = capsules.find((c) => c.numero === num);
      const progressForCap = allProgress.filter((p) => p.capsule_numero === num);
      const completedCount = progressForCap.filter((p) => p.status === "completed").length;
      const startedCount = progressForCap.filter((p) => p.status === "started" || p.status === "in_progress").length;
      const vaultForCap = allVault.filter((v) => v.capsule_numero === num);
      const completionRate = (completedCount + startedCount) > 0
        ? Math.round((completedCount / (completedCount + startedCount)) * 100)
        : 0;

      capsuleAnalytics.push({
        numero: num,
        titulo: capsuleInfo?.titulo ?? `Capsula ${num}`,
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
      const dayUsers = new Set(monthEvents.filter((e) => e.created_at.slice(0, 10) === d).map((e) => e.user_id));
      dauTimeline.push({ date: d, users: dayUsers.size });
    }

    // ─── 7. VAULT ANALYTICS ───
    const vaultByType: Record<string, number> = {};
    const vaultByCapsule: Record<number, number> = {};
    for (const v of allVault) {
      vaultByType[v.content_type || "unknown"] = (vaultByType[v.content_type || "unknown"] ?? 0) + 1;
      vaultByCapsule[v.capsule_numero] = (vaultByCapsule[v.capsule_numero] ?? 0) + 1;
    }

    // ─── 8. ENGAGEMENT ANALYTICS ───
    const engByJourney: Record<string, { sent: number; clicked: number; responded: number }> = {};
    for (const e of allEngagement) {
      const j = e.journey_name;
      if (!engByJourney[j]) engByJourney[j] = { sent: 0, clicked: 0, responded: 0 };
      if (e.status === "sent") engByJourney[j].sent++;
      if (e.clicked) engByJourney[j].clicked++;
      if (e.responded) engByJourney[j].responded++;
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
    const totalClicked = allEngagement.filter((e) => e.clicked).length;
    const totalResponded = allEngagement.filter((e) => e.responded).length;
    const recentSent = recentEngagement.filter((e) => e.status === "sent").length;
    const recentClicked = recentEngagement.filter((e) => e.clicked).length;
    const recentResponded = recentEngagement.filter((e) => e.responded).length;

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
      planBreakdown[p.plan || "sin_plan"] = (planBreakdown[p.plan || "sin_plan"] ?? 0) + 1;
      industryBreakdown[p.industria || "sin_industria"] = (industryBreakdown[p.industria || "sin_industria"] ?? 0) + 1;
      rolBreakdown[p.rol || "user"] = (rolBreakdown[p.rol || "user"] ?? 0) + 1;
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
      capsule_catalog: capsules.map((c) => ({ numero: c.numero, titulo: c.titulo })),
      scores: {
        total: allScores.length,
        averages: { fit: Math.round(fitSum / scoreCount), intent: Math.round(intentSum / scoreCount), overall: Math.round(overallSum / scoreCount) },
        distribution: scoreDistribution,
        fit_histogram: fitBuckets,
        intent_histogram: intentBuckets,
        overall_histogram: overallBuckets,
        all_scores: allScores.map((s) => ({ user_id: s.user_id, fit: s.fit_score, intent: s.intent_score, overall: s.overall_score })),
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
