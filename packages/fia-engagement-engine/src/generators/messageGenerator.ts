/**
 * Generador de mensajes — Reporte semanal (outbound) + respuestas inbound de Sofía.
 *
 * Outbound: un único journey (reporte_semanal). Contexto = recap de la semana + próxima acción
 * del track (o Método de 25 pasos) + conocimiento de FIA desde la DB (anti-alucinación).
 * Inbound: Sofía responde texto libre con memoria de conversación.
 *
 * Cadena de generación: Codex (ChatGPT Plus) → Claude API → template de fallback.
 */
import { config } from "../config";
import { logger } from "../logger";
import {
  getSofiaSystemPrompt,
  getOptOutFooter,
  getJourneyPrompt,
} from "../config/engineConfigCache";
import {
  getProfileWithWhatsapp,
  getVaultOutputsForUser,
  getCapsuleProgressForUser,
  getCapsules,
  getPathTotals,
  resolveUserPaths,
  getLeadScoreForUser,
  getAssessmentForUser,
  getConversationHistory,
  appendConversationMessages,
  getConversationState,
  upsertConversationState,
  getKnowledge,
} from "../db/supabase";
import type { UserSegment, KnowledgeEntry } from "../db/supabase";
import type { EngagementOpportunity, VaultOutput, AssessmentSubmission } from "../db/types";
import type { WeeklyReportContext } from "../detectors/weeklyReport";
import { generateWithCodex, generateWithCodexConversation } from "./codexGenerator";

export interface GeneratedMessage {
  text: string;
  journeyName: string;
  deepLink: string;
  /** Which path produced the text — surfaced to the conversation log for observability. */
  source?: "codex" | "claude" | "template";
  truncated?: boolean;
}

const FIRST_CONTACT_INTRO = (nombre: string) => `Hola ${nombre}, soy Sofía de FIA Copilot 👋`;

/** Host of the public app (fiacopilot.com) — the only domain allowed in user-facing links. */
const FIACO_HOST = (() => {
  try { return new URL(config.engine.appBaseUrl).host; } catch { return "fiacopilot.com"; }
})();

/**
 * Removes any http(s) URL whose host is NOT fiacopilot.com (defends against model-invented
 * links / the engine domain leaking). Per product rule: send a correct fiacopilot link or none.
 */
function stripForeignUrls(text: string): string {
  return text
    .replace(/https?:\/\/[^\s]+/g, (m) => (m.includes(FIACO_HOST) ? m : ""))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +\n/g, "\n")
    .trim();
}

// ─── Shared helpers ───

/** Maps assessment answers.m_size to a simplified segment label (used by inbound context). */
function resolveCompanySize(assessment: AssessmentSubmission | null): "emprendedor" | "empresa" | null {
  const mSize = assessment?.answers?.["m_size"] as string | undefined;
  if (!mSize) return null;
  if (mSize === "Solo" || mSize === "2-5") return "emprendedor";
  return "empresa";
}

function buildVaultContext(outputs: VaultOutput[]): string {
  if (outputs.length === 0) return "Sin outputs guardados en la Bóveda aún.";

  const sections: string[] = [];

  const businessContext = outputs
    .filter((o) => o.content_type === "context_business")
    .map((o) => o.content)
    .slice(0, 3);

  if (businessContext.length > 0) {
    sections.push(`Contexto de negocio:\n${businessContext.join("\n")}`);
  }

  const recentOutputs = outputs.slice(0, 5).map(
    (o) => `- (${o.content_type}): ${o.content.slice(0, 200)}`,
  );

  sections.push(`Outputs recientes:\n${recentOutputs.join("\n")}`);

  return sections.join("\n\n");
}

/** Formats knowledge-base entries for grounding (anti-hallucination). */
function formatKnowledge(entries: KnowledgeEntry[]): string {
  if (entries.length === 0) return "";
  const top = entries
    .slice(0, 8)
    .map((e) => {
      const body = e.summary && e.summary.trim() ? e.summary : e.content;
      const voice = e.voice_notes ? ` (voz: ${e.voice_notes.slice(0, 160)})` : "";
      return `• [${e.category}] ${e.title}: ${(body ?? "").slice(0, 350)}${voice}`;
    })
    .join("\n");
  return `\n\nCONOCIMIENTO DE FIA (basate SOLO en esto para hablar de frameworks/método/voz — no inventes):\n${top}`;
}

