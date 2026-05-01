/**
 * WhatsApp via Baileys (multi-device, QR-based)
 *
 * Connects to WhatsApp using your personal/business number by scanning a QR code.
 * Session persists to disk so you only scan once.
 * QR code is exposed via GET /admin/whatsapp in server.ts.
 *
 * Uses dynamic imports so native modules (libsignal) build on Linux/Docker only.
 */
import QRCode from "qrcode";
import fs from "fs";
import path from "path";
import { config } from "../config";
import { logger } from "../logger";
import { processIncomingResponse } from "./responses";
// Minimal local types — avoids importing Baileys types that vary by version
interface WASocketLike {
  ev: {
    on(event: string, handler: (...args: never[]) => void): void;
  };
  sendMessage(jid: string, content: { text: string }): Promise<unknown>;
  sendPresenceUpdate?(presence: "available" | "composing" | "paused" | "recording" | "unavailable", jid?: string): Promise<void>;
  presenceSubscribe?(jid: string): Promise<void>;
  onWhatsApp?(...jids: string[]): Promise<Array<{ jid: string; exists: boolean; lid?: string }> | undefined>;
  user?: { id: string | null };
}

interface WAMessageKey {
  fromMe?: boolean | null;
  remoteJid?: string | null;
  id?: string | null;
}

interface WAIncomingMessage {
  key: WAMessageKey;
  message?: {
    conversation?: string;
    extendedTextMessage?: { text?: string };
  } | null;
}

interface WAConnectionState {
  connection?: "close" | "connecting" | "open";
  lastDisconnect?: { error?: Error & { output?: { statusCode?: number } } };
  qr?: string;
}

export type WAStatus = "disconnected" | "connecting" | "qr_ready" | "connected";

interface SendResult {
  success: boolean;
  error?: string;
}

class BaileysManager {
  private sock: WASocketLike | null = null;
  private _status: WAStatus = "disconnected";
  private _qrDataUrl: string | null = null;
  private _connectedPhone: string | null = null;
  private _reconnectAttempts = 0;
  /** Maps LID bare digits → phone digits (e.g. "211436978581513" → "5491125120212") */
  private lidToPhone = new Map<string, string>();

  /** Path to the persisted LID map JSON file.
   *  Stored ONE LEVEL UP from the session dir so it survives session resets
   *  (resetSession wipes only the session dir contents, not the parent). */
  private get lidMapPath(): string {
    return path.join(path.dirname(config.whatsapp.sessionDir), "lid_map.json");
  }

  private loadLidMap(): void {
    try {
      const raw = fs.readFileSync(this.lidMapPath, "utf8");
      const entries = JSON.parse(raw) as Record<string, string>;
      for (const [lid, phone] of Object.entries(entries)) {
        this.lidToPhone.set(lid, phone);
      }
      logger.info({ count: this.lidToPhone.size }, "LID map loaded from disk");
    } catch {
      // File doesn't exist yet — start with empty map
    }
  }

  private saveLidMap(): void {
    try {
      const entries = Object.fromEntries(this.lidToPhone);
      fs.writeFileSync(this.lidMapPath, JSON.stringify(entries, null, 2));
    } catch (error) {
      logger.warn({ error }, "Could not save LID map to disk");
    }
  }

  get status(): WAStatus {
    return this._status;
  }

  get qrDataUrl(): string | null {
    return this._qrDataUrl;
  }

  get connectedPhone(): string | null {
    return this._connectedPhone;
  }

