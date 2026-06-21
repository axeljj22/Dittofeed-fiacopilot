-- Phase 2: control-group action/approval loop. A staff command in the control group becomes a
-- PENDING action (recipients + draft message); Sofía posts the plan; nothing is sent until a
-- superadmin replies "aprobado". One row per proposed action.
CREATE TABLE IF NOT EXISTS sofia_pending_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_jid text NOT NULL,
  action_type text NOT NULL DEFAULT 'broadcast',
  audience text,                              -- inactivos | sin_arrancar | activos | todos | alumno
  program_slug text,
  target_user_ids jsonb DEFAULT '[]'::jsonb,  -- resolved recipients
  draft_message text,
  status text NOT NULL DEFAULT 'pending',      -- pending | executed | cancelled | expired
  created_by text,                            -- sender name/role who requested it
  result jsonb,                               -- {sent, failed} after execution
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sofia_pending_actions_group
  ON sofia_pending_actions(group_jid, status, created_at DESC);