// ─── Weekly report context ───

function buildWeeklyReportContext(
  opportunity: EngagementOpportunity,
  knowledge: KnowledgeEntry[],
): string {
  const c = opportunity.context as WeeklyReportContext;
  const profile = opportunity.profile;

  const completed = c.completedThisWeek ?? [];
  const completedLine =
    completed.length > 0
      ? completed.map((x) => `Cápsula ${x.number}${x.title ? `: ${x.title}` : ""}`).join(", ")
      : "ninguna esta semana";

  const next =
    c.nextCapsuleNumber != null
      ? `Cápsula ${c.nextCapsuleNumber}${c.nextCapsuleTitle ? `: ${c.nextCapsuleTitle}` : ""}${c.nextMiniAction ? ` — acción: ${c.nextMiniAction}` : ""}`
      : "no hay próxima acción pendiente (programa completo)";

  return `
PERFIL DEL USUARIO:
- Nombre: ${profile.name ?? "ahí"}
- Empresa: ${profile.company_name ?? "—"}
- Programa: ${c.programName}${c.isTrack ? " (track formativo)" : " (Método de 25 pasos / premium)"}
- Progreso: ${c.pathProgress}

RESUMEN DE LA SEMANA:
- Cápsulas/pasos completados esta semana: ${completedLine}
- Eventos de actividad en la semana: ${c.weekActivityCount}

PRÓXIMA ACCIÓN SUGERIDA:
- ${next}

DEEP LINK A INCLUIR: ${opportunity.deepLink}${formatKnowledge(knowledge)}
`.trim();
}

// ─── AI generation (Codex + Claude) ───

async function generateWithClaude(
  opportunity: EngagementOpportunity,
  userContext: string,
  journeyPrompt: string,
): Promise<GeneratedMessage | null> {
  try {
    const [systemPrompt, Anthropic] = await Promise.all([
      getSofiaSystemPrompt(),
      import("@anthropic-ai/sdk").then((m) => m.default),
    ]);
    const client = new Anthropic({ apiKey: config.anthropic.apiKey });

    const response = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `${journeyPrompt}\n\n${userContext}\n\nGenera SOLO el texto del mensaje de WhatsApp, sin explicaciones ni prefijos.`,
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      logger.error({ userId: opportunity.userId }, "No text in Claude response");
      return null;
    }

    return {
      text: textBlock.text.trim(),
      journeyName: opportunity.journeyName,
      deepLink: opportunity.deepLink,
      source: "claude",
    };
  } catch (error) {
    logger.error(
      { error, userId: opportunity.userId },
      "Claude generation failed — falling back to template",
    );
    return null;
  }
}

/** Deterministic fallback when both AI providers are unavailable. */
async function generateWeeklyFallback(
  opportunity: EngagementOpportunity,
): Promise<GeneratedMessage> {
  const footer = await getOptOutFooter();
  const c = opportunity.context as WeeklyReportContext;
  const nombre = opportunity.profile.name || "ahí";
  const done = (c.completedThisWeek ?? []).length;
  const recap =
    done > 0
      ? `Esta semana avanzaste ${done} ${done === 1 ? "cápsula" : "cápsulas"} 🙌`
      : "Esta semana no registramos avances, pero podés retomar cuando quieras";
  const next =
    c.nextCapsuleNumber != null
      ? ` Tu próximo paso: ${c.nextCapsuleNumber}${c.nextCapsuleTitle ? ` (${c.nextCapsuleTitle})` : ""}.`
      : "";
  const text = `${FIRST_CONTACT_INTRO(nombre)} ${recap}.${next} ${opportunity.deepLink}` + footer;
  return {
    text,
    journeyName: opportunity.journeyName,
    deepLink: opportunity.deepLink,
    source: "template",
  };
}

// ─── Message length enforcement ───

const MAX_MESSAGE_CHARS = 320;

