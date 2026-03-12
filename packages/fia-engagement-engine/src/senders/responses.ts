/**
 * Bidirectional response handler.
 *
 * Processes incoming WhatsApp replies and takes action:
 * - STOP / PARAR → opt out
 * - SI / RETOMAR → log reactivation
 * - AYUDA → reply with help link
 * - Anything else → reply with dashboard link
 */
import { config } from "../config";
import { logger } from "../logger";
import { getSupabaseClient } from "../db/supabase";

export interface IncomingMessage {
  from: string; // WhatsApp number
  body: string;
  messageId?: string;
}

export interface ResponseAction {
  type: "opt_out" | "reactivation" | "help" | "default";
  replyText: string;
  updateProfile?: Record<string, unknown>;
  logEvent?: string;
}

export function classifyResponse(body: string): ResponseAction {
  const normalized = body.trim().toUpperCase();

  if (normalized === "STOP" || normalized === "PARAR") {
    return {
      type: "opt_out",
      replyText:
        "Listo, no recibirás más mensajes de seguimiento. Si cambias de opinión, puedes reactivarlo desde tu perfil.",
      updateProfile: { wp_opted_out: true },
    };
  }

  if (normalized === "SI" || normalized === "SÍ" || normalized === "RETOMAR") {
    return {
      type: "reactivation",
      replyText: `¡Genial! Tu progreso te espera: ${config.engine.appBaseUrl}/dashboard`,
      logEvent: "reactivacion_confirmada",
    };
  }

  if (normalized === "AYUDA" || normalized === "HELP") {
    return {
      type: "help",
      replyText: `Aquí tienes ayuda: ${config.engine.appBaseUrl}/ayuda`,
    };
  }

  return {
    type: "default",
    replyText: `Accede a tu dashboard aquí: ${config.engine.appBaseUrl}/dashboard`,
  };
}

/**
 * Process an incoming WhatsApp response.
 * Returns the reply text to send back.
 */
export async function processIncomingResponse(
  message: IncomingMessage,
): Promise<ResponseAction> {
  const action = classifyResponse(message.body);

  // Find user by WhatsApp number
  const { data: profile } = await getSupabaseClient()
    .from("profiles")
    .select("id")
    .eq("whatsapp", message.from)
    .single();

  if (!profile) {
    logger.warn(
      { from: message.from },
      "Incoming message from unknown number",
    );
    return action;
  }

  const userId = profile.id;

  // Update profile if needed (opt-out)
  if (action.updateProfile) {
    await getSupabaseClient()
      .from("profiles")
      .update(action.updateProfile)
      .eq("id", userId);

    logger.info({ userId, action: action.type }, "Profile updated from response");
  }

  // Log response in engagement_log
  await getSupabaseClient()
    .from("engagement_log")
    .update({
      responded: true,
      response_text: message.body,
    })
    .eq("whatsapp_number", message.from)
    .order("created_at", { ascending: false })
    .limit(1);

  // Log event if needed
  if (action.logEvent) {
    await getSupabaseClient().from("events").insert({
      user_id: userId,
      event_type: action.logEvent,
      metadata: { source: "whatsapp_response", message: message.body },
    });
  }

  logger.info(
    { userId, type: action.type, from: message.from },
    "Incoming response processed",
  );

  return action;
}
