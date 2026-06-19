/**
 * WhatsApp via Evolution API (REST wrapper over Baileys, hosted in Hostinger).
 *
 * Lighter-weight than the local Baileys sender:
 *  - No QR/session management in the engine — Evolution handles it
 *  - No LID resolution — Evolution returns plain phone JIDs
 *  - Outbound: POST /message/sendText/{instance}
 *  - Inbound: Evolution POSTs to /webhook/whatsapp/evolution (handled in server.ts)
 *
 * Outbound delay of 1200ms is set per-message to reduce spam-detection risk.
 */
import axios from "axios";
import { config } from "../config";
import { logger } from "../logger";

interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

type EvolutionStatus = "open" | "close" | "connecting" | "qr" | "unknown";

class EvolutionManager {
  private _statusCache: { value: EvolutionStatus; ts: number } | null = null;
  private readonly STATUS_TTL_MS = 30_000;

  private get isConfigured(): boolean {
    return !!(config.whatsapp.evolution.baseUrl && config.whatsapp.evolution.apiKey);
  }

  private get headers(): Record<string, string> {
    return {
      apikey: config.whatsapp.evolution.apiKey,
      "Content-Type": "application/json",
    };
  }

  private url(path: string): string {
    const base = config.whatsapp.evolution.baseUrl.replace(/\/$/, "");
    return `${base}${path}`;
  }

  /** GET /instance/connectionState/{instance}. Cached 30s to avoid hammering. */
  async getStatus(): Promise<EvolutionStatus> {
    if (!this.isConfigured) return "unknown";
    if (this._statusCache && Date.now() - this._statusCache.ts < this.STATUS_TTL_MS) {
      return this._statusCache.value;
    }
    try {
      const res = await axios.get(
        this.url(`/instance/connectionState/${config.whatsapp.evolution.instanceName}`),
        { headers: this.headers, timeout: config.whatsapp.evolution.statusTimeoutMs },
      );
      const state = (res.data?.instance?.state ?? "unknown") as EvolutionStatus;
      this._statusCache = { value: state, ts: Date.now() };
      return state;
    } catch (error) {
      logger.warn({ error: (error as Error).message }, "Evolution getStatus failed");
      this._statusCache = { value: "unknown", ts: Date.now() };
      return "unknown";
    }
  }

  /** POST /message/sendText/{instance}. Accepts a phone (1:1) or a group JID (…@g.us). */
  async sendMessage(phone: string, text: string): Promise<SendResult> {
    if (!this.isConfigured) {
      return { success: false, error: "Evolution API not configured" };
    }
    // Groups: send the JID as-is; 1:1: strip to digits.
    const number = phone.includes("@g.us") ? phone : phone.replace(/\D/g, "");
    try {
      const res = await axios.post(
        this.url(`/message/sendText/${config.whatsapp.evolution.instanceName}`),
        { number, text, delay: 1200 },
        { headers: this.headers, timeout: 15_000 },
      );
      return {
        success: true,
        messageId: res.data?.key?.id ?? res.data?.messageId,
      };
    } catch (error) {
      const axiosErr = error as { response?: { data?: unknown; status?: number }; message?: string };
      const message = typeof axiosErr.response?.data === "string"
        ? axiosErr.response.data
        : JSON.stringify(axiosErr.response?.data ?? {}) || axiosErr.message || "Unknown error";
      logger.warn({ phone: number, status: axiosErr.response?.status, message }, "Evolution sendMessage failed");
      return { success: false, error: message };
    }
  }

  /** GET /group/participants/{instance} — returns participant phone numbers (digits only). */
  async getGroupParticipants(groupJid: string): Promise<string[]> {
    if (!this.isConfigured) return [];
    try {
      const res = await axios.get(
        this.url(`/group/participants/${config.whatsapp.evolution.instanceName}?groupJid=${encodeURIComponent(groupJid)}`),
        { headers: this.headers, timeout: 10_000 },
      );
      const parts = (res.data?.participants ?? []) as Array<{ phoneNumber?: string; id?: string }>;
      return parts
        .map((p) => String(p.phoneNumber ?? p.id ?? "").replace(/@.*/, "").replace(/\D/g, ""))
        .filter(Boolean);
    } catch (error) {
      logger.warn({ error: (error as Error).message, groupJid }, "getGroupParticipants failed");
      return [];
    }
  }

  /** GET /group/findGroupInfos/{instance} — returns the group's subject (name), or null. */
  async getGroupSubject(groupJid: string): Promise<string | null> {
    if (!this.isConfigured) return null;
    try {
      const res = await axios.get(
        this.url(`/group/findGroupInfos/${config.whatsapp.evolution.instanceName}?groupJid=${encodeURIComponent(groupJid)}`),
        { headers: this.headers, timeout: 10_000 },
      );
      return (res.data?.subject as string | undefined) ?? null;
    } catch (error) {
      logger.warn({ error: (error as Error).message, groupJid }, "getGroupSubject failed");
      return null;
    }
  }

  /** POST /chat/sendPresence/{instance}. Best-effort, never throws. */
  async sendTyping(phone: string, durationMs = 1500): Promise<void> {
    if (!this.isConfigured) return;
    const number = phone.replace(/\D/g, "");
    try {
      await axios.post(
        this.url(`/chat/sendPresence/${config.whatsapp.evolution.instanceName}`),
        { number, presence: "composing", delay: durationMs },
        { headers: this.headers, timeout: 5000 },
      );
    } catch {
      // typing is cosmetic — swallow failures
    }
  }

  /** Best-effort admin notification via the same Evolution instance. */
  async notifyAdmin(text: string): Promise<void> {
    if (!this.isConfigured || !config.engine.notifyPhone) return;
    try {
      await this.sendMessage(config.engine.notifyPhone, text);
    } catch (error) {
      logger.warn({ error }, "Evolution notifyAdmin failed");
    }
  }
}

export const evolutionManager = new EvolutionManager();
