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

  // Claude API — message generation
  anthropic: {
    apiKey: requireEnv("ANTHROPIC_API_KEY"),
    model: optionalEnv("ANTHROPIC_MODEL", "claude-sonnet-4-20250514"),
    maxTokens: parseInt(optionalEnv("ANTHROPIC_MAX_TOKENS", "1024"), 10),
  },

  // WhatsApp — message delivery
  whatsapp: {
    provider: optionalEnv("WHATSAPP_PROVIDER", "cloud_api") as
      | "cloud_api"
      | "twilio",
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
    // Post-diagnostic delay in minutes
    postDiagnosticDelayMinutes: parseInt(
      optionalEnv("POST_DIAGNOSTIC_DELAY_MINUTES", "10"),
      10,
    ),
    // Base URL for deep links
    appBaseUrl: optionalEnv("FIA_APP_BASE_URL", "https://fiacopilot.com"),
    // Max messages per user per day
    maxMessagesPerUserPerDay: parseInt(
      optionalEnv("MAX_MESSAGES_PER_USER_PER_DAY", "2"),
      10,
    ),
  },

  // Scheduler cron expressions
  cron: {
    // Detectors run every 15 minutes
    detectors: optionalEnv("CRON_DETECTORS", "*/15 * * * *"),
    // Weekly sponsor report: Mondays at 9 AM
    sponsorReport: optionalEnv("CRON_SPONSOR_REPORT", "0 9 * * 1"),
  },

  // Logging
  logLevel: optionalEnv("LOG_LEVEL", "info"),
} as const;
