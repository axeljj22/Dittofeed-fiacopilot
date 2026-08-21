-- Security hardening: 4 Sofía tables shipped without RLS (migrations 010, 011, 012, 014
-- omitted the ALTER ... ENABLE ROW LEVEL SECURITY), leaving them readable AND writable by
-- anyone holding the public anon key. sofia_skills / sofia_program_profiles feed Sofía's
-- router and system prompt, so write access there is a prompt-injection vector.
-- Also fixes 009_sofia_features.sql, whose policy is named "Allow service role full access"
-- but was granted TO authenticated (copy-paste slip) — any logged-in user could write it.
-- Pattern matches 003/005/006: RLS on + service_role-only policy. Idempotent throughout.

-- 1. Enable RLS on the four unprotected tables.
ALTER TABLE sofia_pending_actions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sofia_program_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE sofia_reminders        ENABLE ROW LEVEL SECURITY;
ALTER TABLE sofia_skills           ENABLE ROW LEVEL SECURITY;

-- 2. Service-role-only access (the engine is the sole consumer; it connects with
--    SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS regardless, but the policy keeps
--    the intent explicit and matches the other sofia_* tables).
DROP POLICY IF EXISTS "Allow service role full access" ON sofia_pending_actions;
CREATE POLICY "Allow service role full access" ON sofia_pending_actions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service role full access" ON sofia_program_profiles;
CREATE POLICY "Allow service role full access" ON sofia_program_profiles
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service role full access" ON sofia_reminders;
CREATE POLICY "Allow service role full access" ON sofia_reminders
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service role full access" ON sofia_skills;
CREATE POLICY "Allow service role full access" ON sofia_skills
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3. Fix sofia_features: same policy name, wrong role (authenticated → service_role).
DROP POLICY IF EXISTS "Allow service role full access" ON sofia_features;
CREATE POLICY "Allow service role full access" ON sofia_features
  FOR ALL TO service_role USING (true) WITH CHECK (true);
