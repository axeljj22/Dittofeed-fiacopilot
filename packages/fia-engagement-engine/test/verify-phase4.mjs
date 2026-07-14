// Phase 4 smoke test — pure reminder request builder. Runs against compiled dist.
import assert from "node:assert/strict";
import mod from "../dist/tools/reminderTime.js";

const { buildReminderRequest, MIN_DELAY_HOURS, MAX_DELAY_HOURS } = mod;
const NOW = 1_700_000_000_000;

let passed = 0;
function check(name, fn) { fn(); passed++; console.log("  ✓ " + name); }

console.log("Phase 4 — reminder request builder");

check("valid request computes due = now + delay", () => {
  const r = buildReminderRequest({ message: "seguí con la cápsula 3", delay_hours: 2 }, NOW);
  assert.equal(r.message, "seguí con la cápsula 3");
  assert.equal(new Date(r.dueAtIso).getTime(), NOW + 2 * 3_600_000);
});

check("delay clamped to max", () => {
  const r = buildReminderRequest({ message: "x", delay_hours: 10000 }, NOW);
  assert.equal(new Date(r.dueAtIso).getTime(), NOW + MAX_DELAY_HOURS * 3_600_000);
});

check("delay clamped to min", () => {
  const r = buildReminderRequest({ message: "x", delay_hours: 0 }, NOW);
  assert.equal(new Date(r.dueAtIso).getTime(), NOW + MIN_DELAY_HOURS * 3_600_000);
});

check("missing message → error", () => {
  const r = buildReminderRequest({ delay_hours: 2 }, NOW);
  assert.ok("error" in r);
});

check("non-numeric delay → error", () => {
  const r = buildReminderRequest({ message: "x", delay_hours: "pronto" }, NOW);
  assert.ok("error" in r);
});

check("numeric string delay is accepted", () => {
  const r = buildReminderRequest({ message: "x", delay_hours: "3" }, NOW);
  assert.equal(new Date(r.dueAtIso).getTime(), NOW + 3 * 3_600_000);
});

check("message truncated to 500 chars", () => {
  const r = buildReminderRequest({ message: "a".repeat(900), delay_hours: 1 }, NOW);
  assert.equal(r.message.length, 500);
});

console.log(`\n✅ Phase 4: ${passed} checks passed`);
