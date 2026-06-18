/**
 * Bidirectional response handler.
 *
 * Processes incoming WhatsApp replies and takes action:
 * - STOP / PARAR → opt out
 * - SI / RETOMAR → log reactivation
 * - AYUDA / HELP → reply with help link
 * - VENTAS → link to upgrade/FIA Ventas page
 * - DIAGNOSTICO → link to diagnostic results
 * - PERFIL → link to user profile
 * - PUNTOS → fetch and reply with current lead score
 * - Anything else → AI reply (Sofía) with segmentation, rate limiting, loop detection
 */
import { config } from "../config";
import { logger } from "../logger";
import {
  getSupabaseClient,
  getLeadScoreForUser,
  insertIncomingMessage,
  getUserSegment,
  getConversationState,
  upsertConversationState,
  deactivateSofia,
  logConversation,
} from "../db/supabase";
import { getCommandReply } from "../config/engineConfigCache";
import { generateInboundReply } from "../generators/messageGenerator";

export interface IncomingMessage {
  from: string; // WhatsApp number
  body: string;
  messageId?: string;
}

export interface ResponseAction {
  type: "opt_out" | "reactivation" | "help" | "ventas" | "diagnostico" | "perfil" | "puntos" | "default";
  replyText: string;
  updateProfile?: Record<string, unknown>;
  logEvent?: string;
}

/** Mensaje para números no registrados en FIA Copilot */
const UNREGISTERED_MESSAGE =
  `Hola! Para recibir mensajes de Sofía necesitás registrarte en FIA Copilot ` +
  `y agregar tu número de WhatsApp en Ajustes: ${config.engine.appBaseUrl}/ajustes`;

/** Fallback message for low-engagement loop close (overridable via /admin/config key: cmd_reply.low_engagement_close) */
const LOW_ENGAGEMENT_CLOSE_DEFAULT = `Cuando quieras retomar estoy acá. Tu dashboard: ${config.engine.appBaseUrl}/dashboard`;

/** Respuestas cortas con intención clara — no silenciar aunque sean breves */
const POSITIVE_SHORT_RESPONSES = new Set([
  // Afirmaciones
  "si", "sí", "dale", "ok", "okay", "bueno", "buenas", "claro", "bien", "listo", "va", "vamos",
  // Curiosidad / interés
  "me interesa", "contame", "quiero", "cómo", "como", "cuando", "cuándo", "que", "qué",
  "donde", "dónde", "porque", "porqué", "por qué",
  // Agradecimiento
  "gracias", "muchas gracias", "graci", "gracis", "thx",
  // Apreciación
  "genial", "perfecto", "entendido", "excelente", "buenísimo", "buenisimo",
  "bárbaro", "barbaro", "piola", "copado", "interesante", "buena", "buenaza",
  // Continuidad
  "adelante", "seguí", "segui", "contá", "conta", "me llama la atención",
  // Confusión / ayuda (NO silenciar — son señales de que necesita guía)
  "no entiendo", "no se", "no sé", "no comprendo", "explicame", "explicá", "explica",
  "ayuda", "help", "como hago", "cómo hago", "y eso", "y entonces",
  // Estados
  "ahora no", "después", "despues", "más tarde", "mas tarde", "luego",
  // Saludos
  "hola", "buenas", "holi", "ey", "hey", "buen día", "buen dia",
  "buenos días", "buenas tardes", "buenas noches",
  // Despedidas
  "chau", "nos vemos", "hasta luego", "saludos",
]);

/** ¿El mensaje es de baja calidad? Solo lo verdaderamente vacío — WhatsApp es naturalmente corto */
function isLowEngagement(body: string): boolean {
  const normalized = body.trim().toLowerCase();
  if (POSITIVE_SHORT_RESPONSES.has(normalized)) return false;
  // Si tiene ?, ! o emoji, hay intención
  if (/[?!¿¡]/.test(body)) return false;
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(body)) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  // Subido de <3 a <2: solo mensajes de UNA palabra sin marcadores cuentan como bajo
  return words.length < 2;
}

