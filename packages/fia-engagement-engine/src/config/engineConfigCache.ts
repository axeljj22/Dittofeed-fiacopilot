/**
 * In-memory cache for engine configuration (prompts, templates, command replies).
 * Provides 5-minute TTL with fallback to hardcoded defaults if DB is unavailable.
 * Zero downtime guarantee: if Supabase is down, hardcoded defaults are used.
 */

import {
  getEngineConfig,
  getAllEngineConfig,
  setEngineConfig as dbSetEngineConfig,
} from "../db/supabase";
import { config } from "../config";
import { logger } from "../logger";

// ─── Hardcoded defaults (fallback if DB is unavailable) ───

export const OPT_OUT_FOOTER_DEFAULT = "\n\nRespondé STOP si no querés más mensajes.";

/**
 * Sofía's system prompt is split into 3 editable parts (engine_config keys):
 *   sofia_personality      — who she is, tone, style, outbound/opt-out rules
 *   sofia_programs_catalog — short list of programs she can enumerate (detail comes from DB)
 *   sofia_grounding_rules  — anti-hallucination rules (answer only from provided context)
 * assembleSystemPrompt() concatenates them at runtime. getSofiaSystemPrompt() returns the whole.
 */
export const SOFIA_PERSONALITY_DEFAULT = `Sos Sofía, la coach virtual de FIA Copilot.

IDENTIDAD Y TONO:
Coach cercana, directa, tuteo siempre. No sos Axel, no sos un bot, no sos una vendedora. Mensajes cortos por WhatsApp: máximo 3 oraciones, máximo 300 caracteres. Texto plano, sin markdown, sin asteriscos, sin listas con guiones. Máximo 1 emoji por mensaje, solo si es genuino. No te presentás en cada mensaje.

REGLAS ABSOLUTAS:
Nunca hablar de precios ni planes concretos — "eso lo maneja el equipo". Nunca consejos legales, contables ni médicos. Nunca prometer resultados específicos. Nunca inventar info del usuario o su empresa. Nunca mandar listas con viñetas — texto corrido siempre. Si no sabés algo → "no tengo esa info, el equipo te puede ayudar". Siempre incluir link concreto al final si hay acción sugerida. Nunca menciones comandos (STOP, AYUDA, etc.) salvo que el usuario los pida.

REGLAS DE OUTBOUND (mensaje saliente que vos iniciás):
Si NO hay historial de conversación con este usuario, SIEMPRE empezá presentándote: "Hola [nombre], soy Sofía de FIA Copilot". La persona puede no reconocer el número y marcarte como spam. Después de presentarte, decí en una frase POR QUÉ le escribís. Cerrá con el link y sumá "Respondé STOP si no querés más mensajes" en el primer contacto.

OPT-OUT CONVERSACIONAL:
Si interpretás que la persona no quiere seguir recibiendo mensajes (lo dice de cualquier forma, se muestra molesta, o pide parar), decile de forma amable que responda STOP para no recibir más. No insistas.

REGLAS DE LINKS:
Usá SIEMPRE el "Deep link a incluir" del contexto — NUNCA inventes URLs. Si no hay link en el contexto, no inventes uno. Los links van al final del mensaje, precedidos de un espacio.

FORMATO FINAL: solo el texto del mensaje, sin prefijos, sin comillas, sin presentación adicional.`;

export const SOFIA_PROGRAMS_CATALOG_DEFAULT = `LOS PROGRAMAS DE FIA (catálogo breve — el detalle de cada cápsula/paso viene en el contexto que te paso):

FIA COPILOT (Método de 25 pasos) — plataforma para implementar IA en PyMEs paso a paso. Las primeras 3 cápsulas son gratis; el resto requiere plan Pro. Pro suma Workers de IA y la Bóveda (donde el usuario guarda sus outputs).
FIA VENTAS — programa de 10 semanas para emprendedores y profesionales de ventas/marketing. Resultado: un sistema de marketing + ventas con IA y al menos 1 GPT en producción.
FIA EMPRESAS — consultoría B2B de ~6 meses para PyMEs con equipo. Roles: Sponsor (decide) e Implementador (ejecuta). 3 fases: familiarización, implementación, consolidación.
FIA AGÉNTICA — programa por semanas con clases en vivo sobre agentes y automatización con IA.

Podés enumerar estos programas si te preguntan. Para explicar el contenido concreto de una cápsula, paso, semana o fase, usá SOLO lo que aparece en el contexto (viene de la base de datos). Si el detalle no está en el contexto, decí que no lo tenés a mano y ofrecé derivar al equipo.`;

export const SOFIA_GROUNDING_RULES_DEFAULT = `REGLAS PARA NO ALUCINAR:
Respondé únicamente con la información del contexto que te paso (perfil, actividad, contenido de programas y conocimiento de FIA). No inventes datos del usuario, de su progreso, ni del contenido de los programas. Si te preguntan algo cuyo detalle no está en el contexto, decí con naturalidad que no tenés esa info a mano y que el equipo puede ayudar — nunca te lo inventes.`;

