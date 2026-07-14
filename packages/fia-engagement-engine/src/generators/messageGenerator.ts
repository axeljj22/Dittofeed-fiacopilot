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
  getSkillPromptAddendum,
} from "../config/engineConfigCache";
import { resolveProgramProfile } from "../config/programProfiles";
import { routeSkill } from "../router/skillRouter";
import { resolveActiveTrack } from "../router/activeTrack";
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
  searchKnowledge,
  searchCapsuleContent,
  formatCapsuleContent,
  logKnowledgeQuery,
  isStaffUser,
} from "../db/supabase";

/** Appended to Sofía's system prompt when the asker is internal staff (admin/coach/owner). */
const STAFF_MODE_ADDENDUM = `

[MODO EQUIPO] Estás hablando con un miembro del equipo/dueño de FIA, NO con un alumno. Intentá responder con lo que tengas: el contenido del programa de arriba + tu conocimiento general. NUNCA derives "al equipo" ni digas "no tengo esa info, te paso con el equipo" — ellos SON el equipo. Si no estás 100% segura, dá igual tu mejor respuesta y aclará en una línea el nivel de certeza o qué te falta, pero intentá siempre.`;
import type { UserSegment, KnowledgeEntry } from "../db/supabase";
import type { EngagementOpportunity, VaultOutput, AssessmentSubmission } from "../db/types";
import type { WeeklyReportContext } from "../detectors/weeklyReport";
import { generateWithCodex, generateWithCodexConversation } from "./codexGenerator";

