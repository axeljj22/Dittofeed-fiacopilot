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
} from "../db/supabase";
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

/** Mensaje de cierre por loop de baja calidad */
const LOW_ENGAGEMENT_CLOSE = `Cuando quieras retomar estoy acá. Tu dashboard: ${config.engine.appBaseUrl}/dashboard`;

/** ¿El mensaje es de baja calidad? (< 5 palabras Y sin pregunta) */
function isLowEngagement(body: string): boolean {
  const words = body.trim().split(/\s+/).filter(Boolean);
  return words.length < 5 && !body.includes("?");
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
  const classified = classifyResponse(message.body);

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

    // Update profile if needed (opt-out)
    if (action.updateProfile) {
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
  const isWhitelisted = config.engine.pilotWhitelistPhones.some((p) => normalizedFrom.includes(p));
  const isAIPilot = !config.engine.pilotPhone || normalizedFrom.includes(config.engine.pilotPhone) || isWhitelisted;
  if (!isAIPilot) {
    logger.info({ userId }, "AI inbound reply skipped — not in pilot");
    return action;
  }

  // ── 8. Rate limiting + loop detection ───────────────────────────────────
  const state = await getConversationState(userId);
  const consecutiveLow = state?.consecutiveLowEngagement ?? 0;

  if (isLowEngagement(message.body)) {
    const newCount = consecutiveLow + 1;
    await upsertConversationState(userId, { consecutiveLowEngagement: newCount });

    if (newCount >= 3) {
      logger.info({ userId, consecutiveLow: newCount }, "Loop detected — sending close message");
      return { type: "default", replyText: LOW_ENGAGEMENT_CLOSE };
    }

    // 1 or 2 consecutive low-engagement messages → stay silent
    logger.info({ userId, consecutiveLow: newCount }, "Low-engagement message — silencing");
    return { type: "default", replyText: "" };
  }

  // Good engagement → reset counter
  await upsertConversationState(userId, { consecutiveLowEngagement: 0 });

  // ── 9. Determine user segment ────────────────────────────────────────────
  const segment = await getUserSegment(userId);

  // ── 10. Generate AI reply ────────────────────────────────────────────────
  const aiReply = await generateInboundReply(userId, message.body, segment);

  if (aiReply) {
    action = { ...action, replyText: aiReply };
  } else {
    logger.warn({ userId }, "AI inbound reply returned null — no reply sent");
  }

  logger.info(
    { userId, type: action.type, from: message.from, hasReply: Boolean(aiReply) },
    "Incoming response processed",
  );

  return action;
}