/**
 * Sanitize an outbound message before sending:
 * 1. Replace any URL the model invented with the canonical deepLink
 * 2. Enforce length (preserves deepLink at the end, even if body has to be truncated)
 */
function enforceLength(text: string, deepLink: string): { text: string; truncated: boolean } {
  // Drop any non-fiacopilot URL the model may have invented before anything else.
  let safe = stripForeignUrls(text);

  // Step 1: if the model wrote a fiacopilot.com URL that differs from deepLink, swap it
  const urlPattern = /https?:\/\/(?:www\.)?fiacopilot\.com[^\s]*/g;
  const urls = safe.match(urlPattern) ?? [];
  for (const url of urls) {
    if (url !== deepLink) {
      safe = safe.replace(url, deepLink);
    }
  }

  // Step 2: ensure the deepLink is present at the end of the message
  if (deepLink && !safe.includes(deepLink)) {
    safe = `${safe} ${deepLink}`;
  }

  if (safe.length <= MAX_MESSAGE_CHARS) return { text: safe, truncated: false };

  // Truncation: keep the deepLink at the end, trim body to fit
  const linkIndex = safe.lastIndexOf(deepLink);
  const bodyBudget = MAX_MESSAGE_CHARS - deepLink.length - 1; // 1 for space
  if (bodyBudget < 40) {
    return { text: deepLink, truncated: true };
  }
  let body = safe.slice(0, linkIndex).trim();
  if (body.length > bodyBudget) {
    const cut = body.slice(0, bodyBudget);
    const lastBoundary = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"), cut.lastIndexOf("\n"));
    body = lastBoundary > bodyBudget * 0.5 ? cut.slice(0, lastBoundary + 1) : cut.replace(/\s+\S*$/, "") + "…";
  }
  return { text: `${body.trim()} ${deepLink}`, truncated: true };
}

/** Applies enforceLength to a GeneratedMessage and carries the truncated flag. */
function finalizeMessage(msg: GeneratedMessage): GeneratedMessage {
  const { text, truncated } = enforceLength(msg.text, msg.deepLink);
  return { ...msg, text, truncated };
}

// ─── Capsule cache (never changes — avoid fetching on every inbound message) ───

let _capsulesCache: Awaited<ReturnType<typeof getCapsules>> | null = null;
let _cacheExpiry = 0;

async function getCapsulesCached() {
  if (_capsulesCache && Date.now() < _cacheExpiry) return _capsulesCache;
  _capsulesCache = await getCapsules();
  _cacheExpiry = Date.now() + 60 * 60 * 1000; // 1h TTL
  return _capsulesCache;
}

// ─── Inbound fallbacks when AI is unavailable (rotating, not random) ───

const INBOUND_FALLBACKS = [
  "Te leo. Contame si querés avanzar en las cápsulas, resolver una duda o hablar con el equipo.",
  "Estoy acá. ¿Querés que te guíe al siguiente paso o preferís hablar con el equipo?",
  "Recibido. ¿En qué te puedo ayudar — seguir con el programa, una duda puntual o algo más?",
  "Anotado. Decime por dónde querés seguir — cápsula, duda concreta, o agendar con el equipo.",
];

// Track last-used fallback index per user to rotate (simple in-memory, resets on restart)
const _fallbackIndexByUser = new Map<string, number>();
function nextFallback(userId: string): string {
  const prev = _fallbackIndexByUser.get(userId) ?? -1;
  const next = (prev + 1) % INBOUND_FALLBACKS.length;
  _fallbackIndexByUser.set(userId, next);
  return INBOUND_FALLBACKS[next] as string;
}

// Cooldown per-user: si IA falla 3 veces en <5min para este user, devolver fallback directo
const _aiFailureByUser = new Map<string, number[]>();
const COOLDOWN_WINDOW_MS = 5 * 60 * 1000;
const COOLDOWN_THRESHOLD = 3;

function isInAiCooldown(userId: string): boolean {
  const now = Date.now();
  const failures = _aiFailureByUser.get(userId) ?? [];
  const recent = failures.filter((t) => now - t < COOLDOWN_WINDOW_MS);
  if (recent.length !== failures.length) _aiFailureByUser.set(userId, recent);
  return recent.length >= COOLDOWN_THRESHOLD;
}

