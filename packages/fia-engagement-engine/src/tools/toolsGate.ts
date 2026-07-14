/**
 * Tool-use gate (Sofía 2.0). Pure — unit-testable. Lets tool use be rolled out safely:
 *  - tools OFF          → never.
 *  - tools ON, no list  → everyone (global).
 *  - tools ON, w/ list  → only phones matching the whitelist (controlled test, e.g. just Axel).
 *
 * Matching is substring-based (the whitelist holds bare digit sequences), like the pilot whitelist.
 */
export function toolsAllowedForPhone(enabled: boolean, whitelist: string[], phone: string): boolean {
  if (!enabled) return false;
  if (whitelist.length === 0) return true;
  const digits = (phone ?? "").replace(/\D/g, "");
  if (!digits) return false;
  return whitelist.some((w) => w && digits.includes(w));
}
