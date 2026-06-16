-- engine_scheduled_messages: programmed broadcasts configurable from /admin/schedule
-- Each record defines a recurring or one-time message send for a user segment.

CREATE TABLE IF NOT EXISTS engine_scheduled_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,                        -- "Recordatorio semana 2 FIA Ventas"
  journey_name TEXT NOT NULL,                -- which journey context to use for generation
  segment TEXT NOT NULL DEFAULT 'todos',     -- 'todos' | 'fia-ventas' | 'fia-copilot-pro' | 'leads'
  schedule_cron TEXT NOT NULL,               -- cron expression: "0 9 * * 1" = Mon 9 AM
  message_key TEXT,                          -- optional: engine_config key for a fixed template
  active BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Keep updated_at fresh automatically
CREATE OR REPLACE FUNCTION update_engine_scheduled_messages_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_engine_scheduled_messages_updated_at
  BEFORE UPDATE ON engine_scheduled_messages
  FOR EACH ROW EXECUTE PROCEDURE update_engine_scheduled_messages_updated_at();

-- RLS (backend service role reads/writes; no public access)
ALTER TABLE engine_scheduled_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service role full access" ON engine_scheduled_messages
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Index for active schedule lookups
CREATE INDEX IF NOT EXISTS idx_esm_active ON engine_scheduled_messages(active) WHERE active = true;
