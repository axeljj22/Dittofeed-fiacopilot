-- Group support for Sofía.
-- Maps each WhatsApp group (group_jid) to a stable conversation thread and, optionally,
-- to the student the follow-up group is about (so replies use that student's context).

CREATE TABLE IF NOT EXISTS sofia_groups (
  group_jid       TEXT PRIMARY KEY,                      -- e.g. 120363....@g.us
  conversation_id UUID NOT NULL DEFAULT gen_random_uuid(),
  student_user_id UUID,                                  -- the student this follow-up group is about (nullable)
  label           TEXT,                                  -- optional human label
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sofia_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow service role full access" ON sofia_groups
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Group messages can come from senders that aren't registered profiles → allow null user_id
-- on the unified conversation log so we can still record (observe) those messages.
ALTER TABLE sofia_conversations ALTER COLUMN user_id DROP NOT NULL;