export function classifyResponse(body: string): ResponseAction {
  const normalized = body.trim().toUpperCase();

  // Opt-out: STOP / PARAR
  if (normalized === "STOP" || normalized === "PARAR") {
    return {
      type: "opt_out",
      replyText:
        "Listo, no recibirás más mensajes de seguimiento. Si en algún momento querés retomar, respondé SI.",
      updateProfile: { whatsapp_opt_in: false },
    };
  }

  // Reactivation: SI / SÍ / RETOMAR
  if (normalized === "SI" || normalized === "SÍ" || normalized === "RETOMAR") {
    return {
      type: "reactivation",
      replyText: `¡Genial! Tu progreso te espera: ${config.engine.appBaseUrl}/dashboard`,
      logEvent: "reactivacion_confirmada",
    };
  }

  // Help: AYUDA / HELP
  if (normalized === "AYUDA" || normalized === "HELP") {
    return {
      type: "help",
      replyText: `Agendá una llamada con el equipo acá: ${config.engine.appBaseUrl}/agendar`,
    };
  }

  // FIA Ventas / upgrade
  if (normalized === "VENTAS") {
    return {
      type: "ventas",
      replyText: `Mirá todo lo que incluye FIA Ventas acá: ${config.engine.appBaseUrl}/upgrade?ref=wa_ventas`,
    };
  }

  // Diagnostic results
  if (normalized === "DIAGNOSTICO") {
    return {
      type: "diagnostico",
      replyText: `Tus resultados del diagnóstico están acá: ${config.engine.appBaseUrl}/diagnostico`,
    };
  }

  // User profile
  if (normalized === "PERFIL") {
    return {
      type: "perfil",
      replyText: `Editá tu perfil desde acá: ${config.engine.appBaseUrl}/perfil`,
    };
  }

  // Lead score — reply text is enriched in processIncomingResponse once we have the userId
  if (normalized === "PUNTOS") {
    return {
      type: "puntos",
      replyText: `Tu score de FIA está disponible en tu dashboard: ${config.engine.appBaseUrl}/dashboard`,
    };
  }

  return {
    type: "default",
    replyText: "",
  };
}

/**
 * Process an incoming WhatsApp response.
 * Returns the reply text to send back (empty string = no reply / silence).
 */
