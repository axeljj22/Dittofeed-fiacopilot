import dotenv from "dotenv";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

export const config = {
  // Supabase — read-only access to FIA Copilot DB
  supabase: {
    url: requireEnv("SUPABASE_URL"),
    serviceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  },

  // Claude API — message generation (optional: falls back to templates)
  anthropic: {
    apiKey: optionalEnv("ANTHROPIC_API_KEY", ""),
    model: optionalEnv("ANTHROPIC_MODEL", "claude-sonnet-4-20250514"),
    maxTokens: parseInt(optionalEnv("ANTHROPIC_MAX_TOKENS", "1024"), 10),
  },

  // OpenAI — embeddings only (semantic knowledge retrieval). Optional: falls back to
  // keyword search when the key is absent. Must match the model the stored vectors were
  // generated with (text-embedding-3-small → 1536 dims) or similarity is meaningless.
  openai: {
    apiKey: optionalEnv("OPENAI_API_KEY", ""),
    embeddingModel: optionalEnv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"),
    // Audio transcription (voice notes → text). Dedicated key isolates the cost from embeddings;
    // falls back to the embeddings key if not set.
    transcribeApiKey: optionalEnv("OPENAI_WHISPER_API_KEY", "") || optionalEnv("OPENAI_API_KEY", ""),
    transcribeModel: optionalEnv("OPENAI_TRANSCRIBE_MODEL", "whisper-1"),
    maxAudioSeconds: parseInt(optionalEnv("MAX_AUDIO_SECONDS", "300"), 10),
  },

  // Codex OAuth — message generation via ChatGPT Plus (replaces Anthropic)
  codex: {
    // Path to ~/.codex/auth.json created by `npx @openai/codex login`
    authFilePath: optionalEnv("CODEX_AUTH_FILE", "/root/.codex/auth.json"),
    // gpt-5.3-codex requires Codex Enterprise; gpt-5.4-mini works for ChatGPT Plus consumer accounts.
    model: optionalEnv("CODEX_MODEL", "gpt-5.4-mini"),
  },

  // WhatsApp — message delivery
  whatsapp: {
    provider: optionalEnv("WHATSAPP_PROVIDER", "evolution") as
      | "cloud_api"
      | "twilio"
      | "evolution",
    // Fallback provider if primary fails (empty = no fallback)
    fallbackProvider: optionalEnv("WHATSAPP_FALLBACK_PROVIDER", "") as
      | ""
      | "cloud_api"
      | "evolution",
    // Meta Cloud API
    cloudApi: {
      token: process.env["WHATSAPP_CLOUD_API_TOKEN"] ?? "",
      phoneNumberId: process.env["WHATSAPP_PHONE_NUMBER_ID"] ?? "",
    },
    // Twilio
    twilio: {
      accountSid: process.env["TWILIO_ACCOUNT_SID"] ?? "",
      authToken: process.env["TWILIO_AUTH_TOKEN"] ?? "",
      fromNumber: process.env["TWILIO_WHATSAPP_FROM"] ?? "",
    },
    // Evolution API (REST wrapper, hosted in Hostinger)
    evolution: {
      baseUrl: optionalEnv("EVOLUTION_BASE_URL", ""),
      apiKey: optionalEnv("EVOLUTION_API_KEY", ""),
      instanceName: optionalEnv("EVOLUTION_INSTANCE_NAME", "Sofia"),
      // Timeout (ms) for the connectionState poll used by /health. The default
      // 2s was too aggressive and made /health report connected:false on a slow
      // poll even when messaging worked. Cosmetic only — does not gate sends.
      statusTimeoutMs: parseInt(optionalEnv("EVOLUTION_STATUS_TIMEOUT_MS", "6000"), 10),
    },
  },

  // Engine behavior
  engine: {
    // Base URL for deep links
    appBaseUrl: optionalEnv("FIA_APP_BASE_URL", "https://fiacopilot.com"),
    // Engine's own base URL (for click tracking redirect links)
    engineBaseUrl: requireEnv("ENGINE_BASE_URL"),
    // Max messages per user per day (weekly report is low-frequency; 1 is plenty)
    maxMessagesPerUserPerDay: parseInt(
      optionalEnv("MAX_MESSAGES_PER_USER_PER_DAY", "1"),
      10,
    ),
    // Pilot mode — if set, only send messages to this phone number
    pilotPhone: optionalEnv("PILOT_PHONE", ""),
    // Bypass business hours check (for testing only)
    bypassBusinessHours: optionalEnv("BYPASS_BUSINESS_HOURS", "") === "true",
    // Pilot whitelist — phones that bypass PILOT_PHONE restriction and trigger Axel notifications
    pilotWhitelistPhones: optionalEnv("PILOT_WHITELIST_PHONES", "").split(",").map((p) => p.trim()).filter(Boolean),
    // Phone to notify when a whitelisted pilot user sends a message
    notifyPhone: optionalEnv("SOFIA_NOTIFY_PHONE", ""),
    // Total capsules in the Método FIA (update if the method scales)
    totalCapsules: parseInt(optionalEnv("TOTAL_CAPSULES", "25"), 10),
    // Default timezone for business hours check (IANA format)
    defaultTimezone: optionalEnv("DEFAULT_TIMEZONE", "America/Buenos_Aires"),
    // Sofía's own WhatsApp number (digits only) — used to detect @mentions in groups.
    sofiaWhatsappNumber: optionalEnv("SOFIA_WHATSAPP_NUMBER", "").replace(/\D/g, ""),
    // Sofía's WhatsApp @lid (linked-id) — groups identify participants/@mentions by lid, not phone.
    sofiaWhatsappLid: optionalEnv("SOFIA_WHATSAPP_LID", "").replace(/\D/g, ""),
    // Keywords that count as "calling Sofía" in a group (case-insensitive).
    groupMentionKeywords: optionalEnv("GROUP_MENTION_KEYWORDS", "sofia,sofi")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    // Max group replies per group per hour (anti-loop / anti-spam).
    groupReplyMaxPerHour: parseInt(optionalEnv("GROUP_REPLY_MAX_PER_HOUR", "6"), 10),
  },

  // Scheduler cron expressions
  cron: {
    // Weekly report fallback default — the live value comes from engine_config (report_schedule),
    // editable from the panel. Used only if the DB value can't be read at startup.
    weeklyReport: optionalEnv("CRON_WEEKLY_REPORT", "0 17 * * 0"),
    // Retry failed messages — every 30 minutes (set to "0 0 31 2 *" to disable)
    retryFailed: optionalEnv("CRON_RETRY_FAILED", "*/30 * * * *"),
  },

  // Classify inbound conversations (AI labeling for the observability dashboard) — daily 6 AM
  classifyCron: optionalEnv("CRON_CLASSIFY", "0 6 * * *"),

  // Logging
  logLevel: optionalEnv("LOG_LEVEL", "info"),
} as const;
