-- Conversation history for Sofía inbound AI replies
-- Run manually in Supabase SQL editor

CREATE TABLE IF NOT EXISTS wa_conversation_history (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role        text        NOT NULL CHECK (role IN ('user', 'assistant')),
  content     text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wa_conversation_history_user_created
  ON wa_conversation_history (user_id, created_at DESC);

-- Service role only (same policy as engagement_log)
ALTER TABLE wa_conversation_history ENABLE ROW LEVEL SECURITY;
