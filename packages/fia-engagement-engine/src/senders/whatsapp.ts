/**
 * Agente Ejecutor — WhatsApp
 *
 * Envía mensajes por WhatsApp usando Meta Cloud API o Twilio.
 * Registra el resultado en engagement_log.
 */
import axios from "axios";
import { config } from "../config";
import { logger } from "../logger";
import { insertEngagementLog } from "../db/supabase";
import type { EngagementOpportunity } from "../db/types";
import type { GeneratedMessage } from "../generators/messageGenerator";

interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Send via Meta WhatsApp Cloud API
 */
async function sendViaCloudApi(
  to: string,
  text: string,
): Promise<SendResult> {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${config.whatsapp.cloudApi.phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to: to.replace(/[^0-9]/g, ""),
        type: "text",
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${config.whatsapp.cloudApi.token}`,
          "Content-Type": "application/json",
        },
      },
    );

    return {
      success: true,
      messageId: response.data?.messages?.[0]?.id,
    };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return { success: false, error: message };
  }
}

/**
 * Send via Twilio WhatsApp
 */
async function sendViaTwilio(
  to: string,
  text: string,
): Promise<SendResult> {
  try {
    const fromNumber = config.whatsapp.twilio.fromNumber;
    const toNumber = `whatsapp:+${to.replace(/[^0-9]/g, "")}`;

    const response = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${config.whatsapp.twilio.accountSid}/Messages.json`,
      new URLSearchParams({
        From: fromNumber,
        To: toNumber,
        Body: text,
      }),
      {
        auth: {
          username: config.whatsapp.twilio.accountSid,
          password: config.whatsapp.twilio.authToken,
        },
      },
    );

    return {
      success: true,
      messageId: response.data?.sid,
    };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return { success: false, error: message };
  }
}

/**
 * Send a WhatsApp message and log the result.
 */
export async function sendWhatsAppMessage(
  opportunity: EngagementOpportunity,
  message: GeneratedMessage,
): Promise<boolean> {
  const whatsappNumber = opportunity.profile.whatsapp;

  if (!whatsappNumber) {
    logger.warn(
      { userId: opportunity.userId },
      "No WhatsApp number — skipping",
    );
    return false;
  }

  // Check opt-out
  if (opportunity.profile.wp_opted_out) {
    await insertEngagementLog({
      user_id: opportunity.userId,
      journey_name: message.journeyName,
      mensaje_enviado: message.text,
      whatsapp_number: whatsappNumber,
      deep_link: message.deepLink,
      status: "opted_out",
    });
    logger.info(
      { userId: opportunity.userId },
      "User opted out — logged and skipped",
    );
    return false;
  }

  // First, insert the engagement_log to get the ID for click tracking
  const logEntry = await insertEngagementLog({
    user_id: opportunity.userId,
    journey_name: message.journeyName,
    mensaje_enviado: message.text,
    whatsapp_number: whatsappNumber,
    deep_link: message.deepLink,
    status: "sent", // optimistic — updated to "failed" if send fails
  });

  // Replace direct deep link with tracked redirect URL
  const engineBaseUrl = process.env["ENGINE_BASE_URL"] ?? "https://engine.axeljutoran.com";
  let finalMessage = message.text;
  if (logEntry?.id) {
    const trackedLink = `${engineBaseUrl}/r/${logEntry.id}`;
    finalMessage = message.text.replace(message.deepLink, trackedLink);
  }

  // Send based on configured provider
  const result =
    config.whatsapp.provider === "twilio"
      ? await sendViaTwilio(whatsappNumber, finalMessage)
      : await sendViaCloudApi(whatsappNumber, finalMessage);

  // Update status to "failed" if send failed
  if (!result.success && logEntry?.id) {
    const { getSupabaseClient } = await import("../db/supabase");
    await getSupabaseClient()
      .from("engagement_log")
      .update({ status: "failed" })
      .eq("id", logEntry.id);
  }

  if (result.success) {
    logger.info(
      {
        userId: opportunity.userId,
        journey: message.journeyName,
        messageId: result.messageId,
      },
      "WhatsApp message sent",
    );
  } else {
    logger.error(
      {
        userId: opportunity.userId,
        journey: message.journeyName,
        error: result.error,
      },
      "WhatsApp message failed",
    );
  }

  return result.success;
}
