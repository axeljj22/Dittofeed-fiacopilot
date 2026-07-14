/** Pure reminder request builder (Sofía 2.0, Phase 4). No runtime imports → unit-testable. */

export const MIN_DELAY_HOURS = 1;
export const MAX_DELAY_HOURS = 720; // 30 days
export const MAX_MESSAGE_LEN = 500;

export interface ReminderRequest {
  message: string;
  dueAtIso: string;
}

/**
 * Validates + normalizes a schedule_reminder call. delay_hours is clamped to [1, 720]; message is
 * required and trimmed. Returns { error } for invalid input (so the tool replies instead of writing).
 */
export function buildReminderRequest(
  args: { message?: unknown; delay_hours?: unknown },
  nowMs: number,
): ReminderRequest | { error: string } {
  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (!message) return { error: "Falta el texto del recordatorio." };

  const hoursRaw = typeof args.delay_hours === "number" ? args.delay_hours : Number(args.delay_hours);
  if (!Number.isFinite(hoursRaw)) return { error: "El plazo (delay_hours) es inválido." };
  const hours = Math.max(MIN_DELAY_HOURS, Math.min(MAX_DELAY_HOURS, hoursRaw));

  return { message: message.slice(0, MAX_MESSAGE_LEN), dueAtIso: new Date(nowMs + hours * 3_600_000).toISOString() };
}
