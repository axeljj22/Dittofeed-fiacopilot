// Phase 1 smoke test — pure skill classifier. Runs against compiled dist (any repo path).
// Run: yarn workspace fia-engagement-engine test:p1  (or via the aggregated `test` script)
import assert from "node:assert/strict";
import cls from "../dist/router/skillClassifier.js";

const { classifyByHeuristic, parseRouterResponse, normalizeForRouting } = cls;

const SKILLS = [
  { key: "general", name: "General", routerDescription: "", exampleUtterances: [], contextLoaders: [], tools: [], requiresProgram: false, priority: 50, keywords: [] },
  { key: "content_qa", name: "Contenido", routerDescription: "", exampleUtterances: [], contextLoaders: [], tools: [], requiresProgram: true, priority: 100, keywords: ["clase", "cápsula", "capsula", "semana", "ejercicio", "no entendí"] },
  { key: "admin_support", name: "Admin", routerDescription: "", exampleUtterances: [], contextLoaders: [], tools: [], requiresProgram: false, priority: 110, keywords: ["link", "grabación", "grabacion", "pago", "skool", "no puedo entrar"] },
];

let passed = 0;
function check(name, fn) { fn(); passed++; console.log("  ✓ " + name); }

console.log("Phase 1 — heuristic classifier");
check("content question → content_qa", () => {
  const r = classifyByHeuristic("qué vimos en la clase 3", SKILLS);
  assert.equal(r.skill, "content_qa");
  assert.ok(r.confidence >= 0.6);
});
check("admin question → admin_support", () => {
  const r = classifyByHeuristic("dónde veo las grabaciones y el link de Skool", SKILLS);
  assert.equal(r.skill, "admin_support");
  assert.ok(r.hits >= 2);
});
check("accent-insensitive keyword match (cápsula/capsula)", () => {
  assert.equal(normalizeForRouting("CÁPSULA"), "capsula");
  assert.equal(classifyByHeuristic("en qué capsula está eso", SKILLS).skill, "content_qa");
});
check("tie breaks to higher-priority skill (link+clase → admin over content)", () => {
  // both 'link' (admin) and 'clase' (content) hit once → admin_support wins (priority 110 > 100)
  const r = classifyByHeuristic("cuál es el link de la clase", SKILLS);
  assert.equal(r.skill, "admin_support");
});
check("no keywords → general with low confidence", () => {
  const r = classifyByHeuristic("hola, cómo andás", SKILLS);
  assert.equal(r.skill, "general");
  assert.ok(r.confidence < 0.5);
});

console.log("Phase 1 — LLM response parsing");
const valid = ["general", "content_qa", "admin_support"];
check("parses a clean JSON object", () => {
  const r = parseRouterResponse('{"skill":"content_qa","confidence":0.9,"program_slug":"fia-agentica"}', valid);
  assert.equal(r.skill, "content_qa");
  assert.equal(r.confidence, 0.9);
  assert.equal(r.programSlug, "fia-agentica");
});
check("extracts JSON from surrounding prose / fences", () => {
  const r = parseRouterResponse('```json\n{"skill":"admin_support","confidence":0.7}\n```', valid);
  assert.equal(r.skill, "admin_support");
  assert.equal(r.programSlug, null);
});
check("rejects unknown skill → null", () => {
  assert.equal(parseRouterResponse('{"skill":"nope","confidence":1}', valid), null);
});
check("rejects non-JSON → null", () => {
  assert.equal(parseRouterResponse("no tengo idea", valid), null);
});
check("program_slug 'null' string → null", () => {
  const r = parseRouterResponse('{"skill":"general","program_slug":"null"}', valid);
  assert.equal(r.programSlug, null);
});

console.log(`\n✅ Phase 1: ${passed} checks passed`);
