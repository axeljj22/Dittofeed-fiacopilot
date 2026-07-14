-- Phase 5 (Sofía 2.0): 'sales' skill + enable it on student profiles (cross-program derivation:
-- an enrolled student asking about a program they DON'T have → sales → escalate/derive) + document
-- the v2 capabilities in sofia_features. Idempotent throughout.

-- 1. Sales skill row.
INSERT INTO sofia_skills (key, name, router_description, example_utterances, prompt_config_key, context_loaders, tools, requires_program, priority, metadata)
VALUES
  ('sales',
   'Ventas',
   'La persona (lead o no) muestra interés en un programa, pregunta cómo sumarse/anotarse, o pide info comercial de una formación que NO cursa. Foco en mostrar valor y escalar a un asesor humano.',
   '["cuánto sale FIA Ventas","cómo me anoto","quiero sumarme a la próxima cohorte","me interesa el programa","qué planes tienen"]'::jsonb,
   'skill_prompt.sales', '["profile"]'::jsonb, '["escalate_to_human"]'::jsonb, false, 90,
   '{"keywords": ["precio","cuánto sale","cuanto sale","cuánto cuesta","cuanto cuesta","cuánto vale","cuanto vale","quiero anotarme","cómo me anoto","como me anoto","cómo me sumo","como me sumo","inscribir","inscripción","inscripcion","planes","comprar","contratar","me interesa","quiero sumarme","próxima cohorte"]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 2. Enable 'sales' on enrolled-student profiles so cross-program interest routes to it. Idempotent.
UPDATE sofia_program_profiles
SET enabled_skills = enabled_skills || '["sales"]'::jsonb
WHERE program_slug IN ('fia-agentica', 'fia-ventas', 'fia-empresas')
  AND NOT (enabled_skills @> '["sales"]'::jsonb);

-- 3. Document v2 capabilities in the live feature registry.
INSERT INTO sofia_features (key, category, title, summary, description, technical_notes, status, metadata)
VALUES
  ('program_profiles', 'infrastructure', 'Perfiles de programa data-driven',
   'Sofía adapta objetivo, tono, alcance de contenido y links por formación desde una tabla editable.',
   'sofia_program_profiles resuelve el perfil por program_slug + tier (Agéntica cohorte/self/VIP, Ventas, Empresas, Pro, Lead). Alta de un programa = una fila, sin deploy.',
   'Fase 0. Resolver en config/programProfiles.ts con fallback a los textos v1.', 'live',
   '{}'::jsonb),
  ('skill_router', 'infrastructure', 'Router de skills',
   'Sofía identifica la intención del mensaje y la deriva a la skill correcta.',
   'Router heurístico (keywords) + refinamiento LLM vía Codex; degrada a general. Detrás de SKILLS_ROUTER_ENABLED.',
   'Fase 1. src/router/*. Loguea skill/confidence en sofia_conversations.metadata.', 'beta',
   '{"flag": "SKILLS_ROUTER_ENABLED"}'::jsonb),
  ('skill_content_qa', 'inbound_ai', 'Skill: dudas de contenido',
   'Responde dudas del material acotado al programa del alumno (aislamiento por formación).',
   'RAG scopeado a knowledge_scope del perfil / track activo.', 'Fase 1-2.', 'beta',
   '{"skill_key": "content_qa"}'::jsonb),
  ('skill_accountability', 'inbound_ai', 'Skill: seguimiento',
   'Lee el avance del alumno y sugiere la próxima acción.',
   'Loaders de progreso; tool get_student_progress.', 'Fase 2.', 'beta',
   '{"skill_key": "accountability"}'::jsonb),
  ('skill_admin_support', 'inbound_ai', 'Skill: soporte administrativo',
   'Resuelve accesos, links, grabaciones, calendario y pagos, separado del contenido.',
   'Inyecta admin_links del perfil; tools get_admin_links + escalate_to_human.', 'Fase 1-4.', 'beta',
   '{"skill_key": "admin_support"}'::jsonb),
  ('skill_sales', 'inbound_ai', 'Skill: ventas',
   'Muestra valor a leads/interesados y escala a un asesor humano.',
   'Cross-program: deriva interés por programas no cursados.', 'Fase 5.', 'beta',
   '{"skill_key": "sales"}'::jsonb),
  ('active_track', 'infrastructure', 'Track activo (multi-programa)',
   'Para alumnos en varios programas, mantiene un track activo para aislar el contenido.',
   'wa_conversation_state.metadata.activeProgramSlug, TTL 7 días, inferido por el router.', 'Fase 2.', 'beta',
   '{}'::jsonb),
  ('tool_use', 'infrastructure', 'Tool use (Codex)',
   'Sofía puede consultar la base en tiempo real (cápsulas, conocimiento, progreso, links) con herramientas.',
   'Tool loop sobre Codex (Responses API). Detrás de SOFIA_TOOLS_ENABLED. Degrada a contexto inyectado.',
   'Fase 3. src/tools/*, src/generators/toolLoop.ts.', 'beta',
   '{"flag": "SOFIA_TOOLS_ENABLED"}'::jsonb),
  ('tool_reminders', 'infrastructure', 'Recordatorios',
   'Sofía puede agendar un recordatorio por WhatsApp para el alumno.',
   'schedule_reminder → sofia_reminders; tick cada 5 min respeta opt-out y pilot mode.', 'Fase 4.', 'beta',
   '{}'::jsonb),
  ('tool_escalation', 'infrastructure', 'Escalación a humano',
   'Sofía avisa al equipo para que un humano haga seguimiento (leads, casos complejos).',
   'escalate_to_human → notifyAdmin. Camino seguro para captar leads sin crear registros de auth.', 'Fase 4.', 'beta',
   '{}'::jsonb)
ON CONFLICT (key) DO NOTHING;
