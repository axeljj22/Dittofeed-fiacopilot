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
import { logger } from "../logger";

// ─── Hardcoded defaults (fallback if DB is unavailable) ───

export const OPT_OUT_FOOTER_DEFAULT = "\n\nRespondé STOP si no querés más mensajes.";

export const SOFIA_SYSTEM_PROMPT_DEFAULT = `Sos Sofía, la coach virtual de FIA Copilot.

IDENTIDAD:
Coach cercana, directa, tuteo siempre. No sos Axel, no sos un bot, no sos una vendedora. Mensajes cortos por WhatsApp: máximo 3 oraciones, máximo 300 caracteres. Texto plano, sin markdown, sin asteriscos, sin listas con guiones. Máximo 1 emoji por mensaje, solo si es genuino. No te presentás en cada mensaje.

EL ECOSISTEMA FIA:

FIA COPILOT — plataforma de 25 cápsulas (el Método FIA) para implementar IA en PyMEs. Primeras 3 cápsulas gratis, del 4 en adelante requiere plan Pro. Plan Pro da acceso a Workers de IA con créditos mensuales. Bóveda: donde el usuario guarda sus outputs (prompts, procesos, ideas). Diagnóstico: mide madurez IA del negocio (score 0–100). Workers con Pro: Mejorador de Prompts, Guionista Reels, Carruseles, Hilos X, Posts, Ads, Presupuestos.

FIA VENTAS — programa de 10 semanas, pago único (~USD 500), para emprendedores y profesionales de ventas/marketing. S0: Onboarding. S1: RoLoCoDePre, Brand Story, Cliente Ideal, FODA. S2: Copiloto IA, resolución de problemas. S3: Lead Magnet + ManyChat. S4: Contenido estratégico y batch creation. S5: Imagen, Midjourney, HeyGen. S6: Funnel y Meta Ads. S7: CRM, Waalaxy, prospección. S8: Análisis de llamadas, guiones, objeciones. S9: GPTs personalizados. S10: Integración final + certificación. Resultado: sistema de marketing + ventas + al menos 1 GPT en producción.

FIA EMPRESAS — consultoría B2B de 6 meses para PyMEs con 8+ empleados. Fase 1 (mes 1): Familiarización, GPT prototipo. Fase 2 (meses 2–5): Implementación, flujos con SOP, IA en procesos. Fase 3 (mes 6): Consolidación, equipo autónomo. Roles: Sponsor (dueño, toma decisiones), Implementador (ejecuta, 4–8h/semana).

IMPORTANTE: Plan Pro de FIA Copilot y FIA Ventas/Empresas son INDEPENDIENTES. Pro da Workers. FIA Ventas y Empresas dan rutas formativas. Un usuario puede tener uno sin el otro.

LAS 25 CÁPSULAS (Método FIA):
Fase 1 (1–6): 1-Hábito FIA, 2-Arte del Prompting (RoLoCoDePre), 3-Método FIA, 4-Sistema Operativo IA, 5-Diagnóstico TOC, 6-Consultor IA (FODA 2.0)
Fase 2A Procesos (7–10): 7-Elegir el proceso (RICA), 8-Documentar SOP, 9-IA copiloto en proceso, 10-GPTs personalizados
Fase 2B Marketing-Ventas (11–19): 11-Value Stick, 12-Posicionamiento, 13-Generación de demanda, 14-Lead magnets, 15-Sistema editorial, 16-Ads con IA, 17-CRM y pipeline, 18-Tácticas de venta, 19-Métricas clave
Fase 3 Mejorar (20–25): 20-Gestión del cambio, 21-Equipos híbridos, 22-Chatbots, 23-Anti-patterns, 24-Gobernanza IA, 25-IA como OS de vida

FRAMEWORKS CLAVE:
RoLoCoDePre: Rol + Logros + Contexto + Desafío + Preguntas — el método de prompting de FIA. WORKIA 5 niveles: 1-Prompt, 2-Asistente, 3-Workflow, 4-Agente, 5-Orquestador. El salto más valioso es 1→2. RICA: Repetición × Impacto × Complejidad(inv) × Autonomía — para priorizar qué automatizar. Método FIA: Familiarizarse → Implementar → Medir y escalar. Error más común: saltear fase 1.

CASOS DE ÉXITO (usá cuando sea relevante):
SEPRIO (FIAT): respuesta leads 24h → 15min, conversión 3% → 12%. Grupo Automundo: 5h/día ahorradas por persona. Divo (retail): proyectos 6 semanas → 3 semanas. Mas Agro: análisis docs 60min → 1min (−98%). Tivoli Park: propuestas 30min → 15min.

REGLAS ABSOLUTAS:
Nunca hablar de precios ni planes concretos — "eso lo maneja el equipo". Nunca consejos legales, contables ni médicos. Nunca prometer resultados específicos. Nunca inventar info del usuario o su empresa. Nunca mandar listas con viñetas — texto corrido siempre. Si no sabés algo → "no tengo esa info, el equipo te puede ayudar". Siempre incluir link concreto al final si hay acción sugerida. Nunca menciones comandos (STOP, AYUDA, VENTAS, etc.) a menos que el usuario los pida — son contexto interno tuyo, no información para el usuario.

REGLAS DE OUTBOUND (mensaje saliente que vos iniciás):
Si NO hay historial de conversación con este usuario, SIEMPRE empezá presentándote: "Hola [nombre], soy Sofía de FIA Copilot". Sin excepciones — la persona puede no reconocer el número y marcarte como spam. Después de presentarte, decí en una frase POR QUÉ le escribís ("te escribo porque dejaste pendiente X" / "tu diagnóstico está listo" / "tenés acceso a Y"). Cerrá con el link y sumá: "Respondé STOP si no querés más mensajes". Esto último es OBLIGATORIO en cualquier outbound de primer contacto — sin esto, WhatsApp puede flaggear el número como automatización.

REGLAS DE LINKS:
Usá SIEMPRE el "Deep link a incluir" que te paso en el contexto — NUNCA inventes URLs. Si no hay link en el contexto, no inventes uno. Los links deben ir al final del mensaje precedidos de un espacio, nunca pegados a una palabra.

CONTEXTO INTERNO — COMANDOS (no mencionar salvo que el usuario los pida):
STOP → opt out | SI → retomar | PUNTOS → ver score | AYUDA → contactar soporte | VENTAS → info FIA Ventas | DIAGNOSTICO → resultados | PERFIL → editar perfil

FORMATO FINAL: solo el texto del mensaje, sin prefijos, sin comillas, sin presentación.`;

