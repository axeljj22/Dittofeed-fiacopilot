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
 * - Anything else → reply with dashboard link
 */
import { config } from "../config";
import { logger } from "../logger";
import { getSupabaseClient, getLeadScoreForUser, getRecentEngagementForUser, insertIncomingMessage } from "../db/supabase";
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
    replyText:
      `Hola! Soy el recordatorio automático de FIA Copilot — no tengo IA para responder mensajes libres.\n\n` +
      `Podés escribirme estas palabras:\n` +
      `• SI → retomar el programa\n` +
      `• STOP → dejar de recibir mensajes\n` +
      `• PUNTOS → ver tu score\n` +
      `• AYUDA → contactar soporte\n\n` +
      `Tu dashboard: ${config.engine.appBaseUrl}/dashboard`,
  };
}

/**
 * Process an incoming WhatsApp response.
 * Returns the reply text to send back.
 */
export async function processIncomingResponse(
  message: IncomingMessage,
): Promise<ResponseAction> {
  let action = classifyResponse(message.body);

  // Find user by WhatsApp number — normalize to digits only before comparing
  const normalizedFrom = message.from.replace(/\D/g, "");
  const { data: profile } = await getSupabaseClient()
    .from("profiles")
    .select("id")
    .eq("phone", normalizedFrom)
    .single();

  if (!profile) {
    logger.warn(
      { from: message.from },
      "Incoming message from unknown number",
    );
    // Save to DB even if we can't identify the user
    await insertIncomingMessage(message.from, message.body, null, message.messageId ?? null);
    return action;
  }

  const userId = profile.id;

  // Save incoming message to DB (identified user)
  await insertIncomingMessage(message.from, message.body, userId, message.messageId ?? null);

  // Enrich PUNTOS reply with actual score from DB
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

  // Log response in the most recent engagement_log entry for this user
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

    // Enrich reactivation/default reply with the deep link from the last message
    const lastMeta = latestLog.metadata as { deep_link?: string; journey_name?: string } | null;
    const deepLink = lastMeta?.deep_link;

    if (deepLink && action.type === "reactivation") {
      action = {
        ...action,
        replyText: `¡Genial! Retomá desde donde lo dejaste: ${deepLink}`,
      };
    } else if (deepLink && action.type === "default") {
      action = {
        ...action,
        replyText: `Acá tenés el acceso directo: ${deepLink}`,
      };
    }
  }

  // Pilot mode — restrict AI replies to pilotPhone if set, otherwise all users
  const isAIPilot = !config.engine.pilotPhone || normalizedFrom.includes(config.engine.pilotPhone);

  // AI reply for free-text messages — skip if user already received 2+ messages today (loop guard)
  if (action.type === "default" && isAIPilot) {
    const recentEngagement = await getRecentEngagementForUser(userId, 24);
    if (recentEngagement.length < 2) {
      const aiReply = await generateInboundReply(userId, message.body);
      if (aiReply) {
        action = { ...action, replyText: aiReply };
      }
    } else {
      logger.info({ userId, recentCount: recentEngagement.length }, "AI inbound reply skipped — rate limit");
    }
  }

  // Log event if needed
  if (action.logEvent) {
    await getSupabaseClient().from("events").insert({
      lead_id: userId,
      event_type: action.logEvent,
      metadata: { source: "whatsapp_response", message: message.body.slice(0, 500) },
    });
  }

  logger.info(
    { userId, type: action.type, from: message.from },
    "Incoming response processed",
  );

  return action;
}
