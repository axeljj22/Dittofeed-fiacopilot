-- Full roster per Sofía group: every participant, with role classification.
-- role: 'superadmin' (is_admin) | 'coach' (is_coach) | 'student' (registered, not staff) |
--       'bot' (Sofía) | 'unknown' (number not in profiles).
-- Refreshed from the Evolution group participants endpoint.

CREATE TABLE IF NOT EXISTS sofia_group_members (
  group_jid     TEXT NOT NULL,
  phone         TEXT NOT NULL,
  user_id       UUID,
  name          TEXT,
  role          TEXT NOT NULL DEFAULT 'unknown',
  is_registered BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_jid, phone)
);

ALTER TABLE sofia_group_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sofia_group_members_svc_all ON sofia_group_members;
CREATE POLICY sofia_group_members_svc_all ON sofia_group_members
  FOR ALL TO service_role USING (true) WITH CHECK (true);
