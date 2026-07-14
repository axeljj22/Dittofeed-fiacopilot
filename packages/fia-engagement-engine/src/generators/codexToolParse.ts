/**
 * Pure helpers for Codex (OpenAI Responses API) tool use (Sofía 2.0, Phase 3). No runtime imports, so
 * they are unit-testable against synthetic SSE fixtures — important because the ChatGPT Plus Codex
 * endpoint is unofficial and can only be integration-tested against live traffic.
 *
 * The Responses API streams function calls as output items. We collect the finalized calls from
 * `response.output_item.done` (item.type === "function_call") AND from the terminal `response.completed`
 * event's `response.output[]`, deduped by call_id — whichever the endpoint emits, we catch it.
 */

export interface CodexToolCall {
  callId: string;
  name: string;
  /** Raw JSON string of arguments (parse at the call site). */
  arguments: string;
}

export interface CodexToolTurn {
  text: string;
  toolCalls: CodexToolCall[];
}

export interface CodexToolDefInput {
  key: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Translates our tool defs to the Responses API `tools` array (flat function tools). */
export function buildCodexToolDefs(tools: CodexToolDefInput[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: "function",
    name: t.key,
    description: t.description,
    parameters: t.parameters,
  }));
}

function pushCall(acc: Map<string, CodexToolCall>, item: unknown): void {
  const it = item as { type?: string; call_id?: string; id?: string; name?: string; arguments?: unknown } | null;
  if (!it || it.type !== "function_call") return;
  const callId = it.call_id ?? it.id ?? "";
  if (!callId || !it.name) return;
  const args = typeof it.arguments === "string" ? it.arguments : JSON.stringify(it.arguments ?? {});
  acc.set(callId, { callId, name: it.name, arguments: args });
}

/** Parses a Codex SSE body into accumulated text + finalized tool calls. Never throws. */
export function parseCodexToolEvents(sseBody: string): CodexToolTurn {
  let text = "";
  const calls = new Map<string, CodexToolCall>();

  for (const line of (sseBody ?? "").split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const raw = line.slice(6).trim();
    if (raw === "[DONE]") break;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = event["type"];
    if (type === "response.output_text.delta" && typeof event["delta"] === "string") {
      text += event["delta"] as string;
    } else if (type === "response.output_item.done") {
      pushCall(calls, event["item"]);
    } else if (type === "response.completed") {
      const resp = event["response"] as { output?: unknown[] } | undefined;
      if (Array.isArray(resp?.output)) {
        for (const item of resp!.output!) {
          const it = item as { type?: string; content?: Array<{ type?: string; text?: string }> };
          if (it?.type === "function_call") {
            pushCall(calls, item);
          } else if (it?.type === "message" && Array.isArray(it.content) && !text) {
            // Fallback: recover text from the terminal message if no deltas were seen.
            text = it.content.filter((c) => c?.type === "output_text" && c.text).map((c) => c.text).join("");
          }
        }
      }
    }
  }

  return { text: text.trim(), toolCalls: Array.from(calls.values()) };
}

export interface CodexToolResult {
  callId: string;
  output: string;
}

/**
 * Builds the `input` array for the follow-up request: the prior input, the model's function_call
 * items (echoed back, required with store:false), then our function_call_output items.
 */
export function buildFollowupInput(
  prevInput: Array<Record<string, unknown>>,
  toolCalls: CodexToolCall[],
  results: CodexToolResult[],
): Array<Record<string, unknown>> {
  return [
    ...prevInput,
    ...toolCalls.map((tc) => ({ type: "function_call", call_id: tc.callId, name: tc.name, arguments: tc.arguments })),
    ...results.map((r) => ({ type: "function_call_output", call_id: r.callId, output: r.output })),
  ];
}
