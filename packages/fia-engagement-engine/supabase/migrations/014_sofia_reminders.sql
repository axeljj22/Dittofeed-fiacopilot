-- Phase 4 (Sofía 2.0): one-shot per-user reminders. schedule_reminder (a write tool) inserts a row;
-- a scheduler tick sends the due ones via the normal guarded outbound path (opt-out + pilot honored),
-- then marks them sent. Distinct from engine_scheduled_messages (that's cron-by-segment). Idempotent.

CREATE TABLE IF NOT EXISTS sofia_reminders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  message     text NOT NULL,
  due_at      timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'pending',   -- pending | sent | cancelled | failed
  created_by  text,                              -- 'sofia_tool' | staff name
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_sofia_reminders_due
  ON sofia_reminders(due_at) WHERE status = 'pending';
