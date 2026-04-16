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
  /** Maps LID bare digits → phone digits (e.g. "211436978581513" → "5491125120212") */
  private lidToPhone = new Map<string, string>();

  /** Path to the persisted LID map JSON file */
  private get lidMapPath(): string {
    return path.join(config.whatsapp.sessionDir, "lid_map.json");
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
      sock.ev.on("messages.upsert", ({ messages, type }: { messages: WAIncomingMessage[]; type: string }) => {
        if (type !== "notify") return;
        for (const msg of messages) {
          if (msg.key.fromMe) continue; // ignore our own messages
          const remoteJid = msg.key.remoteJid;
          if (!remoteJid) continue;

          // Resolve JID to phone: direct phone JID or LID lookup
          let from: string;
          if (remoteJid.endsWith("@s.whatsapp.net")) {
            from = remoteJid.replace("@s.whatsapp.net", "");
          } else if (remoteJid.endsWith("@lid")) {
            const lidKey = remoteJid.replace("@lid", ""); // normalize for lookup
            const resolved = this.lidToPhone.get(lidKey);
            if (resolved) {
              from = resolved;
              logger.info({ lid: remoteJid, phone: from }, "LID resolved to phone");
            } else {
              from = lidKey;
              logger.warn({ lid: remoteJid }, "Unresolved LID — passing raw to response handler");
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
            logger.info("Reconnecting WhatsApp in 5s...");
            setTimeout(() => void this.connect(), 5000);
          } else {
            logger.warn("WhatsApp logged out — resetSession() to re-scan QR");
          }
        }

        if (connection === "open") {
          this._status = "connected";
          this._qrDataUrl = null;
          this._connectedPhone = this.sock?.user?.id ?? null;
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
    if (jid.endsWith("@lid")) return this.lidToPhone.get(jid) ?? null;
    return null;
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
