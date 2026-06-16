/**
 * Agente Ejecutor — WhatsApp
 *
 * Envía mensajes por WhatsApp usando Meta Cloud API o Twilio.
 * Registra el resultado en engagement_log.
 */
import axios from "axios";
import { config } from "../config";
import { logger } from "../logger";
import { insertEngagementLog, getConversationState } from "../db/supabase";
import type { EngagementOpportunity } from "../db/types";
import type { GeneratedMessage } from "../generators/messageGenerator";
import { baileysManager } from "./whatsappBaileys";
import { evolutionManager } from "./whatsappEvolution";

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

/** Route a send to the right provider implementation */
async function sendWithProvider(
  provider: "baileys" | "cloud_api" | "twilio" | "evolution" | "",
  phone: string,
  text: string,
): Promise<SendResult> {
  if (provider === "evolution") return evolutionManager.sendMessage(phone, text);
  if (provider === "baileys") return baileysManager.sendMessage(phone, text);
  if (provider === "twilio") return sendViaTwilio(phone, text);
  if (provider === "cloud_api") return sendViaCloudApi(phone, text);
  return { success: false, error: `Unknown provider: ${provider}` };
}

/**
 * Send a WhatsApp message and log the result.
 */
export async function sendWhatsAppMessage(
  opportunity: EngagementOpportunity,
  message: GeneratedMessage,
): Promise<boolean> {
  const whatsappNumber = opportunity.profile.phone;

  if (!whatsappNumber) {
    logger.warn(
      { userId: opportunity.userId },
      "No WhatsApp number — skipping",
    );
    return false;
  }

  // ── Hard pilot gate (defense in depth) ──
  // The orchestrator already filters by pilotPhone, but anything that calls
  // sendWhatsAppMessage directly (test endpoints, manual triggers, retries)
  // could bypass that. Block here as a last line of defense.
  if (config.engine.pilotPhone) {
    const normalized = whatsappNumber.replace(/\D/g, "");
    const pilot = config.engine.pilotPhone.replace(/\D/g, "");
    const whitelistedFor = config.engine.pilotWhitelistPhones.some((w) => normalized.includes(w));
    if (normalized !== pilot && !whitelistedFor) {
      logger.warn(
        { userId: opportunity.userId, to: normalized, pilot },
        "BLOCKED outbound — pilot mode active and recipient not in pilot/whitelist",
      );
      return false;
    }
  }

  // Check user pause (set when user replies "ahora no", "mañana", etc.)
  const state = await getConversationState(opportunity.userId);
  if (state.pausedUntil && new Date(state.pausedUntil).getTime() > Date.now()) {
    logger.info(
      { userId: opportunity.userId, pausedUntil: state.pausedUntil, journey: message.journeyName },
      "Outbound paused — user signaled busy",
    );
    await insertEngagementLog({
      lead_id: opportunity.userId,
      status: "skipped_paused",
      message: message.text,
      channel: "whatsapp",
      trigger_type: "scheduled",
      metadata: {
        journey_name: message.journeyName,
        whatsapp_number: whatsappNumber,
        deep_link: message.deepLink,
        paused_until: state.pausedUntil,
      },
    });
    return false;
  }

  // Check opt-out
  if (!opportunity.profile.whatsapp_opt_in) {
    await insertEngagementLog({
      lead_id: opportunity.userId,
      status: "opted_out",
      message: message.text,
      channel: "whatsapp",
      trigger_type: "scheduled",
      metadata: {
        journey_name: message.journeyName,
        whatsapp_number: whatsappNumber,
        deep_link: message.deepLink,
      },
    });
    logger.info(
      { userId: opportunity.userId },
      "User opted out — logged and skipped",
    );
    return false;
  }

  // Insert log entry first to get the ID for click tracking.
  const logEntry = await insertEngagementLog({
    lead_id: opportunity.userId,
    status: "sent",
    message: message.text,
    channel: "whatsapp",
    trigger_type: "scheduled",
    metadata: {
      journey_name: message.journeyName,
      whatsapp_number: whatsappNumber,
      deep_link: message.deepLink,
      ...(opportunity.level !== undefined ? { level: opportunity.level } : {}),
      ...(message.abTestName ? { ab_test_name: message.abTestName, ab_variant: message.abVariant } : {}),
    },
  });

  // Replace direct deep link with tracked redirect URL
  const engineBaseUrl = config.engine.engineBaseUrl;
  let finalMessage = message.text;
  if (logEntry?.id) {
    const trackedLink = `${engineBaseUrl}/r/${logEntry.id}`;
    finalMessage = message.text.replace(message.deepLink, trackedLink);
  }

  // Send via primary provider, fall back if configured
  let result = await sendWithProvider(config.whatsapp.provider, whatsappNumber, finalMessage);
  if (!result.success && config.whatsapp.fallbackProvider) {
    logger.warn(
      { primaryError: result.error, fallback: config.whatsapp.fallbackProvider },
      "Primary WhatsApp provider failed — trying fallback",
    );
    result = await sendWithProvider(config.whatsapp.fallbackProvider, whatsappNumber, finalMessage);
    if (result.success) {
      logger.info({ provider: config.whatsapp.fallbackProvider }, "Fallback provider succeeded");
    }
  }

  // Update to "failed_pending_retry" if send didn't succeed (cron will retry up to 3 times)
  if (!result.success && logEntry?.id) {
    const { getSupabaseClient } = await import("../db/supabase");
    const existingMeta = (logEntry.metadata as Record<string, unknown> | null) ?? {};
    const { error: updateError } = await getSupabaseClient()
      .from("engagement_log")
      .update({
        status: "failed_pending_retry",
        metadata: { ...existingMeta, retry_count: 0, last_error: result.error ?? "unknown" },
      })
      .eq("id", logEntry.id);
    if (updateError) {
      logger.error({ updateError, logId: logEntry.id }, "Failed to mark log entry as failed_pending_retry");
    }
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

/**
 * Send a raw campaign message to a specific phone number.
 * Used for manual outreach campaigns where the message is pre-written.
 * Does not require an EngagementOpportunity — phone and text are provided directly.
 */
export async function sendCampaignMessage(
  phone: string,
  userId: string,
  messageText: string,
  journeyName: string,
): Promise<boolean> {
  const normalizedPhone = phone.replace(/\D/g, "");

  if (!normalizedPhone) {
    logger.warn({ phone }, "Campaign send skipped — empty phone after normalization");
    return false;
  }

  // Hard pilot gate (defense in depth — see sendWhatsAppMessage for rationale)
  if (config.engine.pilotPhone) {
    const pilot = config.engine.pilotPhone.replace(/\D/g, "");
    const whitelistedFor = config.engine.pilotWhitelistPhones.some((w) => normalizedPhone.includes(w));
    if (normalizedPhone !== pilot && !whitelistedFor) {
      logger.warn(
        { to: normalizedPhone, pilot },
        "BLOCKED campaign send — pilot mode active",
      );
      return false;
    }
  }

  // Log before sending so we have a record even if delivery fails
  const logEntry = await insertEngagementLog({
    lead_id: userId,
    status: "sent",
    message: messageText,
    channel: "whatsapp",
    trigger_type: "campaign",
    metadata: {
      journey_name: journeyName,
      whatsapp_number: normalizedPhone,
      deep_link: "",
    },
  });

  let result = await sendWithProvider(config.whatsapp.provider, normalizedPhone, messageText);
  if (!result.success && config.whatsapp.fallbackProvider) {
    logger.warn(
      { primaryError: result.error, fallback: config.whatsapp.fallbackProvider },
      "Primary WhatsApp provider failed — trying fallback",
    );
    result = await sendWithProvider(config.whatsapp.fallbackProvider, normalizedPhone, messageText);
    if (result.success) {
      logger.info({ provider: config.whatsapp.fallbackProvider }, "Fallback provider succeeded");
    }
  }

  if (!result.success && logEntry?.id) {
    const { getSupabaseClient } = await import("../db/supabase");
    const existingMeta = (logEntry.metadata as Record<string, unknown> | null) ?? {};
    await getSupabaseClient()
      .from("engagement_log")
      .update({
        status: "failed_pending_retry",
        metadata: { ...existingMeta, retry_count: 0, last_error: result.error ?? "unknown" },
      })
      .eq("id", logEntry.id);
  }

  if (result.success) {
    logger.info({ phone: normalizedPhone, journey: journeyName }, "Campaign message sent");
  } else {
    logger.error({ phone: normalizedPhone, journey: journeyName, error: result.error }, "Campaign message failed");
  }

  return result.success;
}

/**
 * Retry messages with status 'failed_pending_retry' (max 3 attempts).
 * After 3 attempts → mark as 'failed' (terminal). Cron should call this every 30 min.
 */
export async function retryFailedMessages(): Promise<{ retried: number; succeeded: number; gaveUp: number }> {
  const { getSupabaseClient } = await import("../db/supabase");
  const supabase = getSupabaseClient();

  // Find candidates: failed_pending_retry from last 24h, not retried in last 30min
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const thirtyMinAgo = Date.now() - 30 * 60 * 1000;

  const { data: candidates, error } = await supabase
    .from("engagement_log")
    .select("id, lead_id, message, metadata")
    .eq("status", "failed_pending_retry")
    .gte("created_at", since)
    .limit(20);

  if (error) {
    logger.error({ error }, "Failed to fetch retry candidates");
    return { retried: 0, succeeded: 0, gaveUp: 0 };
  }

  let retried = 0;
  let succeeded = 0;
  let gaveUp = 0;

  for (const row of candidates ?? []) {
    const meta = (row.metadata as { whatsapp_number?: string; retry_count?: number; last_retry_at?: string } | null) ?? {};
    const phone = meta.whatsapp_number;
    const retryCount = meta.retry_count ?? 0;
    const lastRetryAt = meta.last_retry_at ? new Date(meta.last_retry_at).getTime() : 0;

    if (!phone) continue;
    // Respect 30min spacing between retries
    if (lastRetryAt && lastRetryAt > thirtyMinAgo) continue;

    // Hard pilot gate — never retry to non-pilot phones
    if (config.engine.pilotPhone) {
      const normalizedPhone = phone.replace(/\D/g, "");
      const pilot = config.engine.pilotPhone.replace(/\D/g, "");
      const whitelistedFor = config.engine.pilotWhitelistPhones.some((w) => normalizedPhone.includes(w));
      if (normalizedPhone !== pilot && !whitelistedFor) {
        // Mark as terminally failed so we don't keep evaluating it forever
        await supabase.from("engagement_log")
          .update({ status: "failed", metadata: { ...meta, blocked_by_pilot_mode: true } })
          .eq("id", row.id);
        gaveUp++;
        continue;
      }
    }

    // Skip if user signalled busy after the original send — wait for pause to expire
    const userState = await getConversationState(row.lead_id as string);
    if (userState.pausedUntil && new Date(userState.pausedUntil).getTime() > Date.now()) {
      logger.info({ logId: row.id, leadId: row.lead_id, pausedUntil: userState.pausedUntil }, "Retry skipped — user paused");
      continue;
    }

    if (retryCount >= 3) {
      // Give up — mark as terminal failed
      await supabase
        .from("engagement_log")
        .update({ status: "failed", metadata: { ...meta, gave_up_at: new Date().toISOString() } })
        .eq("id", row.id);
      gaveUp++;
      logger.warn({ logId: row.id, phone, retryCount }, "Giving up on failed message after 3 retries");
      continue;
    }

    retried++;
    const result = await sendWithProvider(config.whatsapp.provider, phone, row.message as string);
    let finalResult = result;
    if (!result.success && config.whatsapp.fallbackProvider) {
      finalResult = await sendWithProvider(config.whatsapp.fallbackProvider, phone, row.message as string);
    }

    if (finalResult.success) {
      await supabase
        .from("engagement_log")
        .update({ status: "sent", metadata: { ...meta, retry_count: retryCount + 1, last_retry_at: new Date().toISOString(), recovered: true } })
        .eq("id", row.id);
      succeeded++;
      logger.info({ logId: row.id, phone, attempt: retryCount + 1 }, "Failed message recovered on retry");
    } else {
      await supabase
        .from("engagement_log")
        .update({
          metadata: {
            ...meta,
            retry_count: retryCount + 1,
            last_retry_at: new Date().toISOString(),
            last_error: finalResult.error ?? "unknown",
          },
        })
        .eq("id", row.id);
      logger.warn({ logId: row.id, phone, attempt: retryCount + 1, error: finalResult.error }, "Retry failed");
    }
  }

  if (retried > 0) {
    logger.info({ retried, succeeded, gaveUp }, "Retry cycle completed");
  }
  return { retried, succeeded, gaveUp };
}