export async function processIncomingResponse(
  message: IncomingMessage,
): Promise<ResponseAction> {
  const normalizedFrom = message.from.replace(/\D/g, "");

  // ── 1. Classify message ──────────────────────────────────────────────────
  let classified = classifyResponse(message.body);

  // ── 2. Look up profile ──────────────────────────────────────────────────
  // Try both "5491125120212" and "+5491125120212" — apps may store either format.
  const { data: profile } = await getSupabaseClient()
    .from("profiles")
    .select("id, whatsapp_opt_in, wp_opted_out")
    .or(`phone.eq.${normalizedFrom},phone.eq.+${normalizedFrom}`)
    .maybeSingle();

  if (!profile) {
    // Silenciar — no enviar UNREGISTERED_MESSAGE. Si alguien escribe y no está
    // en la DB, probablemente fue alguien que recibió un mensaje nuestro (piloto)
    // cuyo teléfono aún no está sincronizado. Logueamos y quedamos en silencio.
    logger.warn({ from: message.from, normalizedFrom }, "No profile found for incoming number — silencing");
    await insertIncomingMessage(message.from, message.body, null, message.messageId ?? null);
    return { type: "default", replyText: "" };
  }

  const userId = profile.id as string;

  // ── 3. Opt-out check ────────────────────────────────────────────────────
  // If user opted out, stay silent (don't even save to DB to avoid noise)
  const optedOut =
    profile.whatsapp_opt_in === false ||
    (profile as Record<string, unknown>)["wp_opted_out"] === true;

  if (optedOut && classified.type !== "opt_out") {
    logger.info({ userId }, "Incoming message from opted-out user — silencing");
    return { type: "default", replyText: "" };
  }

  // ── 4. Save incoming message ─────────────────────────────────────────────
  await insertIncomingMessage(message.from, message.body, userId, message.messageId ?? null);

  // ── 5. Handle commands (non-default) ────────────────────────────────────
  if (classified.type !== "default") {
    // Try to load dynamic command reply from DB (editable via /admin/config)
    const cmdKeyMap: Partial<Record<ResponseAction["type"], string>> = {
      opt_out: "stop", reactivation: "si", help: "ayuda",
      ventas: "ventas", diagnostico: "diagnostico", perfil: "perfil", puntos: "puntos",
    };
    const cmdKey = cmdKeyMap[classified.type];
    if (cmdKey) {
      const dynamicReply = await getCommandReply(cmdKey);
      if (dynamicReply) classified = { ...classified, replyText: dynamicReply };
    }

    let action = classified;

    // Enrich PUNTOS with actual score
    if (action.type === "puntos") {
      const scores = await getLeadScoreForUser(userId);
      if (scores) {
        action = {
          ...action,
          replyText:
            `Tu score FIA: ${scores.overall_score}/100 ` +
            `(Fit: ${scores.fit_score}, Intent: ${scores.intent_score}). ` +
            `Ver detalle: ${config.engine.appBaseUrl}/diagnostico`,
        };
      }
    }

    // Update profile if needed.
    if (action.type === "opt_out") {
      // STOP → fully deactivate Sofía (clears whatsapp_opt_in AND sofia_activated_at)
      await deactivateSofia(userId);
      logger.info({ userId }, "Sofía deactivated via STOP");
    } else if (action.updateProfile) {
      await getSupabaseClient()
        .from("profiles")
        .update(action.updateProfile)
        .eq("id", userId);
      logger.info({ userId, action: action.type }, "Profile updated from response");
    }

    // Log event if needed
    if (action.logEvent) {
      await getSupabaseClient().from("events").insert({
        lead_id: userId,
        event_type: action.logEvent,
        metadata: { source: "whatsapp_response", message: message.body.slice(0, 500) },
      });
    }

    // Wrap link in command replies for click tracking too
    if (action.replyText && action.replyText.includes("http")) {
      action = { ...action, replyText: await wrapLinksWithTracking(action.replyText, userId, normalizedFrom) };
    }

    // Unified conversation log (inbound command + outbound reply)
    await logConversation({ user_id: userId, direction: "in", kind: "command", body: message.body });
    if (action.replyText) {
      await logConversation({ user_id: userId, direction: "out", kind: "command", body: action.replyText });
    }

    logger.info({ userId, type: action.type, from: message.from }, "Command response processed");
    return action;
  }

  // ── 6. Free-text: log response in engagement_log + enrich deep link ─────
  let action = classified; // type === "default", replyText === ""

  const { data: latestLog } = await getSupabaseClient()
    .from("engagement_log")
    .select("id, message, metadata")
    .eq("lead_id", userId)
    .eq("status", "sent")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (latestLog?.id) {
    await getSupabaseClient()
      .from("engagement_log")
      .update({
        metadata: {
          ...(latestLog.metadata as Record<string, unknown>),
          responded: true,
          response_text: message.body.slice(0, 1000),
        },
      })
      .eq("id", latestLog.id);
  }

  // ── 7. Pilot mode guard ──────────────────────────────────────────────────
  // Si el engine le escribió primero en los últimos 14 días, siempre responde con IA.
  // Evita el caso: "te escribí pero no te reconozco cuando me respondés".
  const isWhitelisted = config.engine.pilotWhitelistPhones.some((p) => normalizedFrom.includes(p));
  const since14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentOutbound } = await getSupabaseClient()
    .from("engagement_log")
    .select("id")
    .eq("lead_id", userId)
    .eq("status", "sent")
    .gte("created_at", since14d)
    .limit(1)
    .maybeSingle();
  const hadRecentOutbound = recentOutbound !== null;
  const isAIPilot = !config.engine.pilotPhone
    || normalizedFrom.includes(config.engine.pilotPhone)
    || isWhitelisted
    || hadRecentOutbound;
  if (!isAIPilot) {
    logger.warn(
      { userId, from: message.from, body: message.body.slice(0, 200) },
      "AI inbound reply skipped — user not in pilot whitelist and no recent outbound",
    );
    // Avisar a Axel que alguien le habló a Sofía pero no le respondimos
    try {
      const { evolutionManager } = await import("./whatsappEvolution");
      await evolutionManager.notifyAdmin(
        `🤐 Mensaje silenciado (fuera de piloto)\n📞 ${message.from}\n📥 "${message.body.slice(0, 200)}"\n💡 Whitelistear: agregá ${normalizedFrom} a PILOT_WHITELIST_PHONES`,
      );
    } catch { /* notify es best-effort */ }
    return action;
  }

  // ── 8. Rate limiting + loop detection ───────────────────────────────────
  const state = await getConversationState(userId);
  const consecutiveLow = state?.consecutiveLowEngagement ?? 0;

  if (isLowEngagement(message.body)) {
    const newCount = consecutiveLow + 1;
    await upsertConversationState(userId, { consecutiveLowEngagement: newCount });

    if (newCount >= 4) {
      logger.info({ userId, consecutiveLow: newCount }, "Loop detected — sending close message");
      const closeMsg = await getCommandReply("low_engagement_close") || LOW_ENGAGEMENT_CLOSE_DEFAULT;
      return { type: "default", replyText: closeMsg };
    }

    // 1, 2 o 3 mensajes low-engagement → stay silent
    logger.warn({ userId, from: message.from, body: message.body.slice(0, 80), consecutiveLow: newCount }, "Low-engagement message — silencing");
    return { type: "default", replyText: "" };
  }

  // Good engagement → reset counter
  await upsertConversationState(userId, { consecutiveLowEngagement: 0 });

  // ── 9. Determine user segment ────────────────────────────────────────────
  const segment = await getUserSegment(userId);

  // ── 10. Generate AI reply ────────────────────────────────────────────────
  const aiReply = await generateInboundReply(userId, message.body, segment);

  if (aiReply) {
    action = { ...action, replyText: await wrapLinksWithTracking(aiReply, userId, normalizedFrom) };
  } else {
    logger.warn({ userId }, "AI inbound reply returned null — no reply sent");
  }

  logger.info(
    { userId, type: action.type, from: message.from, hasReply: Boolean(aiReply) },
    "Incoming response processed",
  );

  return action;
}

