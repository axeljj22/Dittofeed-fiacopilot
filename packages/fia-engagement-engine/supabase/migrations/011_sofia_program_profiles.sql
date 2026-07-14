-- Phase 0 (Sofía 2.0): data-driven program profiles. Replaces the hardcoded resolveSegmentInfo()
-- in messageGenerator.ts with an editable table so adding a program/audience is a row, not a deploy.
-- Zero-downtime: the engine falls back to the same hardcoded texts if this table is absent/empty.
--
-- A profile is resolved by (program_slug + tier) with fallbacks: 'slug:tier' → 'slug' → synthetic
-- ('__empresas_sponsor__' | '__empresas_implementador__' | '__pro__' | '__lead__'). Idempotent.

CREATE TABLE IF NOT EXISTS sofia_program_profiles (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_key       text UNIQUE NOT NULL,               -- 'fia-agentica:selfpaced' | 'fia-ventas' | '__pro__'
  program_slug      text,                               -- null for synthetic profiles
  tier_match        text,                               -- null = any tier; else 'standard'|'vip'|'selfpaced'|...
  display_name      text NOT NULL,
  sofia_objective   text NOT NULL,                      -- injected as "OBJETIVO DE ESTA CONVERSACIÓN"
  tone_overrides    text,                               -- appended to sofia_personality when present
  catalog_blurb     text,                               -- short program description for the dynamic catalog
  knowledge_scope   jsonb NOT NULL DEFAULT '[]'::jsonb, -- slugs for RAG; [] = use the user's enrolledPrograms
  enabled_skills    jsonb NOT NULL DEFAULT '[]'::jsonb, -- forward-looking (Phase 1)
  enabled_journeys  jsonb NOT NULL DEFAULT '["reporte_semanal"]'::jsonb,
  admin_links       jsonb NOT NULL DEFAULT '{}'::jsonb, -- {calendario, grabaciones, skool, pagos, soporte}
  support_level     text NOT NULL DEFAULT 'standard',   -- 'standard' | 'vip' | 'one_on_one'
  routing_priority  int NOT NULL DEFAULT 100,           -- higher wins when the user is in multiple programs
  is_active         boolean NOT NULL DEFAULT true,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sofia_program_profiles_slug
  ON sofia_program_profiles(program_slug, tier_match) WHERE is_active;

-- ── Seed. ON CONFLICT DO NOTHING so re-running never clobbers edits made from the admin panel. ──
-- The empresas/ventas/pro/lead objectives are copied verbatim from resolveSegmentInfo() to keep
-- v1 behavior byte-for-byte once the table is live.

INSERT INTO sofia_program_profiles
  (profile_key, program_slug, tier_match, display_name, sofia_objective, knowledge_scope, enabled_skills, support_level, routing_priority)
VALUES
  -- FIA Agéntica — cohorte en vivo (catch-all: standard/equipo/preview)
  ('fia-agentica', 'fia-agentica', NULL,
   'FIA Agéntica - Cohorte en vivo',
   'El usuario es alumno de FIA Agéntica en la cohorte en vivo (clases sincrónicas sobre agentes y automatización con IA). Tu objetivo: ayudarlo a llegar al día con las clases, resolver dudas del contenido ya visto y recordarle la próxima clase en vivo. Si se atrasó, invitalo con calidez a ver la grabación y retomar.',
   '["fia-agentica"]'::jsonb, '["content_qa","accountability","admin_support"]'::jsonb, 'standard', 200),

  -- FIA Agéntica — self-paced (a su ritmo, sin clases en vivo)
  ('fia-agentica:selfpaced', 'fia-agentica', 'selfpaced',
   'FIA Agéntica - Self-paced',
   'El usuario cursa FIA Agéntica en modalidad self-paced (a su ritmo, sin clases en vivo). Tu objetivo: sostener su avance semana a semana con el contenido on-demand, resolver dudas y celebrar cada cápsula completada. No hay clases sincrónicas: guialo por las grabaciones y entregables, no le hables de clases en vivo.',
   '["fia-agentica"]'::jsonb, '["content_qa","accountability","admin_support"]'::jsonb, 'standard', 205),

  -- FIA Agéntica — VIP (acompañamiento reforzado)
  ('fia-agentica:vip', 'fia-agentica', 'vip',
   'FIA Agéntica - VIP',
   'El usuario es alumno VIP de FIA Agéntica (acompañamiento reforzado). Tu objetivo: darle seguimiento cercano y proactivo, resolver dudas con prioridad y, cuando corresponda, coordinar con el equipo para su acompañamiento 1:1. Tratalo con la cercanía de un seguimiento premium.',
   '["fia-agentica"]'::jsonb, '["content_qa","accountability","admin_support"]'::jsonb, 'vip', 210),

  -- FIA Ventas — alumno (catch-all)
  ('fia-ventas', 'fia-ventas', NULL,
   'FIA Ventas - Alumno',
   'El usuario es alumno de FIA Ventas. Tu objetivo: ayudarlo a avanzar en las 10 semanas. Conocé bien el contenido de cada semana. Si pregunta sobre contenido, explicalo con las herramientas del programa. Si está atascado en una semana específica, ayudalo a desbloquear.',
   '["fia-ventas"]'::jsonb, '["content_qa","accountability","admin_support"]'::jsonb, 'standard', 180),

  -- FIA Ventas — VIP
  ('fia-ventas:vip', 'fia-ventas', 'vip',
   'FIA Ventas - VIP',
   'El usuario es alumno VIP de FIA Ventas (acompañamiento reforzado). Tu objetivo: ayudarlo a avanzar en las 10 semanas con seguimiento cercano y prioritario, resolviendo dudas de contenido y desbloqueando cada semana. Tratalo con la cercanía de un seguimiento premium.',
   '["fia-ventas"]'::jsonb, '["content_qa","accountability","admin_support"]'::jsonb, 'vip', 185),

  -- FIA Empresas — Sponsor (acceso por org_role)
  ('__empresas_sponsor__', 'fia-empresas', NULL,
   'FIA Empresas - Sponsor',
   'El usuario es Sponsor de FIA Empresas (dueño o decisor). Puede preguntarte sobre el progreso de su equipo, los implementadores, o la hoja de ruta. Tu objetivo: mantenerlo informado y motivado. Si pregunta algo técnico de implementación, derivá al equipo.',
   '["fia-empresas"]'::jsonb, '["accountability","admin_support"]'::jsonb, 'standard', 160),

  -- FIA Empresas — Implementador
  ('__empresas_implementador__', 'fia-empresas', NULL,
   'FIA Empresas - Implementador',
   'El usuario está implementando FIA Empresas en su empresa (rol implementador, 4–8h/semana). Tu objetivo: ayudarlo a avanzar en la fase que corresponde, resolver dudas sobre el proceso, guiarlo en documentación de SOPs o creación de asistentes IA. Conocé bien las 3 fases del programa.',
   '["fia-empresas"]'::jsonb, '["content_qa","accountability","admin_support"]'::jsonb, 'standard', 165),

  -- FIA Copilot Pro / Método de 25 pasos (suscriptor sin fila de acceso a un track)
  ('__pro__', NULL, NULL,
   'FIA Copilot Pro',
   'El usuario tiene plan Pro activo. Tu objetivo: que aproveche los Workers y avance en las cápsulas. Podés guiarlo a la cápsula siguiente, sugerirle el Worker más útil para su situación, o ayudarlo a entender qué construyó en su Bóveda.',
   '[]'::jsonb, '["content_qa","accountability","admin_support"]'::jsonb, 'standard', 100),

  -- Lead / sin plan activo
  ('__lead__', NULL, NULL,
   'Lead / Sin plan activo',
   'El usuario no tiene un plan activo. Tu objetivo: mostrarle el valor de FIA Copilot de forma natural, basándote en su negocio y sus áreas de dolor. No presionés. Si el tema fluye, podés mencionar que las primeras 3 cápsulas son gratis.',
   '[]'::jsonb, '["sales","general"]'::jsonb, 'standard', 50)
ON CONFLICT (profile_key) DO NOTHING;