/** Kept for reference/backward compat — the legacy single-blob default (no longer used directly). */
export const SOFIA_SYSTEM_PROMPT_DEFAULT = `${SOFIA_PERSONALITY_DEFAULT}\n\n${SOFIA_PROGRAMS_CATALOG_DEFAULT}\n\n${SOFIA_GROUNDING_RULES_DEFAULT}`;

/** Single journey: the weekly report. Branches inside the prompt based on the context provided. */
export const JOURNEY_PROMPTS_DEFAULT: Record<string, string> = {
  reporte_semanal: `Escribile a la persona como Sofía un breve reporte semanal por WhatsApp.
El contexto te dice si la persona está en un track formativo (FIA Ventas / Empresas / Agéntica) o si es usuaria premium siguiendo el Método de 25 pasos.
1) Hacé un recap corto y concreto de lo que hizo esta semana (cápsulas/pasos completados, actividad). Si no hizo nada, no la regañes — invitala con calidez.
2) Sugerí UNA próxima acción puntual: la próxima cápsula/paso pendiente que viene en el contexto, mencionándola por nombre.
3) Cerrá con el deep link a esa próxima acción.
Tono cálido y directo, máximo 3 oraciones. Si la persona en el historial pidió no recibir mensajes, no insistas.`,
};

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Gets a config value from cache or DB, with fallback to a hardcoded default.
 * Always returns a string (never null) — uses fallback if DB is unavailable.
 */
export async function getCachedConfig(
  key: string,
  fallback: string,
): Promise<string> {
  const now = Date.now();

  // Check cache
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  // Cache miss or expired — fetch from DB
  try {
    const value = await getEngineConfig(key);
    if (value !== null) {
      // Cache hit in DB
      cache.set(key, {
        value,
        expiresAt: now + CACHE_TTL_MS,
      });
      return value;
    }
  } catch (error) {
    logger.warn({ error, key }, "Failed to fetch config from DB, using fallback");
  }

  // DB miss or error — use fallback (but don't cache it to retry next time)
  return fallback;
}

/**
 * Invalidates a specific config key's cache, or all cache if key is omitted.
 * Call this after PUT /api/config/:key to refresh immediately.
 */
export function invalidateCache(key?: string): void {
  if (key) {
    cache.delete(key);
    logger.debug({ key }, "Cache invalidated for key");
  } else {
    cache.clear();
    logger.debug("Full cache cleared");
  }
}

/**
 * Warm cache on server startup — loads all config keys from DB.
 * If DB is down, this fails silently and defaults are used per getCachedConfig().
 */
export async function warmCache(): Promise<void> {
  try {
    const allConfig = await getAllEngineConfig();
    const now = Date.now();

    for (const [key, value] of Object.entries(allConfig)) {
      cache.set(key, {
        value,
        expiresAt: now + CACHE_TTL_MS,
      });
    }

    logger.info(
      { count: Object.keys(allConfig).length },
      "Engine config cache warmed",
    );
  } catch (error) {
    logger.warn(
      { error },
      "Failed to warm config cache — will use hardcoded defaults",
    );
  }
}

/**
 * Saves a config value and invalidates its cache.
 */
export async function setCachedConfig(
  key: string,
  value: string,
  updatedBy?: string,
): Promise<void> {
  await dbSetEngineConfig(key, value, updatedBy);
  invalidateCache(key);
}

// ─── Specialized getters (use getCachedConfig internally for fallback) ───

export async function getSofiaPersonality(): Promise<string> {
  return getCachedConfig("sofia_personality", SOFIA_PERSONALITY_DEFAULT);
}

export async function getSofiaProgramsCatalog(): Promise<string> {
  return getCachedConfig("sofia_programs_catalog", SOFIA_PROGRAMS_CATALOG_DEFAULT);
}

export async function getSofiaGroundingRules(): Promise<string> {
  return getCachedConfig("sofia_grounding_rules", SOFIA_GROUNDING_RULES_DEFAULT);
}

/**
 * Assembles Sofía's full system prompt from the 3 modular parts.
 * This is the single source of truth used by every generation path.
 */
export async function assembleSystemPrompt(): Promise<string> {
  const [personality, catalog, grounding] = await Promise.all([
    getSofiaPersonality(),
    getSofiaProgramsCatalog(),
    getSofiaGroundingRules(),
  ]);
  return `${personality}\n\n${catalog}\n\n${grounding}`;
}

/** Backward-compatible accessor — returns the assembled modular prompt. */
export async function getSofiaSystemPrompt(): Promise<string> {
  return assembleSystemPrompt();
}

export async function getOptOutFooter(): Promise<string> {
  return getCachedConfig("opt_out_footer", OPT_OUT_FOOTER_DEFAULT);
}

export async function getJourneyPrompt(journeyName: string): Promise<string> {
  const defaultPrompt = JOURNEY_PROMPTS_DEFAULT[journeyName] ?? "Genera un mensaje de seguimiento personalizado.";
  return getCachedConfig(`journey_prompt.${journeyName}`, defaultPrompt);
}

export async function getMessageTemplate(templateKey: string): Promise<string | null> {
  // Templates are function-based in messageGenerator, but we return null here
  // since templates with interpolation need special handling. Will address in messageGenerator.
  return getCachedConfig(`template.${templateKey}`, "");
}

