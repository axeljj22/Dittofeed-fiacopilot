/** Tool registry (Sofía 2.0, Phase 3+). Maps tool keys → code-bound ToolDef. */
import type { ToolDef } from "./types";
import {
  searchCapsulesTool,
  searchKnowledgeTool,
  getStudentProgressTool,
  getAdminLinksTool,
} from "./definitions/readTools";

const ALL_TOOLS: ToolDef[] = [
  searchCapsulesTool,
  searchKnowledgeTool,
  getStudentProgressTool,
  getAdminLinksTool,
];

const BY_KEY = new Map<string, ToolDef>(ALL_TOOLS.map((t) => [t.key, t]));

export function getTool(key: string): ToolDef | undefined {
  return BY_KEY.get(key);
}

/** Resolves an ordered list of tool keys to their defs, dropping unknown keys. */
export function getToolsForKeys(keys: string[]): ToolDef[] {
  return keys.map((k) => BY_KEY.get(k)).filter((t): t is ToolDef => Boolean(t));
}
