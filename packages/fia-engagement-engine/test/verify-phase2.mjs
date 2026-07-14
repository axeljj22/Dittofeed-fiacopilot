// Phase 2 smoke test — pure active-track resolver. Runs against compiled dist (any repo path).
import assert from "node:assert/strict";
import mod from "../dist/router/activeTrack.js";

const { resolveActiveTrack, ACTIVE_TRACK_TTL_MS } = mod;
const NOW = 1_700_000_000_000;
const enrolled = ["fia-agentica", "fia-ventas"];

let passed = 0;
function check(name, fn) { fn(); passed++; console.log("  ✓ " + name); }

console.log("Phase 2 — active track resolution");

check("inferred valid + different from persisted → switch + changed", () => {
  const r = resolveActiveTrack({ persistedSlug: "fia-ventas", persistedSetAtMs: NOW - 1000, enrolledSlugs: enrolled, inferredSlug: "fia-agentica", nowMs: NOW });
  assert.equal(r.activeSlug, "fia-agentica");
  assert.equal(r.changed, true);
});
check("inferred valid + equal to persisted → keep, not changed", () => {
  const r = resolveActiveTrack({ persistedSlug: "fia-agentica", persistedSetAtMs: NOW - 1000, enrolledSlugs: enrolled, inferredSlug: "fia-agentica", nowMs: NOW });
  assert.equal(r.activeSlug, "fia-agentica");
  assert.equal(r.changed, false);
});
check("inferred not enrolled → ignore, fall back to valid persisted", () => {
  const r = resolveActiveTrack({ persistedSlug: "fia-ventas", persistedSetAtMs: NOW - 1000, enrolledSlugs: enrolled, inferredSlug: "fia-empresas", nowMs: NOW });
  assert.equal(r.activeSlug, "fia-ventas");
  assert.equal(r.changed, false);
});
check("no signal + persisted within TTL → keep persisted", () => {
  const r = resolveActiveTrack({ persistedSlug: "fia-ventas", persistedSetAtMs: NOW - 1000, enrolledSlugs: enrolled, inferredSlug: null, nowMs: NOW });
  assert.equal(r.activeSlug, "fia-ventas");
});
check("persisted expired (past TTL) → null (resolver falls back to priority)", () => {
  const r = resolveActiveTrack({ persistedSlug: "fia-ventas", persistedSetAtMs: NOW - ACTIVE_TRACK_TTL_MS - 1, enrolledSlugs: enrolled, inferredSlug: null, nowMs: NOW });
  assert.equal(r.activeSlug, null);
});
check("persisted no longer enrolled → null", () => {
  const r = resolveActiveTrack({ persistedSlug: "fia-claude", persistedSetAtMs: NOW - 1000, enrolledSlugs: enrolled, inferredSlug: null, nowMs: NOW });
  assert.equal(r.activeSlug, null);
});
check("nothing set → null, not changed", () => {
  const r = resolveActiveTrack({ persistedSlug: null, persistedSetAtMs: null, enrolledSlugs: enrolled, inferredSlug: null, nowMs: NOW });
  assert.equal(r.activeSlug, null);
  assert.equal(r.changed, false);
});

console.log(`\n✅ Phase 2: ${passed} checks passed`);