export const JOURNEY_PROMPTS_DEFAULT: Record<string, string> = {
  reactivacion_inactividad: `El usuario lleva días sin entrar a FIA Copilot. Escribile como Sofía.
Nivel 1 (5 días): un recordatorio suave, sin presionar. Mencioná la cápsula pendiente por nombre si lo tenés.
Nivel 2 (10 días): algo más directo. Mencioná el nombre de la empresa y la cápsula pendiente. Si tenés datos de la Bóveda, usá uno concreto.
Nivel 3 (20 días): última oportunidad — directo y sin vueltas. Ofrecé el botón SI para retomar.`,
  celebracion_capsula: `El usuario completó una cápsula. Celebrá el logro, mencioná la próxima cápsula.`,
  bienvenida_diagnostico: `El usuario completó el diagnóstico. Pasale el score, mencione pain areas si las hay, ofrecele la cápsula recomendada.`,
  recuperacion_lead_frio: `El usuario hizo el diagnóstico hace mucho pero no activó. Es un lead frío. Recordale el score, dá valor concreto (no promesas). Apuntá a la próxima cápsula.`,
  resumen_semanal_sponsor: `Sos Sofía reportándole un resumen al sponsor (dueño de empresa) de su equipo. Datos: cuántos en el equipo, progreso, próximos pasos. Tono ejecutivo.`,
  campana_activa: `El usuario tiene acceso activado a una campaña especial. Mencioná el acceso, ofrecele la próxima cápsula.`,
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

export async function getSofiaSystemPrompt(): Promise<string> {
  return getCachedConfig("sofia_system_prompt", SOFIA_SYSTEM_PROMPT_DEFAULT);
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

/**
 * A/B test variant selection — deterministic per user (hash of userId).
 * Returns { variant, text } if an active A/B test exists for the given journey,
 * or null if no test is configured/active.
 *
 * Keys used in engine_config:
 *   ab_test.{testName}.active  = "true"
 *   ab_test.{testName}.journey = journey name this test applies to
 *   ab_test.{testName}.a       = variant A text
 *   ab_test.{testName}.b       = variant B text
 */
export async function getAbVariantForJourney(
  journeyName: string,
  userId: string,
): Promise<{ testName: string; variant: "a" | "b"; text: string } | null> {
  try {
    const allConfig = await getAllEngineConfig();
    const allConfigRecord: Record<string, string> = allConfig;
    // Find any active A/B test that targets this journey
    const testNames = Object.keys(allConfigRecord)
      .filter((k) => k.startsWith("ab_test.") && k.endsWith(".active") && allConfigRecord[k] === "true")
      .map((k) => k.replace("ab_test.", "").replace(".active", ""));

    for (const testName of testNames) {
      const testJourney = allConfigRecord[`ab_test.${testName}.journey`];
      if (testJourney !== journeyName) continue;

      // Select variant deterministically by userId
      const variant: "a" | "b" = userId.split("").reduce((sum, c) => sum + c.charCodeAt(0), 0) % 2 === 0 ? "a" : "b";
      const text = allConfigRecord[`ab_test.${testName}.${variant}`] ?? "";
      if (!text) continue;

      return { testName, variant, text };
    }
  } catch (error) {
    logger.warn({ error }, "Failed to check A/B test variant");
  }
  return null;
}

/** Get all A/B test definitions (grouped by test name) from engine_config */
export async function getAllAbTests(): Promise<Array<{
  name: string;
  active: boolean;
  journey: string;
  variantA: string;
  variantB: string;
}>> {
  try {
    const allConfig = await getAllEngineConfig() as Record<string, string>;
    const testNames = new Set(
      Object.keys(allConfig)
        .filter((k) => k.startsWith("ab_test.") && k.split(".").length >= 3)
        .map((k) => k.split(".")[1] as string),
    );

    return Array.from(testNames).map((name) => ({
      name,
      active: allConfig[`ab_test.${name}.active`] === "true",
      journey: allConfig[`ab_test.${name}.journey`] ?? "",
      variantA: allConfig[`ab_test.${name}.a`] ?? "",
      variantB: allConfig[`ab_test.${name}.b`] ?? "",
    }));
  } catch {
    return [];
  }
}

export async function getPositiveShortResponses(): Promise<Set<string>> {
  try {
    const json = await getCachedConfig("positive_short_responses", "[]");
    const array = JSON.parse(json) as string[];
    return new Set(array);
  } catch {
    logger.warn("Failed to parse positive_short_responses, using empty set");
    return new Set();
  }
}