export async function getCommandReply(command: string): Promise<string | null> {
  return getCachedConfig(`cmd_reply.${command.toLowerCase()}`, "");
}

const ACTIVATION_WELCOME_DEFAULT = `Hola {{nombre}}, soy Sofía, tu asistente de FIA Copilot 🙋‍♀️
Ya estoy activa y podés escribirme cuando quieras. Te ayudo con tus cápsulas, con la bóveda, o con cualquier duda del programa.
Respondé AYUDA si querés ver qué puedo hacer.`;

export async function getActivationWelcomeMessage(): Promise<string> {
  return getCachedConfig("activation_welcome_message", ACTIVATION_WELCOME_DEFAULT);
}

// ─── Weekly report schedule (cron expression, editable from the panel) ───

/** Default: Sundays 17:00 (node-cron: minute hour day-of-month month day-of-week; 0 = Sunday). */
export const REPORT_SCHEDULE_DEFAULT = "0 17 * * 0";

export async function getReportSchedule(): Promise<string> {
  return getCachedConfig("report_schedule", REPORT_SCHEDULE_DEFAULT);
}

export async function getPositiveShortResponses(): Promise<Set<string>> {
  try {
    const json = await getCachedConfig("positive_short_responses", POSITIVE_SHORT_RESPONSES_DEFAULT);
    const array = JSON.parse(json) as string[];
    return new Set(array);
  } catch {
    logger.warn("Failed to parse positive_short_responses, using empty set");
    return new Set();
  }
}

// ─── Defaults registry (single source of truth for seeding the admin panel) ───

const APP = config.engine.appBaseUrl;

/** Default list of short replies that should NOT count as low-engagement. */
export const POSITIVE_SHORT_RESPONSES_DEFAULT = JSON.stringify([
  "si", "sí", "dale", "ok", "okay", "bueno", "claro", "listo", "va", "vamos",
  "gracias", "muchas gracias", "genial", "perfecto", "entendido", "excelente",
  "me interesa", "contame", "quiero", "adelante", "seguí", "segui",
  "no entiendo", "no sé", "explicame", "ayuda", "como hago",
  "hola", "buenas", "buen día", "buenos días", "buenas tardes", "buenas noches",
  "chau", "nos vemos", "hasta luego", "saludos",
]);

/** Defaults for command replies (match the hardcoded texts in senders/responses.ts). */
export const CMD_REPLY_DEFAULTS: Record<string, string> = {
  "cmd_reply.stop": "Listo, no recibirás más mensajes de seguimiento. Si en algún momento querés retomar, respondé SI.",
  "cmd_reply.si": `¡Genial! Tu progreso te espera: ${APP}/dashboard`,
  "cmd_reply.ayuda": `Agendá una llamada con el equipo acá: ${APP}/agendar`,
  "cmd_reply.ventas": `Mirá todo lo que incluye FIA Ventas acá: ${APP}/upgrade?ref=wa_ventas`,
  "cmd_reply.diagnostico": `Tus resultados del diagnóstico están acá: ${APP}/diagnostico`,
  "cmd_reply.perfil": `Editá tu perfil desde acá: ${APP}/perfil`,
  "cmd_reply.puntos": `Tu score de FIA está disponible en tu dashboard: ${APP}/dashboard`,
  "cmd_reply.low_engagement_close": `Cuando quieras retomar estoy acá. Tu dashboard: ${APP}/dashboard`,
};

/** Every config key the engine uses today, mapped to its default. Used to seed the panel. */
export const CONFIG_DEFAULTS: Record<string, string> = {
  sofia_personality: SOFIA_PERSONALITY_DEFAULT,
  sofia_programs_catalog: SOFIA_PROGRAMS_CATALOG_DEFAULT,
  sofia_grounding_rules: SOFIA_GROUNDING_RULES_DEFAULT,
  "journey_prompt.reporte_semanal": JOURNEY_PROMPTS_DEFAULT["reporte_semanal"] ?? "",
  activation_welcome_message: ACTIVATION_WELCOME_DEFAULT,
  opt_out_footer: OPT_OUT_FOOTER_DEFAULT,
  report_schedule: REPORT_SCHEDULE_DEFAULT,
  positive_short_responses: POSITIVE_SHORT_RESPONSES_DEFAULT,
  ...CMD_REPLY_DEFAULTS,
};

/** Keys left over from the pre-reconversion engine — deleted on seed so the panel stays clean. */
export const STALE_CONFIG_KEYS: string[] = [
  "sofia_system_prompt",
  "journey_prompt.reactivacion_inactividad",
  "journey_prompt.celebracion_capsula",
  "journey_prompt.bienvenida_diagnostico",
  "journey_prompt.recuperacion_lead_frio",
  "journey_prompt.resumen_semanal_sponsor",
  "journey_prompt.campana_activa",
  "segment_followup_config",
  "program_slug_path_map",
];

/** Stale key prefixes (e.g. all A/B test keys) to purge on seed. */
export const STALE_CONFIG_PREFIXES: string[] = ["ab_test."];
