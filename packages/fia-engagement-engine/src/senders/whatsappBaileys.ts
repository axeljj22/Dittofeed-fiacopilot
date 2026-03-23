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
import { config } from "../config";
import { logger } from "../logger";
import { processIncomingResponse } from "./responses";

export type WAStatus = "disconnected" | "connecting" | "qr_ready" | "connected";

interface SendResult {
  success: boolean;
  error?: string;
}

class BaileysManager {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sock: any = null;
  private _status: WAStatus = "disconnected";
  private _qrDataUrl: string | null = null;
  private _connectedPhone: string | null = null;

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

    try {
      // Dynamic import — avoids native module compilation on Windows dev machines
      const baileys = await import("@whiskeysockets/baileys");
      const makeWASocket = baileys.default;
      const { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = baileys;

      const { state, saveCreds } = await useMultiFileAuthState(config.whatsapp.sessionDir);

      // Fetch the latest WhatsApp Web version — prevents 405 Connection Failure
      const { version } = await fetchLatestBaileysVersion();
      logger.info({ version }, "Using WhatsApp Web version");

      this.sock = makeWASocket({
        version,
        auth: state,
        browser: ["FIA Copilot", "Chrome", "1.0.0"],
      });

      this.sock.ev.on("creds.update", saveCreds);

      // Handle incoming messages — route to response processor
      this.sock.ev.on("messages.upsert", ({ messages, type }: { messages: any[]; type: string }) => {
        if (type !== "notify") return;
        for (const msg of messages) {
          if (msg.key.fromMe) continue; // ignore our own messages
          const from: string = msg.key.remoteJid?.replace("@s.whatsapp.net", "") ?? "";
          const body: string = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? "";
          if (!from || !body) continue;
          logger.info({ from, body: body.slice(0, 50) }, "Incoming WhatsApp message");
          void processIncomingResponse({ from, body, messageId: msg.key.id }).then((action) => {
            if (action.replyText && this.sock) {
              void this.sock.sendMessage(msg.key.remoteJid, { text: action.replyText });
            }
          });
        }
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.sock.ev.on("connection.update", (update: any) => {
        const { connection, lastDisconnect, qr } = update as {
          connection?: string;
          lastDisconnect?: { error?: unknown };
          qr?: string;
        };

        if (qr) {
          void QRCode.toDataURL(qr).then((dataUrl) => {
            this._qrDataUrl = dataUrl;
            this._status = "qr_ready";
            logger.info("WhatsApp QR ready — scan at /admin/whatsapp");
          });
        }

        if (connection === "close") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
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

  async sendMessage(phone: string, text: string): Promise<SendResult> {
    if (this._status !== "connected" || !this.sock) {
      return { success: false, error: `WhatsApp not connected (status: ${this._status})` };
    }

    try {
      const normalized = phone.replace(/[^0-9]/g, "");
      const jid = `${normalized}@s.whatsapp.net`;
      await this.sock.sendMessage(jid, { text });
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