function recordAiFailure(userId: string): void {
  const now = Date.now();
  const failures = (_aiFailureByUser.get(userId) ?? []).filter((t) => now - t < COOLDOWN_WINDOW_MS);
  failures.push(now);
  _aiFailureByUser.set(userId, failures);
  if (_aiFailureByUser.size > 1000) {
    const oldest = Array.from(_aiFailureByUser.entries())
      .sort(([, a], [, b]) => Math.max(...a) - Math.max(...b))[0];
    if (oldest) _aiFailureByUser.delete(oldest[0]);
  }
}

// ─── User fact extraction ───
const FACT_PATTERNS: Array<{ regex: RegExp; format: (m: RegExpMatchArray) => string }> = [
  { regex: /\b(?:tengo|tenemos|somos|son)\b[^.!?]{0,40}\b(\d{1,3})\s*(?:personas|empleados|colaboradores|gente)/i, format: (m) => `Tamaño de equipo: ${m[1]} personas` },
  { regex: /\bsoy\s+(contador|abogado|dueñ[oa]|fundador[a]?|ceo|director[a]?|gerente|freelance|consultor[a]?|emprendedor[a]?|coach|m[ée]dico|arquitect[oa]|ingenier[oa]|diseñador[a]?|programador[a]?|developer)\b/i, format: (m) => `Profesión: ${m[1]}` },
  { regex: /\b(?:tengo|manejo|dirijo|fundé|fund[ée])\s+(?:una?\s+)?(agencia|empresa|pyme|startup|consultora|estudio|negocio|comercio|tienda|fábrica|inmobiliaria|clínica|gimnasio|escuela)\b/i, format: (m) => `Tipo de negocio: ${m[1]}` },
  { regex: /\bfactur[oa]?(?:mos)?\s+(?:unos?\s+)?\$?\s*([\d.,kKmM]+)/i, format: (m) => `Facturación mencionada: ${m[1]}` },
  { regex: /\b(?:atascad[oa]|trabad[oa]|no\s+puedo|cuesta)\b[^.!?]{0,30}\bc[áa]psula\s+(\d+)/i, format: (m) => `Atascado en cápsula ${m[1]}` },
  { regex: /\b(?:uso|trabajo\s+con|conozco)\s+(chatgpt|claude|gemini|copilot|midjourney|dall[\s-]?e)/i, format: (m) => `Usa: ${m[1]}` },
  { regex: /\b(no\s+tengo\s+tiempo|estoy\s+ocupad[oa]|a\s+fin\s+de\s+mes|la\s+pr[oó]xima\s+semana|el\s+pr[oó]ximo\s+mes)\b/i, format: (m) => `Disponibilidad: ${m[1].toLowerCase()}` },
];

const FACT_MAX_LEN = 120;

function sanitizeFact(fact: string): string | null {
  let s = fact.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (s.length === 0) return null;
  const suspicious = /\b(ignore|disregard|forget|olvidate|olvidá|sistema|system\s*prompt|admin|password|api[_\s]?key|bearer|sudo)\b/i;
  if (suspicious.test(s)) return null;
  if (s.length > FACT_MAX_LEN) s = s.slice(0, FACT_MAX_LEN - 1) + "…";
  return s;
}

function extractFacts(text: string): string[] {
  const found: string[] = [];
  for (const { regex, format } of FACT_PATTERNS) {
    const match = text.match(regex);
    if (match) {
      const cleaned = sanitizeFact(format(match));
      if (cleaned) found.push(cleaned);
    }
  }
  return found;
}

function mergeFacts(existing: string[], incoming: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const f of [...incoming, ...existing]) {
    const cleaned = sanitizeFact(f);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(cleaned);
    }
    if (merged.length >= 8) break;
  }
  return merged;
}

