// Phase 3 smoke test — pure Codex tool-call SSE parser + request builders. Runs against compiled dist.
// The live Codex endpoint can't be tested here, so we lock the parser shape against synthetic SSE.
import assert from "node:assert/strict";
import mod from "../dist/generators/codexToolParse.js";

const { parseCodexToolEvents, buildCodexToolDefs, buildFollowupInput } = mod;

const sse = (lines) => lines.map((l) => "data: " + JSON.stringify(l)).join("\n") + "\ndata: [DONE]\n";

let passed = 0;
function check(name, fn) { fn(); passed++; console.log("  ✓ " + name); }

console.log("Phase 3 — Codex tool-call SSE parsing");

check("text deltas accumulate; no tool calls", () => {
  const body = sse([
    { type: "response.output_text.delta", delta: "Hola " },
    { type: "response.output_text.delta", delta: "mundo" },
  ]);
  const r = parseCodexToolEvents(body);
  assert.equal(r.text, "Hola mundo");
  assert.equal(r.toolCalls.length, 0);
});

check("output_item.done function_call is captured", () => {
  const body = sse([
    { type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "search_capsules", arguments: '{"query":"agentes"}' } },
  ]);
  const r = parseCodexToolEvents(body);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].name, "search_capsules");
  assert.equal(r.toolCalls[0].callId, "call_1");
  assert.deepEqual(JSON.parse(r.toolCalls[0].arguments), { query: "agentes" });
});

check("response.completed recovers function_call + terminal text", () => {
  const body = sse([
    { type: "response.completed", response: { output: [
      { type: "function_call", call_id: "call_2", name: "get_admin_links", arguments: "{}" },
      { type: "message", content: [{ type: "output_text", text: "Listo" }] },
    ] } },
  ]);
  const r = parseCodexToolEvents(body);
  assert.equal(r.text, "Listo");
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].name, "get_admin_links");
});

check("same call_id in output_item.done and response.completed → deduped", () => {
  const body = sse([
    { type: "response.output_item.done", item: { type: "function_call", call_id: "dup", name: "search_knowledge", arguments: "{}" } },
    { type: "response.completed", response: { output: [{ type: "function_call", call_id: "dup", name: "search_knowledge", arguments: "{}" }] } },
  ]);
  const r = parseCodexToolEvents(body);
  assert.equal(r.toolCalls.length, 1);
});

check("malformed data lines are skipped, not thrown", () => {
  const body = "data: not-json\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\ndata: [DONE]\n";
  const r = parseCodexToolEvents(body);
  assert.equal(r.text, "ok");
});

console.log("Phase 3 — request builders");
check("buildCodexToolDefs → flat function tools", () => {
  const defs = buildCodexToolDefs([{ key: "search_capsules", description: "d", parameters: { type: "object", properties: {} } }]);
  assert.equal(defs[0].type, "function");
  assert.equal(defs[0].name, "search_capsules");
  assert.equal(defs[0].description, "d");
});

check("buildFollowupInput appends function_call + function_call_output", () => {
  const prev = [{ role: "user", content: [{ type: "input_text", text: "hola" }] }];
  const calls = [{ callId: "c1", name: "get_admin_links", arguments: "{}" }];
  const results = [{ callId: "c1", output: "calendario: http://x" }];
  const out = buildFollowupInput(prev, calls, results);
  assert.equal(out.length, 3);
  assert.equal(out[1].type, "function_call");
  assert.equal(out[1].call_id, "c1");
  assert.equal(out[2].type, "function_call_output");
  assert.equal(out[2].output, "calendario: http://x");
});

console.log(`\n✅ Phase 3: ${passed} checks passed`);
