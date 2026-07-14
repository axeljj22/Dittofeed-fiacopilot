/** Tool-use framework (Sofía 2.0, Phase 3+). A tool is a code-bound capability the model can invoke. */
import type { UserSegment } from "../db/supabase";

export interface ToolContext {
  userId: string;
  segment: UserSegment;
  /** Program slugs the RAG tools must stay scoped to (isolation). null = all/global. */
  scopedSlugs: string[] | null;
  /** Admin links from the active program profile (for get_admin_links). */
  adminLinks: Record<string, string>;
}

export interface ToolDef {
  key: string;
  description: string;
  /** JSON Schema for the arguments (Responses API `parameters`). */
  parameters: Record<string, unknown>;
  mode: "read" | "write";
  /** Gate before a write executes. Read tools are always 'none'. */
  approval: "none" | "user_confirm" | "staff_approve";
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<string>;
}