// ─── Detección de "ocupado" — pausar outbound ───
const BUSY_PATTERNS = [
  /\b(ahora\s+no|m[áa]s\s+tarde|despu[eé]s|luego)\b/i,
  /\b(ma[ñn]ana|en\s+un\s+rato|en\s+unas?\s+horas?)\b/i,
  /\b(la\s+pr[oó]xima\s+semana|el\s+pr[oó]ximo\s+mes|fin\s+de\s+(?:semana|mes))\b/i,
  /\b(estoy\s+ocupad[oa]|no\s+tengo\s+tiempo|no\s+puedo\s+ahora|estoy\s+en\s+(?:una\s+)?reuni[oó]n|en\s+el\s+trabajo)\b/i,
];

/** Returns pause duration in hours, or 0 if user didn't signal busy. */
export function detectBusySignal(text: string): number {
  const lower = text.toLowerCase();
  if (/\bma[ñn]ana\b/i.test(lower)) return 18;
  if (/\bla\s+pr[oó]xima\s+semana\b/i.test(lower)) return 7 * 24;
  if (/\bel\s+pr[oó]ximo\s+mes|fin\s+de\s+mes\b/i.test(lower)) return 14 * 24;
  if (/\b(estoy\s+ocupad[oa]|no\s+tengo\s+tiempo|reuni[oó]n)\b/i.test(lower)) return 24;
  for (const p of BUSY_PATTERNS) if (p.test(lower)) return 8;
  return 0;
}

// ─── Public API ───

const useClaudeAI =
  config.anthropic.apiKey !== "placeholder" &&
  config.anthropic.apiKey !== "";

function resolveSegmentInfo(segment: UserSegment): { name: string; objective: string } {
  if (segment.isFiaEmpresas) {
    if (segment.orgRole === "sponsor") {
      return {
        name: "FIA Empresas - Sponsor",
        objective:
          "El usuario es Sponsor de FIA Empresas (dueño o decisor). Puede preguntarte sobre el progreso de su equipo, los implementadores, o la hoja de ruta. Tu objetivo: mantenerlo informado y motivado. Si pregunta algo técnico de implementación, derivá al equipo.",
      };
    }
    return {
      name: "FIA Empresas - Implementador",
      objective:
        "El usuario está implementando FIA Empresas en su empresa (rol implementador, 4–8h/semana). Tu objetivo: ayudarlo a avanzar en la fase que corresponde, resolver dudas sobre el proceso, guiarlo en documentación de SOPs o creación de asistentes IA. Conocé bien las 3 fases del programa.",
    };
  }
  if (segment.isFiaVentas) {
    return {
      name: "FIA Ventas - Alumno",
      objective:
        "El usuario es alumno de FIA Ventas. Tu objetivo: ayudarlo a avanzar en las 10 semanas. Conocé bien el contenido de cada semana. Si pregunta sobre contenido, explicalo con las herramientas del programa. Si está atascado en una semana específica, ayudalo a desbloquear.",
    };
  }
  if (segment.isPaid) {
    return {
      name: "FIA Copilot Pro",
      objective:
        "El usuario tiene plan Pro activo. Tu objetivo: que aproveche los Workers y avance en las cápsulas. Podés guiarlo a la cápsula siguiente, sugerirle el Worker más útil para su situación, o ayudarlo a entender qué construyó en su Bóveda.",
    };
  }
  const trialLine = segment.trialOfferExpiresAt
    ? ` Si tiene sentido en la conversación, mencioná una vez que tiene una oferta de prueba disponible: ${config.engine.appBaseUrl}/upgrade`
    : "";
  return {
    name: "Lead / Sin plan activo",
    objective:
      `El usuario no tiene un plan activo. Tu objetivo: mostrarle el valor de FIA Copilot de forma natural, basándote en su negocio y sus áreas de dolor. No presionés. Si el tema fluye, podés mencionar que las primeras 3 cápsulas son gratis.${trialLine}`,
  };
}

