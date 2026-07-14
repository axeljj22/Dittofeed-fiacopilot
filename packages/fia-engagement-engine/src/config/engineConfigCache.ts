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
Respondé únicamente con la información del contexto que te paso (perfil, actividad, contenido de programas y conocimiento de FIA). No inventes datos del usuario, de su progreso, ni del contenido de los programas. Si te preguntan algo cuyo detalle no está en el contexto, decí con naturalidad que no tenés esa info a mano y que el equipo puede ayudar — nunca te lo inventes.

IMPORTANTE — lo que no podés hacer:
- No prometás "buscar y volver con la info" ni decir "te lo consigo": solo respondés en tiempo real con lo que tenés, no podés iniciar mensajes nuevos ni hacer búsquedas async.
- No prometás "revisar la base de datos", "consultar el sistema" ni nada similar: no tenés acceso a herramientas externas ni a la DB en tiempo real. Si el usuario pide que lo busques en la base de datos, decile directamente que no podés hacer eso, que mirá en la plataforma o que le pregunte al coach.
- Si no sabés algo, decilo claro y sugerí dónde encontrarlo (plataforma, coach, equipo FIA).`;

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

// ─── Skill prompt addenda (Sofía 2.0, Phase 1) ───
// Appended to the system prompt when the router selects a non-general skill. 'general' is empty so
// flag-off / general routing is byte-for-byte v1. Editable via engine_config key 'skill_prompt.<key>'.

export const SKILL_PROMPT_GENERAL_DEFAULT = "";

export const SKILL_PROMPT_CONTENT_QA_DEFAULT = `

[SKILL: DUDAS DE CONTENIDO] La persona pregunta por el contenido de SU formación. Respondé SOLO con el material del programa que viene en el contexto (cápsulas/conocimiento). Si el detalle puntual no está en el contexto, decilo con naturalidad y sugerí dónde verlo (la plataforma o el coach) — no lo inventes. Nunca mezcles contenido de otra formación que la persona no esté cursando.`;

export const SKILL_PROMPT_ADMIN_SUPPORT_DEFAULT = `

[SKILL: SOPORTE ADMINISTRATIVO] La persona tiene una duda OPERATIVA/administrativa (accesos, links, grabaciones, calendario, pagos, Skool, login), NO de contenido. Si en el contexto hay LINKS ADMINISTRATIVOS, respondé con el que corresponda. No expliques contenido de la formación. Si no tenés el dato o el link a mano, decilo y derivá a soporte o al coach. Breve y concreta.`;

export const SKILL_PROMPT_ACCOUNTABILITY_DEFAULT = `

[SKILL: SEGUIMIENTO] La persona pregunta por su avance o pide seguimiento. Usá los datos de progreso del contexto (cápsulas completadas, en curso, próxima). Devolvé una lectura corta y motivadora de cómo viene y UNA próxima acción concreta (la cápsula/paso que sigue). No la regañes si está atrasada: invitala con calidez. No expliques el contenido en sí, enfocate en el avance.`;

export const SKILL_PROMPT_SALES_DEFAULT = `

[SKILL: VENTAS] La persona muestra interés en un programa o pregunta cómo sumarse. Tu objetivo: mostrar el valor de forma natural según su negocio y sus dolores, sin presionar. NUNCA des precios ni planes concretos (eso lo maneja el equipo). Si hay interés real de avanzar, usá la herramienta para escalar a un humano (que un asesor lo contacte) en vez de prometer que "alguien lo va a llamar".`;

export const SKILL_PROMPT_DEFAULTS: Record<string, string> = {
  general: SKILL_PROMPT_GENERAL_DEFAULT,
  content_qa: SKILL_PROMPT_CONTENT_QA_DEFAULT,
  accountability: SKILL_PROMPT_ACCOUNTABILITY_DEFAULT,
  admin_support: SKILL_PROMPT_ADMIN_SUPPORT_DEFAULT,
  sales: SKILL_PROMPT_SALES_DEFAULT,
};

/** The system-prompt addendum for a skill (editable via engine_config 'skill_prompt.<key>'). */
export async function getSkillPromptAddendum(skillKey: string): Promise<string> {
  return getCachedConfig(`skill_prompt.${skillKey}`, SKILL_PROMPT_DEFAULTS[skillKey] ?? "");
}

// ─── Tool-use grounding (Sofía 2.0, Phase 3) ───
// Appended to the system prompt ONLY when the tool loop runs. Overrides the default grounding rule
// that says Sofía can't query the DB — with tools she can. Editable via engine_config.

export const SOFIA_GROUNDING_RULES_TOOLS_DEFAULT = `

[MODO HERRAMIENTAS] Tenés herramientas para consultar en tiempo real (contenido de cápsulas, base de conocimiento, progreso del alumno, links administrativos). Esto REEMPLAZA cualquier regla anterior que diga que no podés consultar la base: acá SÍ podés, usando tus herramientas. Reglas: usá una herramienta cuando necesites un dato que no tengas; si una herramienta no devuelve nada, decilo con naturalidad y no lo inventes; nunca inventes resultados; respondé corto por WhatsApp una vez que tengas la info.`;

export async function getToolsGroundingAddendum(): Promise<string> {
  return getCachedConfig("sofia_grounding_rules_tools", SOFIA_GROUNDING_RULES_TOOLS_DEFAULT);
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

// Internal staff report cron — editable from the DB (engine_config.internal_report_schedule).
export const INTERNAL_REPORT_SCHEDULE_DEFAULT = "0 18 * * 0"; // Sunday 18:00 (timezone applied in scheduler)

export async function getInternalReportSchedule(): Promise<string> {
  return getCachedConfig("internal_report_schedule", INTERNAL_REPORT_SCHEDULE_DEFAULT);
}

/** JID of the internal control group (where the report + approval loop live). "" if unset. */
export async function getInternalReportGroupJid(): Promise<string> {
  return getCachedConfig("internal_report_group_jid", "");
}

// ─── Tracking link base (domain for /r/{id} click-redirects, editable from the panel) ───
// Default = the engine's own URL (current behavior). Flip to https://fiacopilot.com once the
// FC app serves the /r/[id] redirect, so users never see the engine domain in their messages.
export const TRACKING_LINK_BASE_DEFAULT = config.engine.engineBaseUrl;

export async function getTrackingLinkBase(): Promise<string> {
  const base = await getCachedConfig("tracking_link_base", TRACKING_LINK_BASE_DEFAULT);
  return base.replace(/\/+$/, ""); // no trailing slash
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
  "skill_prompt.general": SKILL_PROMPT_GENERAL_DEFAULT,
  "skill_prompt.content_qa": SKILL_PROMPT_CONTENT_QA_DEFAULT,
  "skill_prompt.accountability": SKILL_PROMPT_ACCOUNTABILITY_DEFAULT,
  "skill_prompt.admin_support": SKILL_PROMPT_ADMIN_SUPPORT_DEFAULT,
  "skill_prompt.sales": SKILL_PROMPT_SALES_DEFAULT,
  sofia_grounding_rules_tools: SOFIA_GROUNDING_RULES_TOOLS_DEFAULT,
  activation_welcome_message: ACTIVATION_WELCOME_DEFAULT,
  opt_out_footer: OPT_OUT_FOOTER_DEFAULT,
  report_schedule: REPORT_SCHEDULE_DEFAULT,
  tracking_link_base: TRACKING_LINK_BASE_DEFAULT,
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
