-- Conversation state per user for inbound AI rate limiting and loop detection
CREATE TABLE IF NOT EXISTS wa_conversation_state (
  user_id                   uuid        PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  consecutive_low_engagement int         NOT NULL DEFAULT 0,
  last_ai_reply_at          timestamptz,
  updated_at                timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE wa_conversation_state IS
  'Tracks per-user inbound conversation state for Sofía AI rate limiting and loop detection.';
COMMENT ON COLUMN wa_conversation_state.consecutive_low_engagement IS
  'Count of consecutive low-effort user messages (< 5 words, no question mark). Resets on genuine engagement.';
COMMENT ON COLUMN wa_conversation_state.last_ai_reply_at IS
  'Timestamp of last AI inbound reply — used for 24h rate limiting when user is not engaging.';