export async function generateInboundReply(
  userId: string,
  incomingText: string,
  segment: UserSegment,
): Promise<string | null> {
  try {
    const sofiaPrompt = await getSofiaSystemPrompt();

    const [history, state] = await Promise.all([
      getConversationHistory(userId, 10),
      getConversationState(userId),
    ]);

    const isColdStart = history.length === 0;

    let userContext: string;
    if (isColdStart) {
      const [profile, vaultOutputs, capsuleProgress, capsules, scores, assessment, knowledge] =
        await Promise.all([
          getProfileWithWhatsapp(userId),
          getVaultOutputsForUser(userId),
          getCapsuleProgressForUser(userId),
          getCapsulesCached(),
          getLeadScoreForUser(userId),
          getAssessmentForUser(userId),
          getKnowledge(),
        ]);

      const completedCount = capsuleProgress.filter((p) => p.status === "completed").length;
      const completedCapsules = capsuleProgress
        .filter((p) => p.status === "completed")
        .map((p) => `Cápsula ${p.capsule_number}${p.capsule_title ? `: ${p.capsule_title}` : ""}`)
        .join(", ");

      const inProgressCapsule = capsuleProgress.find((p) => p.status === "in_progress");
      const inProgressTitle = inProgressCapsule
        ? capsules.find((c) => c.id === inProgressCapsule.capsule_id)?.title ?? null
        : null;

      const vaultContext = buildVaultContext(vaultOutputs);
      const painAreas = assessment?.pain_areas ?? [];
      const companySize = resolveCompanySize(assessment);

      const { name: segmentName, objective: segmentObjective } = resolveSegmentInfo(segment);

      const pathTotalsInbound = await getPathTotals();
      const userPathsInbound = resolveUserPaths(capsuleProgress, pathTotalsInbound);
      const activePathInbound = userPathsInbound.find((p) => p.activePath) ?? userPathsInbound[0];
      const pathInfoLine = activePathInbound
        ? ` (${activePathInbound.completed}/${activePathInbound.total} en ${activePathInbound.name})`
        : "";
      const enrolledLine = segment.enrolledPrograms.length > 0
        ? `\n- Programas matriculados: ${segment.enrolledPrograms.map((p) => p.name).join(", ")}`
        : "";

      userContext = `
SEGMENTO: ${segmentName}
OBJETIVO DE ESTA CONVERSACIÓN: ${segmentObjective}

PERFIL DEL USUARIO:
- Nombre: ${profile?.name ?? "desconocido"}
- Empresa: ${profile?.company_name ?? "desconocida"}
- Industria: ${profile?.industry ?? "desconocida"}
- Objetivo: ${profile?.objective ?? "no disponible"}
- Temperatura: ${profile?.temperature ?? "desconocida"}
- Tamaño de empresa: ${companySize ?? "desconocido"}
- Cápsulas completadas: ${completedCount}${pathInfoLine}${enrolledLine}${completedCapsules ? `\n- Completadas: ${completedCapsules}` : ""}${inProgressCapsule ? `\n- En progreso: Cápsula ${inProgressCapsule.capsule_number}${inProgressTitle ? `: ${inProgressTitle}` : ""}` : ""}

SCORES:
- Fit Score: ${scores?.fit_score ?? "N/A"}
- Intent Score: ${scores?.intent_score ?? "N/A"}
- Overall: ${scores?.overall_score ?? "N/A"}

DIAGNÓSTICO:
- Áreas de dolor: ${painAreas.length > 0 ? painAreas.join(", ") : "no disponible"}

BÓVEDA:
${vaultContext}${formatKnowledge(knowledge)}${profile?.preferences?.['sofia_notes'] ? `\n\nCONTEXTO ESPECIAL DE ESTA CONVERSACIÓN:\n${profile.preferences['sofia_notes'] as string}` : ""}`.trim();
    } else {
      const [profile, capsuleProgress, capsules] = await Promise.all([
        getProfileWithWhatsapp(userId),
        getCapsuleProgressForUser(userId),
        getCapsulesCached(),
      ]);
      const completedCount = capsuleProgress.filter((p) => p.status === "completed").length;
      const inProgressCapsule = capsuleProgress.find((p) => p.status === "in_progress");
      const inProgressTitle = inProgressCapsule
        ? capsules.find((c) => c.id === inProgressCapsule.capsule_id)?.title ?? null
        : null;
      const facts = state.userFacts && state.userFacts.length > 0
        ? `\n\nHECHOS DEL USUARIO (mencionados en mensajes anteriores):\n${state.userFacts.map((f) => `- ${f}`).join("\n")}`
        : "";
      const pathTotalsMin = await getPathTotals();
      const userPathsMin = resolveUserPaths(capsuleProgress, pathTotalsMin);
      const activePathMin = userPathsMin.find((p) => p.activePath) ?? userPathsMin[0];
      const capsulaSuffix = activePathMin
        ? ` (${activePathMin.completed}/${activePathMin.total} en ${activePathMin.name})`
        : ` cápsulas`;
      userContext = `PERFIL: ${profile?.name ?? "desconocido"} (${profile?.company_name ?? "—"}) · ${completedCount}${capsulaSuffix}${inProgressCapsule ? ` · cursando ${inProgressCapsule.capsule_number}${inProgressTitle ? `: ${inProgressTitle}` : ""}` : ""}${facts}`;
    }

    // Save user message AFTER deciding cold-start (so history.length is accurate above)
    await appendConversationMessages(userId, [{ role: "user", content: incomingText }]);

    // ── Rate limit: max 5 AI replies per hour per user ──
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const recentReplies = state.aiReplyTimestamps.filter((ts) => new Date(ts).getTime() > oneHourAgo);
    if (recentReplies.length >= 5) {
      logger.warn({ userId, repliesLastHour: recentReplies.length }, "AI reply rate limit hit — using fallback");
      const fallback = nextFallback(userId);
      await appendConversationMessages(userId, [{ role: "assistant", content: fallback }]);
      return fallback;
    }

    // ── Detectar señal de "ocupado" → pausar outbound ──
    const busyHours = detectBusySignal(incomingText);
    if (busyHours > 0) {
      const pausedUntil = new Date(now + busyHours * 60 * 60 * 1000).toISOString();
      await upsertConversationState(userId, { pausedUntil });
      logger.info({ userId, busyHours, pausedUntil }, "Busy signal detected — outbound paused");
    }

    // ── Extraer hechos del mensaje y mergear con existentes ──
    const newFacts = extractFacts(incomingText);
    const updatedFacts = mergeFacts(state.userFacts, newFacts);

    const fullUserMessage = `${userContext}\n\nMensaje del usuario: ${incomingText}\n\nRespondé SOLO con el texto del mensaje, sin prefijos ni comillas.`;

    let reply: string | null = null;

    if (isInAiCooldown(userId)) {
      logger.warn({ userId }, "AI in cooldown for this user — using fallback without calling provider");
    } else {
      // 1. Try Codex with conversation history
      reply = await generateWithCodexConversation(
        sofiaPrompt,
        history as Array<{ role: "user" | "assistant"; content: string }>,
        fullUserMessage,
      );

      // 2. Fallback to Claude with conversation history
      if (!reply && useClaudeAI) {
        try {
          const Anthropic = (await import("@anthropic-ai/sdk")).default;
          const client = new Anthropic({ apiKey: config.anthropic.apiKey });

          const claudeHistory = history.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          }));

          const response = await client.messages.create({
            model: config.anthropic.model,
            max_tokens: 400,
            system: sofiaPrompt,
            messages: [
              ...claudeHistory,
              { role: "user", content: fullUserMessage },
            ],
          });

          const textBlock = response.content.find((b) => b.type === "text");
          if (textBlock && textBlock.type === "text") {
            reply = textBlock.text.trim();
          }
        } catch (error) {
          logger.error({ error, userId }, "Claude inbound fallback failed");
        }
      }

      if (!reply) recordAiFailure(userId);
    }

    if (!reply) {
      const fallback = nextFallback(userId);
      logger.error({ userId, incomingText: incomingText.slice(0, 100) }, "AI unavailable — both Codex and Claude failed (or cooldown)");
      await appendConversationMessages(userId, [{ role: "assistant", content: fallback }]);
      if (updatedFacts.length > 0) {
        await upsertConversationState(userId, { userFacts: updatedFacts });
      }
      try {
        const { evolutionManager } = await import("../senders/whatsappEvolution");
        await evolutionManager.notifyAdmin(`🚨 IA caída — ambos providers fallaron.\nUsuario: ${userId}\nMsg: "${incomingText.slice(0, 150)}"`);
      } catch { /* notify es best-effort */ }
      return fallback;
    }

    const finalReply = stripForeignUrls(smartTrim(reply, MAX_MESSAGE_CHARS));

    await appendConversationMessages(userId, [{ role: "assistant", content: finalReply }]);
    const newTimestamps = [...recentReplies, new Date().toISOString()].slice(-20);
    await upsertConversationState(userId, {
      userFacts: updatedFacts,
      aiReplyTimestamps: newTimestamps,
      lastAiReplyAt: new Date().toISOString(),
    });

    logger.info({ userId, historyLength: history.length, factsCount: updatedFacts.length, isColdStart }, "Inbound AI reply generated");
    return finalReply;
  } catch (error) {
    logger.error({ error, userId }, "generateInboundReply failed");
    return null;
  }
}

