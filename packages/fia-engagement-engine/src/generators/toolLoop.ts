/**
 * Provider-agnostic tool loop (Sofía 2.0, Phase 3). Primary provider is Codex (the free ChatGPT Plus
 * path). Runs up to MAX_ITERS tool rounds; executes each tool via the registry and feeds results back.
 * Returns the final text, or null when Codex is unavailable / errors — the caller then DEGRADES to the
 * normal generation chain (which injects context), so Sofía never goes silent because of tools.
 *
 * Read tools run freely. The Phase 4 write tools bound here are intentionally low-risk (self-reminder,
 * team notification) and self-guard; the tool descriptions instruct the model to confirm with the user
 * first. High-risk mutations (e.g. creating CRM/auth records) are deliberately NOT registered as tools.
 */
import { logger } from "../logger";
import { generateWithCodexTools } from "./codexGenerator";
import { buildCodexToolDefs, buildFollowupInput, type CodexToolResult } from "./codexToolParse";
import { getToolsForKeys } from "../tools/registry";
import type { ToolContext } from "../tools/types";

const MAX_ITERS = 3;
const MAX_TOOL_OUTPUT_CHARS = 4000;

export async function runToolLoop(opts: {
  systemPrompt: string;
  message: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  toolKeys: string[];
  ctx: ToolContext;
}): Promise<string | null> {
  const tools = getToolsForKeys(opts.toolKeys);
  if (tools.length === 0) return null;

  const codexTools = buildCodexToolDefs(
    tools.map((t) => ({ key: t.key, description: t.description, parameters: t.parameters })),
  );

  let input: Array<Record<string, unknown>> = [
    ...opts.history.map((m) => ({
      role: m.role,
      content: [{ type: m.role === "user" ? "input_text" : "output_text", text: m.content }],
    })),
    { role: "user", content: [{ type: "input_text", text: opts.message }] },
  ];

  for (let i = 0; i < MAX_ITERS; i++) {
    const turn = await generateWithCodexTools(opts.systemPrompt, input, codexTools);
    if (!turn) return null; // Codex unavailable → caller degrades to normal chain
    if (turn.toolCalls.length === 0) return turn.text || null;

    const results: CodexToolResult[] = [];
    for (const call of turn.toolCalls) {
      const tool = tools.find((t) => t.key === call.name);
      let output: string;
      if (!tool) {
        output = `La herramienta ${call.name} no está disponible.`;
      } else {
        try {
          const args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
          output = await tool.handler(opts.ctx, args);
        } catch (error) {
          logger.warn({ error: (error as Error).message, tool: call.name }, "tool handler failed");
          output = `Error ejecutando ${call.name}.`;
        }
      }
      results.push({ callId: call.callId, output: output.slice(0, MAX_TOOL_OUTPUT_CHARS) });
    }
    input = buildFollowupInput(input, turn.toolCalls, results);
  }

  // Iterations exhausted — one final call to force a text answer from the gathered tool outputs.
  const final = await generateWithCodexTools(opts.systemPrompt, input, codexTools);
  return final?.text || null;
}
