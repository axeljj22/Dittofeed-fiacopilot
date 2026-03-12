-- ═══════════════════════════════════════════════════════════
-- FIA Engagement Engine — Supabase Migration
-- Run this in your Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════

-- 1. Tabla engagement_log (única tabla nueva)
CREATE TABLE IF NOT EXISTS engagement_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  journey_name text NOT NULL,
  mensaje_enviado text NOT NULL,
  whatsapp_number text NOT NULL,
  deep_link text NOT NULL,
  status text NOT NULL CHECK (status IN ('sent', 'failed', 'opted_out')),
  responded boolean DEFAULT false,
  response_text text,
  clicked boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- Índices para queries frecuentes
CREATE INDEX idx_engagement_log_user_id ON engagement_log(user_id);
CREATE INDEX idx_engagement_log_created_at ON engagement_log(created_at DESC);
CREATE INDEX idx_engagement_log_journey ON engagement_log(journey_name);
CREATE INDEX idx_engagement_log_status ON engagement_log(status);

-- RLS: solo admin puede leer/escribir
ALTER TABLE engagement_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access on engagement_log"
  ON engagement_log
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 2. Campos nuevos en profiles
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS whatsapp text,
  ADD COLUMN IF NOT EXISTS wp_opted_out boolean DEFAULT false;

-- 3. Rol dedicado para el engine (lectura en todo, escritura solo en engagement_log)
-- NOTA: Ejecutar solo si quieres un rol separado en vez de service_role
-- CREATE ROLE fia_engine_reader LOGIN PASSWORD 'tu_password_segura';
-- GRANT USAGE ON SCHEMA public TO fia_engine_reader;
-- GRANT SELECT ON ALL TABLES IN SCHEMA public TO fia_engine_reader;
-- GRANT INSERT, UPDATE ON engagement_log TO fia_engine_reader;
-- GRANT INSERT ON events TO fia_engine_reader;  -- para registrar reactivaciones
