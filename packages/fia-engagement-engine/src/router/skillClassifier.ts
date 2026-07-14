/**
 * Pure skill classification helpers (Sofía 2.0, Phase 1). No runtime imports (types only), so they
 * are unit-testable without loading config/DB. The async orchestration (LLM call, registry, flag)
 * lives in ./skillRouter.
 */
import type { Skill } from "../skills/types";

/** lowercase + strip diacritics so 'cápsula' and 'capsula' match the same keyword. */
export function normalizeForRouting(text: string): string {
  return (text ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export interface HeuristicResult {
  skill: string;
  confidence: number;
  hits: number;
}

/**
 * Keyword-count heuristic. Returns the best-matching skill with a confidence in [0,1]. 'general' is
 * the floor (confidence 0.3) when nothing matches. Ties break on skill priority (higher wins).
 */
export function classifyByHeuristic(text: string, skills: Skill[]): HeuristicResult {
  const norm = normalizeForRouting(text);
  let best: { skill: string; hits: number; priority: number } | null = null;

  for (const s of skills) {
    if (s.key === "general" || s.keywords.length === 0) continue;
    let hits = 0;
    for (const kw of s.keywords) {
      if (norm.includes(normalizeForRouting(kw))) hits++;
    }
    if (hits === 0) continue;
    if (!best || hits > best.hits || (hits === best.hits && s.priority > best.priority)) {
      best = { skill: s.key, hits, priority: s.priority };
    }
  }

  if (!best) return { skill: "general", confidence: 0.3, hits: 0 };
  // 1 hit → 0.6, 2 → 0.75, 3+ → 0.85 (capped).
  const confidence = Math.min(0.85, 0.45 + best.hits * 0.15);
  return { skill: best.skill, confidence, hits: best.hits };
}

export interface ParsedRouterResponse {
  skill: string;
  confidence: number;
  programSlug: string | null;
}

/**
 * Parses the LLM router response. Tolerates code fences and surrounding prose by extracting the first
 * JSON object. Returns null when no valid {skill} object is found or the skill isn't in `validSkills`.
 */
export function parseRouterResponse(raw: string, validSkills: string[]): ParsedRouterResponse | null {
  if (!raw) return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const skill = typeof obj["skill"] === "string" ? (obj["skill"] as string).trim() : "";
  if (!skill || !validSkills.includes(skill)) return null;
  const confRaw = obj["confidence"];
  const confidence = typeof confRaw === "number" ? Math.max(0, Math.min(1, confRaw)) : 0.6;
  const ps = obj["program_slug"];
  const programSlug = typeof ps === "string" && ps.trim() && ps !== "null" ? ps.trim() : null;
  return { skill, confidence, programSlug };
}

/** Builds the router classification prompt from the available skills (data-driven from the registry). */
export function buildRouterPrompt(skills: Skill[], recentTurns: string, message: string): string {
  const catalog = skills
    .map((s) => `- ${s.key}: ${s.routerDescription}${s.exampleUtterances.length ? ` Ej: ${s.exampleUtterances.slice(0, 4).map((e) => `"${e}"`).join(", ")}.` : ""}`)
    .join("\n");
  return `Sos un clasificador de intención para la asistente Sofía. Clasificá el ÚLTIMO mensaje del usuario en UNA de estas skills:

${catalog}

${recentTurns ? `Contexto reciente:\n${recentTurns}\n\n` : ""}Último mensaje: "${message}"

Respondé SOLO un JSON: {"skill":"<key>","confidence":<0..1>,"program_slug":<slug o null>}. Sin texto adicional.`;
}
