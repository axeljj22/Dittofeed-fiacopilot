-- Create engine_config table for storing configurable prompts, templates, and command replies
-- This allows admins to edit communication templates without redeploying the engine

CREATE TABLE IF NOT EXISTS engine_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by TEXT
);

-- Create index on updated_at for easy sorting in admin panel
CREATE INDEX IF NOT EXISTS idx_engine_config_updated_at ON engine_config(updated_at DESC);

-- Add row-level security policy (optional, but recommended)
-- Allow service role (backend) to read/write; restrict by auth token in app layer
ALTER TABLE engine_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service role full access" ON engine_config
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
