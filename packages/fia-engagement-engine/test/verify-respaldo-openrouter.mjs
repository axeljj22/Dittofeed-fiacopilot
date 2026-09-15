// Si Codex falla, Sofía responde por OpenRouter — y NUNCA por la API de OpenAI.
//
// Axel, 15-sep: «Sofía no debería tener API de OpenAI, su fallback debería ser OpenRouter».
// Se prueba con la clave de OpenAI PUESTA a propósito: si el código todavía la usara para el chat,
// este test la vería llamada. No toca la red: `fetch` es un espía.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "respaldo-"));
process.env.CODEX_AUTH_FILE = path.join(dir, "no-existe.json");   // sin Codex
process.env.OPENAI_API_KEY = "sk-no-deberia-usarse";
process.env.OPENROUTER_API_KEY = "or-test";
process.env.OPENROUTER_MODELS = "modelo/uno:free, modelo/dos:free";
process.env.SUPABASE_URL ??= "http://supabase.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test";
process.env.ENGINE_BASE_URL ??= "http://engine.invalid";

const llamadas = [];
globalThis.fetch = async (url, opts = {}) => {
  llamadas.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers || {} });
  if (String(url).includes("openrouter.ai")) {
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "respuesta de respaldo" } }] }), text: async () => "" };
  }
  return { ok: false, status: 500, text: async () => "no", json: async () => ({}) };
};

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log("  ✓ " + name); }

const mod = await import("../dist/generators/codexGenerator.js");
const { generateWithCodex, invalidateCodexAuthCache } = mod.default ?? mod;
invalidateCodexAuthCache();

console.log("Respaldo — sin Codex, Sofía contesta por OpenRouter");

await check("sin Codex contesta por OpenRouter", async () => {
  const r = await generateWithCodex("sys", "hola");
  assert.equal(r, "respuesta de respaldo");
});

await check("nunca llama a la API de OpenAI para chatear", async () => {
  assert.ok(!llamadas.some((l) => l.url.includes("api.openai.com")), "llamó a api.openai.com");
});

await check("usa la clave y la lista de modelos de OpenRouter, en orden", async () => {
  const or = llamadas.find((l) => l.url.includes("openrouter.ai"));
  assert.ok(or, "no llamó a OpenRouter");
  assert.equal(or.headers.Authorization, "Bearer or-test");
  assert.deepEqual(or.body.models, ["modelo/uno:free", "modelo/dos:free"]);
});

console.log(`\n${passed} checks passed`);