  async connect(): Promise<void> {
    if (this._status === "connected" || this._status === "connecting") return;

    this._status = "connecting";
    logger.info({ sessionDir: config.whatsapp.sessionDir }, "Starting WhatsApp connection");

    // Ensure session directory exists
    fs.mkdirSync(config.whatsapp.sessionDir, { recursive: true });

    // Load persisted LID map (survives container restarts)
    this.loadLidMap();

    try {
      // Dynamic import — avoids native module compilation on Windows dev machines
      const baileys = await import("@whiskeysockets/baileys");
      const makeWASocket = baileys.default;
      const { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = baileys;

      const { state, saveCreds } = await useMultiFileAuthState(config.whatsapp.sessionDir);

      // Fetch the latest WhatsApp Web version — prevents 405 Connection Failure
      const { version } = await fetchLatestBaileysVersion();
      logger.info({ version }, "Using WhatsApp Web version");

      const sock = makeWASocket({
        version,
        auth: state,
        browser: ["FIA Copilot", "Chrome", "1.0.0"],
      });
      this.sock = sock;

      sock.ev.on("creds.update", saveCreds);

      // Capture LID ↔ phone mappings from Baileys contact events
      // Key is always bare LID digits (no @lid suffix) for consistent lookup
      sock.ev.on("contacts.upsert", (contacts: Array<{ id: string; lid?: string; name?: string }>) => {
        for (const c of contacts) {
          if (c.lid && c.id?.endsWith("@s.whatsapp.net")) {
            const phone = c.id.replace("@s.whatsapp.net", "");
            const lidKey = c.lid.replace("@lid", ""); // normalize — strip suffix if present
            this.lidToPhone.set(lidKey, phone);
            logger.debug({ lid: lidKey, phone }, "LID mapping captured from contacts.upsert");
          }
        }
        logger.info({ mapSize: this.lidToPhone.size }, "LID→phone map updated");
        this.saveLidMap();
      });

      // Handle incoming messages — route to response processor
      sock.ev.on("messages.upsert", async ({ messages, type }: { messages: WAIncomingMessage[]; type: string }) => {
        if (type !== "notify") return;
        for (const msg of messages) {
          if (msg.key.fromMe) continue; // ignore our own messages
          const remoteJid = msg.key.remoteJid;
          if (!remoteJid) continue;

          // Resolve JID to phone: direct phone JID or LID lookup (cache → onWhatsApp → DB)
          let from: string;
          if (remoteJid.endsWith("@s.whatsapp.net")) {
            from = remoteJid.replace("@s.whatsapp.net", "");
          } else if (remoteJid.endsWith("@lid")) {
            const lidKey = remoteJid.replace("@lid", "");
            const cached = this.lidToPhone.get(lidKey);
            if (cached) {
              from = cached;
              logger.info({ lid: remoteJid, phone: from }, "LID resolved from cache");
            } else {
              const resolved = await this.resolveLidActive(lidKey);
              if (resolved) {
                from = resolved;
                logger.info({ lid: remoteJid, phone: from }, "LID resolved actively");
              } else {
                // Notificar a Axel que llegó un mensaje sin poder resolver el LID
                logger.warn({ lid: remoteJid, body: msg.message?.conversation?.slice(0, 80) }, "Unresolved LID — notifying admin");
                await this.notifyAdmin(`⚠️ LID no resuelto: ${remoteJid}\n📥 "${(msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? "").slice(0, 200)}"`);
                continue;
              }
            }
          } else {
            from = remoteJid;
          }

          const body: string = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? "";
          if (!from || !body) continue;
          logger.info({ from, body: body.slice(0, 50), jid: remoteJid }, "Incoming WhatsApp message");
          const normalizedSender = from.replace(/\D/g, "");
          void processIncomingResponse({ from, body, messageId: msg.key.id ?? undefined })
            .then(async (action) => {
              if (action.replyText) {
                // Typing indicator: humaniza la conversación (1s base + 30ms/char, max 4s)
                const typingMs = Math.min(1000 + action.replyText.length * 30, 4000);
                await this.sendTyping(remoteJid, typingMs);
                await sock.sendMessage(remoteJid, { text: action.replyText });
              }
              // Notify Axel when a pilot whitelisted user sends a message
              const isWhitelisted = config.engine.pilotWhitelistPhones.some((p) => normalizedSender.includes(p));
              if (isWhitelisted && config.engine.notifyPhone && normalizedSender !== config.engine.notifyPhone) {
                const notifyJid = `${config.engine.notifyPhone}@s.whatsapp.net`;
                const replyPreview = action.replyText ? action.replyText.slice(0, 200) : "(sin respuesta)";
                const notifText = `🔔 *${from}* escribió\n📥 "${body.slice(0, 200)}"\n💬 Sofía: "${replyPreview}"`;
                await sock.sendMessage(notifyJid, { text: notifText });
              }
            })
            .catch((err: unknown) => {
              logger.error({ err, from }, "Error processing incoming WhatsApp response");
            });
        }
      });

      sock.ev.on("connection.update", (update: WAConnectionState) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          void QRCode.toDataURL(qr).then((dataUrl: string) => {
            this._qrDataUrl = dataUrl;
            this._status = "qr_ready";
            logger.info("WhatsApp QR ready — scan at /admin/whatsapp");
          });
        }

        if (connection === "close") {
          const err = lastDisconnect?.error as (Error & { output?: { statusCode?: number } }) | undefined;
          const statusCode = err?.output?.statusCode;
          const loggedOut = statusCode === DisconnectReason.loggedOut;

          logger.warn({ statusCode, loggedOut }, "WhatsApp connection closed");
          this._status = "disconnected";
          this._qrDataUrl = null;
          this._connectedPhone = null;
          this.sock = null;

          if (!loggedOut) {
            // Exponential backoff: 5s → 10s → 20s → 40s → ... max 5 min
            const delay = Math.min(5000 * Math.pow(2, this._reconnectAttempts), 5 * 60 * 1000);
            this._reconnectAttempts++;
            logger.info({ delay, attempt: this._reconnectAttempts }, "Reconnecting WhatsApp...");
            // Avisar a Axel después del 3er intento fallido (probable problema persistente)
            if (this._reconnectAttempts === 3) {
              void this.notifyAdminOutOfBand(`⚠️ Baileys reconectando — intento ${this._reconnectAttempts} (statusCode: ${statusCode})`);
            }
            setTimeout(() => void this.connect(), delay);
          } else {
            logger.warn("WhatsApp logged out — resetSession() to re-scan QR");
            // CRÍTICO: avisar a Axel que necesita re-escanear QR
            void this.notifyAdminOutOfBand(`🚨 WhatsApp logged out — Sofía está caída.\nRe-escaneá QR: ${config.engine.engineBaseUrl}/admin/whatsapp`);
          }
        }

        if (connection === "open") {
          this._status = "connected";
          this._qrDataUrl = null;
          this._connectedPhone = this.sock?.user?.id ?? null;
          this._reconnectAttempts = 0;
          logger.info({ phone: this._connectedPhone }, "WhatsApp connected");
        }
      });
    } catch (error) {
      logger.error({ error }, "Baileys initialization failed");
      this._status = "disconnected";
    }
  }

  /** Resolve a LID to a phone number (if mapping exists) */
  resolvePhone(jid: string): string | null {
    if (jid.endsWith("@s.whatsapp.net")) return jid.replace("@s.whatsapp.net", "");
    if (jid.endsWith("@lid")) return this.lidToPhone.get(jid.replace("@lid", "")) ?? null;
    return null;
  }

  /** Try to resolve a LID at runtime via DB lookup (engagement_log mapping captured by send) */
  private async resolveLidActive(lidKey: string): Promise<string | null> {
    try {
      // Look in engagement_log metadata for any prior outbound that captured this LID
      const { getSupabaseClient } = await import("../db/supabase");
      const { data } = await getSupabaseClient()
        .from("engagement_log")
        .select("metadata")
        .filter("metadata->>lid", "eq", lidKey)
        .limit(1)
        .maybeSingle();
      const phone = (data?.metadata as Record<string, unknown> | null)?.["whatsapp_number"] as string | undefined;
      if (phone) {
        this.lidToPhone.set(lidKey, phone);
        this.saveLidMap();
        return phone;
      }
    } catch (error) {
      logger.warn({ error, lidKey }, "resolveLidActive DB lookup failed");
    }
    return null;
  }

  /** Send a typing indicator before replying (humaniza la conversación) */
  async sendTyping(jid: string, durationMs = 1500): Promise<void> {
    try {
      if (!this.sock?.sendPresenceUpdate) return;
      await this.sock.sendPresenceUpdate("composing", jid);
      await new Promise((r) => setTimeout(r, durationMs));
      await this.sock.sendPresenceUpdate("paused", jid);
    } catch {
      // typing es cosmético — no romper si falla
    }
  }

  /** Send a notification to the admin phone (config.engine.notifyPhone) */
  async notifyAdmin(text: string): Promise<void> {
    try {
      if (!this.sock || !config.engine.notifyPhone || this._status !== "connected") return;
      const jid = `${config.engine.notifyPhone}@s.whatsapp.net`;
      await this.sock.sendMessage(jid, { text });
    } catch (error) {
      logger.warn({ error }, "notifyAdmin failed");
    }
  }

  /**
   * Send admin alert when Baileys itself is down — uses Cloud API or Twilio if configured,
   * otherwise just logs (visible in `docker logs fia-engine`).
   */
  async notifyAdminOutOfBand(text: string): Promise<void> {
    const phone = config.engine.notifyPhone;
    if (!phone) {
      logger.error({ text }, "ADMIN ALERT (no notify phone configured)");
      return;
    }
    try {
      // Try Cloud API
      if (config.whatsapp.cloudApi.token && config.whatsapp.cloudApi.phoneNumberId) {
        const axios = (await import("axios")).default;
        await axios.post(
          `https://graph.facebook.com/v18.0/${config.whatsapp.cloudApi.phoneNumberId}/messages`,
          { messaging_product: "whatsapp", to: phone.replace(/\D/g, ""), type: "text", text: { body: text } },
          { headers: { Authorization: `Bearer ${config.whatsapp.cloudApi.token}`, "Content-Type": "application/json" } },
        );
        logger.info({ phone }, "Admin alert sent via Cloud API");
        return;
      }
      // Try Twilio
      if (config.whatsapp.twilio.accountSid && config.whatsapp.twilio.authToken && config.whatsapp.twilio.fromNumber) {
        const axios = (await import("axios")).default;
        await axios.post(
          `https://api.twilio.com/2010-04-01/Accounts/${config.whatsapp.twilio.accountSid}/Messages.json`,
          new URLSearchParams({
            From: config.whatsapp.twilio.fromNumber,
            To: `whatsapp:+${phone.replace(/\D/g, "")}`,
            Body: text,
          }),
          { auth: { username: config.whatsapp.twilio.accountSid, password: config.whatsapp.twilio.authToken } },
        );
        logger.info({ phone }, "Admin alert sent via Twilio");
        return;
      }
      logger.error({ text }, "ADMIN ALERT (no out-of-band provider available)");
    } catch (error) {
      logger.error({ error, text }, "notifyAdminOutOfBand failed");
    }
  }

  async sendMessage(phone: string, text: string): Promise<SendResult> {
    if (this._status !== "connected" || !this.sock) {
      return { success: false, error: `WhatsApp not connected (status: ${this._status})` };
    }

    try {
      const normalized = phone.replace(/[^0-9]/g, "");
      const jid = `${normalized}@s.whatsapp.net`;
      const result = await this.sock.sendMessage(jid, { text }) as { key?: WAMessageKey } | undefined;
      // Capture LID mapping if the response contains a LID JID
      const responseJid = result?.key?.remoteJid;
      if (responseJid?.endsWith("@lid")) {
        const lidKey = responseJid.replace("@lid", "");
        this.lidToPhone.set(lidKey, normalized);
        this.saveLidMap();
        logger.info({ lid: lidKey, phone: normalized }, "LID mapping captured from send");
      }
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return { success: false, error: message };
    }
  }

  /** Clear session files and reset state (forces re-scan on next connect) */
  resetSession(): void {
    try {
      fs.rmSync(config.whatsapp.sessionDir, { recursive: true, force: true });
    } catch { /* ignore */ }
    this._status = "disconnected";
    this._qrDataUrl = null;
    this._connectedPhone = null;
    this.sock = null;
    logger.info("WhatsApp session cleared");
  }
}

export const baileysManager = new BaileysManager();
