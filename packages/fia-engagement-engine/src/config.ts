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

  // Codex OAuth — message generation via ChatGPT Plus (replaces Anthropic)
  codex: {
    // Path to ~/.codex/auth.json created by `npx @openai/codex login`
    authFilePath: optionalEnv("CODEX_AUTH_FILE", "/root/.codex/auth.json"),
    model: optionalEnv("CODEX_MODEL", "gpt-5.3-codex"),
  },

  // WhatsApp — message delivery
  whatsapp: {
    provider: optionalEnv("WHATSAPP_PROVIDER", "baileys") as
      | "baileys"
      | "cloud_api"
      | "twilio",
    // Fallback provider if primary fails (empty = no fallback)
    fallbackProvider: optionalEnv("WHATSAPP_FALLBACK_PROVIDER", "") as
      | ""
      | "baileys"
      | "cloud_api",
    // Baileys session persistence directory
    sessionDir: process.env["WHATSAPP_SESSION_DIR"] ?? process.env["WA_SESSION_DIR"] ?? "/app/sessions/baileys",
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
  },

  // Engine behavior
  engine: {
    // Inactivity threshold in days
    inactivityDays: parseInt(
      optionalEnv("INACTIVITY_THRESHOLD_DAYS", "5"),
      10,
    ),
    // Cold lead threshold in days
    coldLeadDays: parseInt(optionalEnv("COLD_LEAD_THRESHOLD_DAYS", "15"), 10),
    // Celebration delay in minutes
    celebrationDelayMinutes: parseInt(
      optionalEnv("CELEBRATION_DELAY_MINUTES", "30"),
      10,
    ),
    // Post-diagnostic delay in minutes — must be > cron interval (15 min) to avoid gaps
    postDiagnosticDelayMinutes: parseInt(
      optionalEnv("POST_DIAGNOSTIC_DELAY_MINUTES", "20"),
      10,
    ),
    // Base URL for deep links
    appBaseUrl: optionalEnv("FIA_APP_BASE_URL", "https://fiacopilot.com"),
    // Engine's own base URL (for click tracking redirect links)
    engineBaseUrl: requireEnv("ENGINE_BASE_URL"),
    // Max messages per user per day
    maxMessagesPerUserPerDay: parseInt(
      optionalEnv("MAX_MESSAGES_PER_USER_PER_DAY", "2"),
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
  },

  // Scheduler cron expressions
  cron: {
    // Event detectors (capsule completions, diagnostics) — every 15 min, time-sensitive
    detectors: optionalEnv("CRON_DETECTORS", "*/15 * * * *"),
    // Segment detectors (inactivity, cold leads) — every 2 hours, not time-sensitive
    segmentDetectors: optionalEnv("CRON_SEGMENT_DETECTORS", "0 */2 * * *"),
    // Weekly sponsor report: Mondays at 9 AM
    sponsorReport: optionalEnv("CRON_SPONSOR_REPORT", "0 9 * * 1"),
    // Retry failed messages — every 30 minutes (set to "0 0 31 2 *" to disable)
    retryFailed: optionalEnv("CRON_RETRY_FAILED", "*/30 * * * *"),
  },

  // Logging
  logLevel: optionalEnv("LOG_LEVEL", "info"),
} as const;