export interface GeneratedMessage {
  text: string;
  journeyName: string;
  deepLink: string;
  /** Which path produced the text — surfaced to the conversation log for observability. */
  source?: "codex" | "claude" | "gemini" | "template";
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

/**
 * Formats knowledge entries for grounding (anti-hallucination). Entries arrive
 * relevance-ordered (from searchKnowledge), so the top hits get fuller content and the
 * rest a short summary, under a total char budget.
 */
function formatKnowledge(entries: KnowledgeEntry[]): string {
  if (entries.length === 0) return "";
  let budget = 3600;
  const lines: string[] = [];
  entries.slice(0, 6).forEach((e, i) => {
    const full = (e.content ?? "").trim();
    const sum = (e.summary ?? "").trim();
    const maxLen = i < 3 ? 900 : 280;
    let body = (i < 3 ? full || sum : sum || full).slice(0, maxLen);
    if (body.length > budget) body = body.slice(0, Math.max(0, budget));
    if (!body) return;
    budget -= body.length;
    const voice = e.voice_notes ? ` (voz: ${e.voice_notes.slice(0, 160)})` : "";
    lines.push(`• [${e.category}] ${e.title}: ${body}${voice}`);
  });
  if (lines.length === 0) return "";
  return `\n\nCONOCIMIENTO DE FIA RELEVANTE (basate SOLO en esto para responder; si no alcanza, decí que lo verificás y no inventes):\n${lines.join("\n")}`;
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

async function generateWithGemini(
  systemPrompt: string,
  userMessage: string,
): Promise<string | null> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.model}:generateContent?key=${config.gemini.apiKey}`;
    const body = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: config.gemini.maxTokens },
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "Gemini API error");
      return null;
    }
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null;
    return text || null;
  } catch (error) {
    logger.error({ error }, "generateWithGemini threw");
    return null;
  }
}

/** Deterministic fallback when all AI providers are unavailable. */
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
// The sender swaps the deep link for a tracked link ({base}/r/{uuid} ≈ 70 chars). Budget for the
// worst case so the FINAL message (after the swap) stays within the limit.
const TRACKED_LINK_RESERVE = 70;

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

  // Effective limit leaves room for the longer tracked link the sender substitutes later.
  const linkExtra = deepLink ? Math.max(0, TRACKED_LINK_RESERVE - deepLink.length) : 0;
  const effMax = MAX_MESSAGE_CHARS - linkExtra;

  if (safe.length <= effMax) return { text: safe, truncated: false };

  // Truncation: keep the deepLink at the end, trim body to fit
  const linkIndex = safe.lastIndexOf(deepLink);
  const bodyBudget = effMax - deepLink.length - 1; // 1 for space
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

const useGeminiAI =
  config.gemini.apiKey !== "placeholder" &&
  config.gemini.apiKey !== "";

/** Formats the program profile's admin links for injection when the admin_support skill is active. */
function formatAdminLinks(links: Record<string, string>): string {
  const entries = Object.entries(links ?? {}).filter(([, v]) => v);
  if (entries.length === 0) return "";
  return `\n\nLINKS ADMINISTRATIVOS DISPONIBLES (usá el que corresponda):\n${entries.map(([k, v]) => `- ${k}: ${v}`).join("\n")}`;
}

export async function generateInboundReply(
  userId: string,
  incomingText: string,
  segment: UserSegment,
  isAudio = false,
): Promise<string | null> {
  try {
    // Staff (admin/coach/owner) get "team mode": attempt with what's available, never defer to "el equipo".
    const staffMode = await isStaffUser(userId);
    const sofiaPromptBase = (await getSofiaSystemPrompt()) + (staffMode ? STAFF_MODE_ADDENDUM : "");

    const [history, state] = await Promise.all([
      getConversationHistory(userId, 10),
      getConversationState(userId),
    ]);
    const isColdStart = history.length === 0;

    // Active track (Phase 2): for multi-program students, one active track scopes content isolation.
    const enrolledSlugs = segment.enrolledPrograms.map((p) => p.slug).filter(Boolean);
    const persistedSetAtMs = state.activeProgramSetAt ? new Date(state.activeProgramSetAt).getTime() : null;
    const persistedActive = resolveActiveTrack({
      persistedSlug: state.activeProgramSlug, persistedSetAtMs, enrolledSlugs, inferredSlug: null, nowMs: Date.now(),
    }).activeSlug;

    // Resolve the program profile (data-driven; falls back to v1 texts if the table is absent).
    let programProfile = await resolveProgramProfile(segment, persistedActive);
    // Scope knowledge retrieval to the profile's knowledge_scope (isolation) or all enrolled programs.
    let scopedSlugs = programProfile.knowledgeScope.length > 0 ? programProfile.knowledgeScope : enrolledSlugs;

    // Skill routing (Phase 1) — flag-gated. OFF → 'general' (empty addendum) → byte-for-byte v1.
    const recentTurns = history.slice(-3).map((m) => `${m.role === "user" ? "usuario" : "sofía"}: ${m.content}`).join("\n");
    const routed = await routeSkill(incomingText, {
      enabled: config.engine.skillsRouterEnabled,
      recentTurns,
      enabledSkills: programProfile.enabledSkills,
    });

    // If the router inferred a different valid program, switch the active track this turn + persist it.
    const track = resolveActiveTrack({
      persistedSlug: state.activeProgramSlug, persistedSetAtMs, enrolledSlugs, inferredSlug: routed.programSlug, nowMs: Date.now(),
    });
    if (track.changed && track.activeSlug) {
      programProfile = await resolveProgramProfile(segment, track.activeSlug);
      scopedSlugs = programProfile.knowledgeScope.length > 0 ? programProfile.knowledgeScope : enrolledSlugs;
      void upsertConversationState(userId, { activeProgramSlug: track.activeSlug, activeProgramSetAt: new Date().toISOString() });
    }

    const skillAddendum = routed.skill !== "general" ? await getSkillPromptAddendum(routed.skill) : "";
    const sofiaPrompt = sofiaPromptBase + skillAddendum;
    const adminLinksCtx = routed.skill === "admin_support" ? formatAdminLinks(programProfile.adminLinks) : "";

    let userContext: string;
    if (isColdStart) {
      const [profile, vaultOutputs, capsuleProgress, capsules, scores, assessment, knowledge, capsuleHits] =
        await Promise.all([
          getProfileWithWhatsapp(userId),
          getVaultOutputsForUser(userId),
          getCapsuleProgressForUser(userId),
          getCapsulesCached(),
          getLeadScoreForUser(userId),
          getAssessmentForUser(userId),
          searchKnowledge(incomingText, scopedSlugs),
          searchCapsuleContent(incomingText, scopedSlugs),
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

      const { name: segmentName, objective: segmentObjective } = { name: programProfile.name, objective: programProfile.objective };

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
${vaultContext}${formatKnowledge(knowledge)}${formatCapsuleContent(capsuleHits)}${profile?.preferences?.['sofia_notes'] ? `\n\nCONTEXTO ESPECIAL DE ESTA CONVERSACIÓN:\n${profile.preferences['sofia_notes'] as string}` : ""}`.trim();
      void logKnowledgeQuery({ userId, query: incomingText, knowledge, capsuleHits, source: "dm", asker: profile?.name ?? null });
    } else {
      const [profile, capsuleProgress, capsules, knowledge, capsuleHits] = await Promise.all([
        getProfileWithWhatsapp(userId),
        getCapsuleProgressForUser(userId),
        getCapsulesCached(),
        searchKnowledge(incomingText, scopedSlugs),
        searchCapsuleContent(incomingText, scopedSlugs),
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
      // Knowledge base + capsule chunks injected on EVERY turn — most content questions
      // come mid-conversation; without this Sofía answers "no tengo esa info".
      userContext = `PERFIL: ${profile?.name ?? "desconocido"} (${profile?.company_name ?? "—"}) · ${completedCount}${capsulaSuffix}${inProgressCapsule ? ` · cursando ${inProgressCapsule.capsule_number}${inProgressTitle ? `: ${inProgressTitle}` : ""}` : ""}${facts}${formatKnowledge(knowledge)}${formatCapsuleContent(capsuleHits)}`;
      void logKnowledgeQuery({ userId, query: incomingText, knowledge, capsuleHits, source: "dm", asker: profile?.name ?? null });
    }

    // Save user message AFTER deciding cold-start (so history.length is accurate above)
    await appendConversationMessages(userId, [{ role: "user", content: incomingText }], isAudio ? { is_audio: true } : undefined);

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

    const fullUserMessage = `${userContext}${adminLinksCtx}\n\nMensaje del usuario: ${incomingText}\n\nRespondé SOLO con el texto del mensaje, sin prefijos ni comillas.`;

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

      // 3. Fallback to Gemini
      if (!reply && useGeminiAI) {
        reply = await generateWithGemini(sofiaPrompt, fullUserMessage);
        if (reply) logger.info({ userId }, "Inbound reply generated with Gemini");
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

    await appendConversationMessages(userId, [{ role: "assistant", content: finalReply }], {
      skill: routed.skill,
      confidence: routed.confidence,
      router_source: routed.source,
      program_profile: programProfile.profileKey,
      ...(routed.programSlug ? { program_slug: routed.programSlug } : {}),
    });
    const newTimestamps = [...recentReplies, new Date().toISOString()].slice(-20);
    await upsertConversationState(userId, {
      userFacts: updatedFacts,
      aiReplyTimestamps: newTimestamps,
      lastAiReplyAt: new Date().toISOString(),
    });

    logger.info({ userId, historyLength: history.length, factsCount: updatedFacts.length, isColdStart, skill: routed.skill, routerSource: routed.source, confidence: routed.confidence }, "Inbound AI reply generated");
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

  // 3. Try Gemini if Claude also unavailable
  if (useGeminiAI) {
    const sofiaPromptGemini = await getSofiaSystemPrompt();
    const geminiText = await generateWithGemini(
      sofiaPromptGemini,
      `${journeyPrompt}\n\n${fullContext}\n\nGenera SOLO el texto del mensaje de WhatsApp, sin explicaciones ni prefijos.`,
    );
    if (geminiText) {
      logger.info({ userId: opportunity.userId, journey: opportunity.journeyName, mode: "gemini" }, "Message generated with Gemini");
      return finalizeMessage({ text: geminiText, journeyName: opportunity.journeyName, deepLink: opportunity.deepLink, source: "gemini" });
    }
  }

  // 4. Deterministic fallback
  logger.info({ userId: opportunity.userId, journey: opportunity.journeyName, mode: "template" }, "Message generated from template");
  return finalizeMessage(await generateWeeklyFallback(opportunity));
}

/**
 * Generates Sofía's reply when she's mentioned in a WhatsApp group.
 * Like generateInboundReply but: group-aware prompt + multi-speaker group history.
 * Returns null if both providers fail (caller then stays silent — better than garbage in a group).
 */
export async function generateGroupReply(opts: {
  contextUserId: string | null;
  segment: UserSegment | null;
  senderName: string;
  senderRole?: string | null;
  incomingText: string;
  groupHistory: Array<{ direction: string; body: string; name: string }>;
  conversationId?: string;
}): Promise<string | null> {
  const { contextUserId, segment, senderName, senderRole, incomingText, groupHistory, conversationId } = opts;
  try {
    const programSlugs = segment?.enrolledPrograms.map((p) => p.slug).filter(Boolean) ?? null;
    const programProfile = segment ? await resolveProgramProfile(segment, null) : null;
    const scopedSlugs = programProfile && programProfile.knowledgeScope.length > 0 ? programProfile.knowledgeScope : programSlugs;
    const staffMode = senderRole === "superadmin" || senderRole === "coach" || senderRole === "staff";
    const [sofiaPromptBase, knowledge, capsuleHits] = await Promise.all([
      getSofiaSystemPrompt(),
      searchKnowledge(incomingText, scopedSlugs),
      searchCapsuleContent(incomingText, scopedSlugs),
    ]);
    const sofiaPrompt = sofiaPromptBase + (staffMode ? STAFF_MODE_ADDENDUM : "");
    void logKnowledgeQuery({ userId: contextUserId, conversationId, query: incomingText, knowledge, capsuleHits, source: "group", asker: senderName });

    let profileCtx = "";
    if (contextUserId) {
      const profile = await getProfileWithWhatsapp(contextUserId);
      const enrolled = segment && segment.enrolledPrograms.length > 0
        ? ` Programas: ${segment.enrolledPrograms.map((p) => p.name).join(", ")}.`
        : "";
      profileCtx = `\nALUMNO DEL GRUPO: ${profile?.name ?? "desconocido"}${profile?.company_name ? ` (${profile.company_name})` : ""}.${enrolled}${programProfile ? ` ${programProfile.objective}` : ""}`;
    }

    const historyText = groupHistory.length > 0
      ? `\n\nMENSAJES RECIENTES DEL GRUPO:\n${groupHistory.map((h) => `${h.name}: ${h.body.slice(0, 200)}`).join("\n")}`
      : "";

    const groupInstruction =
      "Estás en un grupo de WhatsApp de seguimiento (el alumno, Axel y el coach). Te mencionaron. " +
      "Respondé SOLO lo que te preguntaron, breve y al punto, sin saludar de más ni presentarte. " +
      "Si el mensaje no es para vos, respondé muy corto o no aportes de más.";

    const userMessage = `${groupInstruction}${profileCtx}${formatKnowledge(knowledge)}${formatCapsuleContent(capsuleHits)}${historyText}\n\nMensaje de ${senderName} (te mencionó): ${incomingText}\n\nRespondé SOLO con el texto del mensaje, sin prefijos ni comillas.`;

    // 1. Codex → 2. Claude → 3. Gemini
    let reply = await generateWithCodex(sofiaPrompt, userMessage);
    if (!reply && useClaudeAI) {
      try {
        const Anthropic = (await import("@anthropic-ai/sdk")).default;
        const client = new Anthropic({ apiKey: config.anthropic.apiKey });
        const response = await client.messages.create({
          model: config.anthropic.model,
          max_tokens: 400,
          system: sofiaPrompt,
          messages: [{ role: "user", content: userMessage }],
        });
        const tb = response.content.find((b) => b.type === "text");
        if (tb && tb.type === "text") reply = tb.text.trim();
      } catch (error) {
        logger.error({ error }, "Claude group reply failed");
      }
    }
    if (!reply && useGeminiAI) {
      reply = await generateWithGemini(sofiaPrompt, userMessage);
      if (reply) logger.info({}, "Group reply generated with Gemini");
    }
    if (!reply) return null;
    return stripForeignUrls(smartTrim(reply, MAX_MESSAGE_CHARS));
  } catch (error) {
    logger.error({ error }, "generateGroupReply failed");
    return null;
  }
}