/**
 * Replace fiacopilot.com links in inbound replies with tracked redirect URLs.
 * Creates a minimal engagement_log entry per link so click tracking works.
 *
 * Trims trailing punctuation (.,!?;) from the matched URL so the redirect doesn't break.
 */
async function wrapLinksWithTracking(text: string, userId: string, phone: string): Promise<string> {
  const escaped = config.engine.appBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // [^\s.,!?;]+ avoids consuming sentence-final punctuation as part of the URL
  const linkRegex = new RegExp(`${escaped}[^\\s]*?[^\\s.,!?;\\)]`, "g");
  const links = text.match(linkRegex);
  if (!links || links.length === 0) return text;

  // Use only the first link to avoid creating excessive log entries per reply
  const link = links[0] as string;
  const { insertEngagementLog } = await import("../db/supabase");
  const logEntry = await insertEngagementLog({
    lead_id: userId,
    status: "sent",
    message: text.slice(0, 2000),
    channel: "whatsapp",
    trigger_type: "inbound_reply",
    metadata: {
      journey_name: "inbound_ai_reply",
      whatsapp_number: phone,
      deep_link: link,
    },
  });
  if (!logEntry?.id) return text;
  const trackedLink = `${config.engine.engineBaseUrl}/r/${logEntry.id}`;
  return text.replace(link, trackedLink);
}
