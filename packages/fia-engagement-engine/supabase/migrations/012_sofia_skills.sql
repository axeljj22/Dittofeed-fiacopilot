-- Phase 1 (Sofía 2.0): skill registry. A skill is the unit the router dispatches to. Metadata + prompt
-- live here (editable); execution (context loaders, tools) lives in src/skills/*. Zero-downtime: the
-- engine ships an in-code registry fallback (SKILL_DEFAULTS) so it works before this table exists, and
-- the router only runs when SKILLS_ROUTER_ENABLED=true — otherwise behavior is byte-for-byte v1.
--
-- metadata.keywords feeds the heuristic classifier; prompt_config_key points at an engine_config key
-- ('skill_prompt.<key>') so the per-skill prompt addendum is editable from /admin/config. Idempotent.

CREATE TABLE IF NOT EXISTS sofia_skills (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key                text UNIQUE NOT NULL,               -- 'general' | 'content_qa' | 'admin_support'
  name               text NOT NULL,
  router_description text NOT NULL,                      -- what the router reads to decide
  example_utterances jsonb NOT NULL DEFAULT '[]'::jsonb, -- few-shots for the classifier
  prompt_config_key  text,                               -- 'skill_prompt.<key>' in engine_config
  context_loaders    jsonb NOT NULL DEFAULT '[]'::jsonb, -- forward-looking (Phase 2+)
  tools              jsonb NOT NULL DEFAULT '[]'::jsonb, -- forward-looking (Phase 3+)
  requires_program   boolean NOT NULL DEFAULT false,
  priority           int NOT NULL DEFAULT 100,           -- tie-break (higher wins)
  is_active          boolean NOT NULL DEFAULT true,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb, -- {keywords: [...]}
  updated_at         timestamptz NOT NULL DEFAULT now()
);

INSERT INTO sofia_skills (key, name, router_description, example_utterances, prompt_config_key, context_loaders, requires_program, priority, metadata)
VALUES
  ('general',
   'General',
   'Conversación general, small talk, dudas amplias, o cualquier cosa que no encaje claramente en otra skill. Es el fallback por defecto.',
   '["hola","gracias","cómo estás","qué es FIA","contame más"]'::jsonb,
   'skill_prompt.general', '["profile"]'::jsonb, false, 50,
   '{"keywords": []}'::jsonb),

  ('content_qa',
   'Dudas de contenido',
   'Preguntas sobre el CONTENIDO de la formación que cursa el alumno: qué se vio en una clase/cápsula/semana, cómo hacer un ejercicio o entregable, dudas conceptuales del material, en qué semana está tal tema.',
   '["qué vimos en la clase 3","cómo hago el ejercicio de la semana 2","no entendí lo de los agentes","en qué cápsula está el tema de n8n","cuál es el entregable de esta semana"]'::jsonb,
   'skill_prompt.content_qa', '["profile","progress","knowledge_rag","capsule_rag"]'::jsonb, true, 100,
   '{"keywords": ["clase","cápsula","capsula","semana","módulo","modulo","ejercicio","entregable","tarea","lección","leccion","tema","contenido","material","cómo hago","como hago","no entendí","no entendi","explicá","explica","qué es","que es","concepto","práctica","practica","workshop","grabación de la clase"]}'::jsonb),

  ('admin_support',
   'Soporte administrativo',
   'Cuestiones OPERATIVAS/administrativas: accesos, links, dónde entrar, grabaciones, calendario, horario de la próxima clase, pagos, facturas, Skool, comunidad, problemas de login. NO es contenido de la formación.',
   '["cuál es el link de la clase","dónde veo las grabaciones","no puedo entrar a la plataforma","cuándo es la próxima clase","cómo pago","link de Skool","no me llegó el acceso","dónde está el calendario"]'::jsonb,
   'skill_prompt.admin_support', '["admin_links"]'::jsonb, false, 110,
   '{"keywords": ["link","enlace","acceso","acceder","entrar","ingresar","grabación","grabacion","grabaciones","calendario","agenda","horario","cuándo es","cuando es","próxima clase","proxima clase","pago","pagar","factura","cobro","skool","comunidad","plataforma","login","contraseña","password","no puedo entrar","no me llega","no me llegó","no me llego","soporte"]}'::jsonb)
ON CONFLICT (key) DO NOTHING;
