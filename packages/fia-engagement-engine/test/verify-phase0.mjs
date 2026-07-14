// Phase 0 smoke test — pure program-profile resolver. Zero deps: runs against the compiled dist
// (works regardless of the repo path). Run: yarn workspace fia-engagement-engine test
import assert from "node:assert/strict";
import mod from "../dist/config/programProfileResolver.js";

const { pickProgramProfile } = mod;
const APP = "https://fiacopilot.com";

function seg(over = {}) {
  return {
    isPaid: false, isFiaVentas: false, isFiaEmpresas: false, orgRole: null,
    planId: null, trialOfferExpiresAt: null, enrolledPrograms: [], ...over,
  };
}
function prog(slug, tier = null) {
  return { slug, name: slug, pathId: "p-" + slug, isPaid: true, enrolledAt: null, tier, cohortStartDate: null };
}
function dbProfile(over) {
  return {
    id: "id-" + over.profile_key, program_slug: null, tier_match: null, display_name: over.profile_key,
    sofia_objective: "obj", tone_overrides: null, catalog_blurb: null, knowledge_scope: [], enabled_skills: [],
    enabled_journeys: ["reporte_semanal"], admin_links: {}, support_level: "standard", routing_priority: 100,
    is_active: true, updated_at: "2026-01-01", ...over,
  };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log("  ✓ " + name);
}

console.log("Phase 0 — empty table reproduces v1 (resolveSegmentInfo) behavior");
check("lead / sin plan", () => {
  const r = pickProgramProfile([], seg(), null, APP);
  assert.equal(r.name, "Lead / Sin plan activo");
  assert.ok(!r.objective.includes("/upgrade"));
});
check("lead with trial appends upgrade nudge", () => {
  const r = pickProgramProfile([], seg({ trialOfferExpiresAt: "2026-12-31" }), null, APP);
  assert.ok(r.objective.includes(`${APP}/upgrade`));
});
check("FIA Ventas enrolled → FIA Ventas - Alumno (ventas beats isPaid, as v1)", () => {
  const r = pickProgramProfile([], seg({ isPaid: true, isFiaVentas: true, enrolledPrograms: [prog("fia-ventas", "standard")] }), null, APP);
  assert.equal(r.name, "FIA Ventas - Alumno");
  assert.deepEqual(r.knowledgeScope, ["fia-ventas"]);
});
check("FIA Agéntica enrolled (no profile) → FIA Copilot Pro, like v1", () => {
  const r = pickProgramProfile([], seg({ isPaid: true, enrolledPrograms: [prog("fia-agentica", "standard")] }), null, APP);
  assert.equal(r.name, "FIA Copilot Pro");
});
check("FIA Empresas sponsor / implementador", () => {
  assert.equal(pickProgramProfile([], seg({ isFiaEmpresas: true, orgRole: "sponsor" }), null, APP).name, "FIA Empresas - Sponsor");
  assert.equal(pickProgramProfile([], seg({ isFiaEmpresas: true, orgRole: "implementador" }), null, APP).name, "FIA Empresas - Implementador");
});
check("Pro (subscription, no program) → FIA Copilot Pro", () => {
  assert.equal(pickProgramProfile([], seg({ isPaid: true }), null, APP).name, "FIA Copilot Pro");
});

console.log("Phase 0 — seeded profiles: isolation by program + tier");
const profiles = [
  dbProfile({ profile_key: "fia-agentica", program_slug: "fia-agentica", tier_match: null, display_name: "FIA Agéntica - Cohorte en vivo", sofia_objective: "clases en vivo", knowledge_scope: ["fia-agentica"], routing_priority: 200 }),
  dbProfile({ profile_key: "fia-agentica:selfpaced", program_slug: "fia-agentica", tier_match: "selfpaced", display_name: "FIA Agéntica - Self-paced", sofia_objective: "a tu ritmo self-paced", knowledge_scope: ["fia-agentica"], routing_priority: 205 }),
  dbProfile({ profile_key: "fia-agentica:vip", program_slug: "fia-agentica", tier_match: "vip", display_name: "FIA Agéntica - VIP", sofia_objective: "seguimiento premium", knowledge_scope: ["fia-agentica"], support_level: "vip", routing_priority: 210 }),
  dbProfile({ profile_key: "fia-ventas", program_slug: "fia-ventas", tier_match: null, display_name: "FIA Ventas - Alumno", sofia_objective: "10 semanas", knowledge_scope: ["fia-ventas"], routing_priority: 180 }),
];
check("self-paced tier resolves the self-paced profile", () => {
  const r = pickProgramProfile(profiles, seg({ isPaid: true, enrolledPrograms: [prog("fia-agentica", "selfpaced")] }), null, APP);
  assert.equal(r.name, "FIA Agéntica - Self-paced");
  assert.ok(r.objective.includes("self-paced"));
});
check("standard tier resolves the tier-agnostic cohorte catch-all", () => {
  const r = pickProgramProfile(profiles, seg({ isPaid: true, enrolledPrograms: [prog("fia-agentica", "standard")] }), null, APP);
  assert.equal(r.name, "FIA Agéntica - Cohorte en vivo");
});
check("vip tier resolves VIP profile with support_level vip", () => {
  const r = pickProgramProfile(profiles, seg({ isPaid: true, enrolledPrograms: [prog("fia-agentica", "vip")] }), null, APP);
  assert.equal(r.name, "FIA Agéntica - VIP");
  assert.equal(r.supportLevel, "vip");
});
check("multi-program: activeSlug wins", () => {
  const s = seg({ isPaid: true, isFiaVentas: true, enrolledPrograms: [prog("fia-agentica", "standard"), prog("fia-ventas", "standard")] });
  assert.equal(pickProgramProfile(profiles, s, "fia-ventas", APP).name, "FIA Ventas - Alumno");
  assert.equal(pickProgramProfile(profiles, s, "fia-agentica", APP).name, "FIA Agéntica - Cohorte en vivo");
});
check("multi-program: no activeSlug → highest routing_priority wins (agéntica 200 > ventas 180)", () => {
  const s = seg({ isPaid: true, isFiaVentas: true, enrolledPrograms: [prog("fia-agentica", "standard"), prog("fia-ventas", "standard")] });
  assert.equal(pickProgramProfile(profiles, s, null, APP).name, "FIA Agéntica - Cohorte en vivo");
});

console.log(`\n✅ Phase 0: ${passed} checks passed`);
