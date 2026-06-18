-- Per-user conversation state for Sofía (inbound memory & pacing).
-- Stores loop-detection counters, last AI reply time, and a JSONB `metadata` bag
-- holding userFacts / pausedUntil / aiReplyTimestamps. Read/written by
-- getConversationState() and upsertConversationState() in src/db/supabase.ts.
--
-- This table was never created by a committed migration (schema drift): it exists
-- in prod but WITHOUT the `metadata` column, so metadata-bearing upserts failed.
-- This migration is idempotent: it creates the table on fresh envs and adds the
-- missing column on existing ones.

CREATE TABLE IF NOT EXISTS wa_conversation_state (
  user_id                    UUID PRIMARY KEY,
  consecutive_low_engagement INTEGER     NOT NULL DEFAULT 0,
  last_ai_reply_at           TIMESTAMPTZ,
  metadata                   JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- userFacts, pausedUntil, aiReplyTimestamps
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill the missing column on environments where the table predates this migration.
ALTER TABLE wa_conversation_state ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE wa_conversation_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow service role full access" ON wa_conversation_state;
CREATE POLICY "Allow service role full access" ON wa_conversation_state
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
