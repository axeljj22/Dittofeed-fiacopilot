/**
 * Skill router (Sofía 2.0, Phase 1). Decides which skill handles an inbound message. Flag-gated: when
 * disabled it returns 'general' with source 'flag_off' so behavior is byte-for-byte v1.
 *
 * Strategy: heuristic keyword match first (free, deterministic); if confident, use it. Otherwise an
 * LLM refinement (Codex — same "free" ChatGPT Plus path used for generation) resolves ambiguity. Any
 * failure degrades to the heuristic, then to 'general'. Never throws.
 */
import { logger } from "../logger";
import { generateWithCodex } from "../generators/codexGenerator";
import { getSkillRegistry } from "../skills/registry";
import { classifyByHeuristic, parseRouterResponse, buildRouterPrompt, type ParsedRouterResponse } from "./skillClassifier";
import type { RoutedSkill, Skill } from "../skills/types";

export interface RouteSkillOptions {
  enabled: boolean;
  /** Last few turns, pre-formatted (e.g. "usuario: ...\nsofía: ..."). */
  recentTurns: string;
  /** Skills enabled for this user's program profile. Empty/undefined = all skills. */
  enabledSkills?: string[];
}

const HEURISTIC_CONFIDENT = 0.7;
const HEURISTIC_FLOOR = 0.45;
const LLM_MIN_CONFIDENCE = 0.6;

export async function routeSkill(message: string, opts: RouteSkillOptions): Promise<RoutedSkill> {
  if (!opts.enabled) return { skill: "general", programSlug: null, confidence: 1, source: "flag_off" };
  try {
    const registry = await getSkillRegistry();
    const available = opts.enabledSkills && opts.enabledSkills.length
      ? registry.filter((s) => opts.enabledSkills!.includes(s.key) || s.key === "general")
      : registry;
    const validKeys = available.map((s) => s.key);

    const h = classifyByHeuristic(message, available);
    if (h.confidence >= HEURISTIC_CONFIDENT) {
      return { skill: h.skill, programSlug: null, confidence: h.confidence, source: "heuristic" };
    }

    const llm = await classifyByLLM(available, opts.recentTurns, message, validKeys);
    if (llm && llm.confidence >= LLM_MIN_CONFIDENCE) {
      return { skill: llm.skill, programSlug: llm.programSlug, confidence: llm.confidence, source: "llm" };
    }

    if (h.confidence >= HEURISTIC_FLOOR) {
      return { skill: h.skill, programSlug: null, confidence: h.confidence, source: "heuristic" };
    }
    return { skill: "general", programSlug: null, confidence: 0.3, source: "fallback" };
  } catch (error) {
    logger.warn({ error: (error as Error).message }, "skill router failed — defaulting to general");
    return { skill: "general", programSlug: null, confidence: 0, source: "fallback" };
  }
}

async function classifyByLLM(
  skills: Skill[],
  recentTurns: string,
  message: string,
  validKeys: string[],
): Promise<ParsedRouterResponse | null> {
  try {
    const prompt = buildRouterPrompt(skills, recentTurns, message);
    const raw = await generateWithCodex(
      "Sos un clasificador de intención. Respondé únicamente con el JSON pedido, sin texto adicional.",
      prompt,
    );
    if (!raw) return null;
    return parseRouterResponse(raw, validKeys);
  } catch (error) {
    logger.debug({ error: (error as Error).message }, "LLM router classification failed");
    return null;
  }
}
