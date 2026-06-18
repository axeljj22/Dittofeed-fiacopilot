-- Unified conversation log for Sofía.
-- Single source of truth for every message (inbound + outbound) between a user and Sofía.
-- Replaces the split across wa_conversation_history / wa_incoming_messages.
-- engagement_log stays for delivery status & journey metrics; this table is the conversation.

CREATE TABLE IF NOT EXISTS sofia_conversations (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         UUID NOT NULL,
  conversation_id UUID NOT NULL,                 -- groups messages into a thread
  direction       TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  kind            TEXT NOT NULL,                 -- 'weekly_report' | 'inbound_reply' | 'command' | 'activation'
  body            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'sent',  -- 'sent' | 'failed' | 'received'
  truncated       BOOLEAN NOT NULL DEFAULT FALSE,
  generation_source TEXT,                        -- 'codex' | 'claude' | 'template' | NULL (inbound)
  error_reason    TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- journey, deep_link, classification labels, etc.
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot paths: per-user history (chronological) and per-thread reconstruction.
CREATE INDEX IF NOT EXISTS idx_sofia_conv_user_created ON sofia_conversations(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sofia_conv_conversation ON sofia_conversations(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sofia_conv_kind_created ON sofia_conversations(kind, created_at DESC);

ALTER TABLE sofia_conversations ENABLE ROW LEVEL SECURITY;

-- Only the engine (service_role) writes/reads here — not end users.
CREATE POLICY "Allow service role full access" ON sofia_conversations
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
