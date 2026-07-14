// Tools-gate smoke test — pure. Runs against compiled dist.
import assert from "node:assert/strict";
import mod from "../dist/tools/toolsGate.js";

const { toolsAllowedForPhone } = mod;
let passed = 0;
function check(name, fn) { fn(); passed++; console.log("  ✓ " + name); }

console.log("Tools gate");
check("disabled → never, even if whitelisted", () => {
  assert.equal(toolsAllowedForPhone(false, ["5491125120212"], "5491125120212"), false);
});
check("enabled + empty whitelist → everyone", () => {
  assert.equal(toolsAllowedForPhone(true, [], "5491111111111"), true);
});
check("enabled + whitelist match → true", () => {
  assert.equal(toolsAllowedForPhone(true, ["5491125120212"], "5491125120212"), true);
});
check("enabled + whitelist, non-match → false", () => {
  assert.equal(toolsAllowedForPhone(true, ["5491125120212"], "5491199999999"), false);
});
check("formatted phone (+, spaces) still matches by digits", () => {
  assert.equal(toolsAllowedForPhone(true, ["5491125120212"], "+54 9 11 2512-0212"), true);
});
check("empty phone + non-empty whitelist → false", () => {
  assert.equal(toolsAllowedForPhone(true, ["549"], ""), false);
});

console.log(`\n✅ Tools gate: ${passed} checks passed`);
