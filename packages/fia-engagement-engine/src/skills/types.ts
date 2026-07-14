/** Sofía 2.0 skills (Phase 1). A skill is the unit the router dispatches an inbound message to. */

export interface Skill {
  key: string;                    // 'general' | 'content_qa' | 'admin_support' | future
  name: string;
  routerDescription: string;      // what the classifier reads to decide
  exampleUtterances: string[];
  contextLoaders: string[];       // forward-looking (Phase 2+)
  tools: string[];                // forward-looking (Phase 3+)
  requiresProgram: boolean;
  priority: number;               // tie-break (higher wins)
  keywords: string[];             // heuristic classifier
}

export interface RoutedSkill {
  skill: string;
  programSlug: string | null;
  confidence: number;
  /** How the decision was made — for observability. */
  source: "flag_off" | "heuristic" | "llm" | "fallback";
}