// ─── Smart trim: corta en último punto/coma antes del límite ───
function smartTrim(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastSentence = Math.max(
    slice.lastIndexOf("."),
    slice.lastIndexOf("!"),
    slice.lastIndexOf("?"),
    slice.lastIndexOf("\n"),
  );
  if (lastSentence > maxChars * 0.5) {
    return slice.slice(0, lastSentence + 1).trim();
  }
  const lastComma = slice.lastIndexOf(",");
  if (lastComma > maxChars * 0.6) {
    return slice.slice(0, lastComma).trim() + "…";
  }
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > maxChars * 0.7) {
    return slice.slice(0, lastSpace).trim() + "…";
  }
  return slice.trim() + "…";
}

/**
 * Generate the outbound weekly report message for an opportunity.
 * Chain: Codex → Claude → deterministic template fallback.
 */
export async function generateMessage(
  opportunity: EngagementOpportunity,
): Promise<GeneratedMessage | null> {
  // Recent conversation + facts so the report respects what the user last said
  const [recentHistory, state, knowledge] = await Promise.all([
    getConversationHistory(opportunity.userId, 5),
    getConversationState(opportunity.userId),
    getKnowledge(),
  ]);

  const reportContext = buildWeeklyReportContext(opportunity, knowledge);

  const conversationContext = recentHistory.length > 0
    ? `\n\nÚLTIMOS MENSAJES DE LA CONVERSACIÓN POR WHATSAPP (chronological):\n${recentHistory.map((m) => `${m.role === "user" ? "Usuario" : "Sofía"}: ${m.content.slice(0, 200)}`).join("\n")}\n\nIMPORTANTE: si el usuario pidió no recibir mensajes o dijo que está ocupado, sé breve y no insistas.`
    : "";

  const factsContext = state.userFacts.length > 0
    ? `\n\nHECHOS DEL USUARIO (datos que mencionó en conversaciones previas):\n${state.userFacts.map((f) => `- ${f}`).join("\n")}`
    : "";

  const fullContext = `${reportContext}${conversationContext}${factsContext}`;

  const [journeyPrompt, sofiaPrompt] = await Promise.all([
    getJourneyPrompt(opportunity.journeyName),
    getSofiaSystemPrompt(),
  ]);

  // 1. Try Codex OAuth (ChatGPT Plus) first
  const codexText = await generateWithCodex(
    sofiaPrompt,
    `${journeyPrompt}\n\n${fullContext}\n\nGenera SOLO el texto del mensaje de WhatsApp, sin explicaciones ni prefijos.`,
  );

  if (codexText) {
    logger.info({ userId: opportunity.userId, journey: opportunity.journeyName, mode: "codex" }, "Message generated with Codex");
    return finalizeMessage({
      text: codexText,
      journeyName: opportunity.journeyName,
      deepLink: opportunity.deepLink,
      source: "codex",
    });
  }

  // 2. Try Claude API if Codex unavailable
  if (useClaudeAI) {
    const aiMessage = await generateWithClaude(opportunity, fullContext, journeyPrompt);
    if (aiMessage) {
      logger.info({ userId: opportunity.userId, journey: opportunity.journeyName, mode: "claude" }, "Message generated with Claude");
      return finalizeMessage(aiMessage);
    }
  }

  // 3. Deterministic fallback
  logger.info({ userId: opportunity.userId, journey: opportunity.journeyName, mode: "template" }, "Message generated from template");
  return finalizeMessage(await generateWeeklyFallback(opportunity));
}
