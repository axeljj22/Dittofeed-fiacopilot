// Sofía relee auth.json antes de renovar el token de Codex.
//
// Por qué existe: `auth.json` lo comparten Sofía, Victoria, el runtime de agentes y el Content
// Worker, y renovar puede ROTAR el refresh_token. Sofía guardaba el archivo en memoria al arrancar
// y no lo volvía a leer: si otro renovaba primero, ella intentaba renovar con el refresh_token
// viejo, fallaba y se quedaba sin modelo. Detectado el 15-sep, con la credencial a cinco días de
// vencer y Axel a punto de viajar.
//
// No toca la red: `fetch` es un espía. Corre contra el dist compilado, como el resto de los tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-relee-"));
const archivo = path.join(dir, "auth.json");
process.env.CODEX_AUTH_FILE = archivo;
delete process.env.OPENAI_API_KEY;      // sin respaldos: si Codex falla, se tiene que ver
delete process.env.OPENROUTER_API_KEY;
// `config` exige estas tres al importarse. Valores de mentira: el test no toca Supabase ni el engine.
process.env.SUPABASE_URL ??= "http://supabase.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test";
process.env.ENGINE_BASE_URL ??= "http://engine.invalid";

const jwt = (expSegundos) =>
  "x." + Buffer.from(JSON.stringify({ exp: expSegundos })).toString("base64url") + ".y";
const ahora = Math.floor(Date.now() / 1000);
const escribir = (access, refresh) => fs.writeFileSync(archivo, JSON.stringify({
  auth_mode: "chatgpt", OPENAI_API_KEY: null,
  tokens: { access_token: access, refresh_token: refresh, account_id: "acc" },
}));

let pedidosDeRenovacion = 0;
let tokenUsado = null;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes("oauth/token")) {
    pedidosDeRenovacion++;
    // El refresh_token viejo ya fue rotado por otro consumidor: la renovación falla.
    return { ok: false, status: 401, text: async () => "invalid_grant", json: async () => ({}) };
  }
  tokenUsado = (opts.headers || {}).Authorization;
  const sse = 'data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: [DONE]\n';
  return { ok: true, status: 200, text: async () => sse };
};

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log("  ✓ " + name); }

console.log("Codex — Sofía relee el archivo antes de renovar");

// 1. Arranca con un token vigente y lo cachea.
escribir(jwt(ahora + 3600), "refresh-viejo");
const mod = (await import("../dist/generators/codexGenerator.js")).default
  ?? (await import("../dist/generators/codexGenerator.js"));
const { generateWithCodex, invalidateCodexAuthCache } = mod;
invalidateCodexAuthCache();

await check("con token vigente, contesta sin renovar", async () => {
  const r = await generateWithCodex("sys", "hola");
  assert.equal(r, "ok");
  assert.equal(pedidosDeRenovacion, 0);
});

// 2. El token que Sofía tiene en memoria vence…
escribir(jwt(ahora - 10), "refresh-viejo");
invalidateCodexAuthCache();
await generateWithCodex("sys", "carga el vencido en memoria").catch(() => null);
const renovacionesAntes = pedidosDeRenovacion;

// 3. …y OTRO consumidor renueva primero y deja en disco un token nuevo, con otro refresh_token.
const nuevo = jwt(ahora + 7200);
escribir(nuevo, "refresh-rotado");
// Se vuelve a vencer SÓLO la copia en memoria: se simula que Sofía cargó el vencido antes.
// (El paso 2 ya dejó en memoria el vencido; no se invalida el cache acá a propósito.)

await check("si otro renovó, usa el token del disco y NO intenta renovar con el refresh viejo", async () => {
  const r = await generateWithCodex("sys", "hola de nuevo");
  assert.equal(r, "ok", "Sofía se quedó sin modelo: renovó con el refresh_token rotado");
  assert.equal(pedidosDeRenovacion, renovacionesAntes, "intentó renovar en vez de releer el disco");
  assert.equal(tokenUsado, `Bearer ${nuevo}`);
});

console.log(`\n${passed} checks passed`);
