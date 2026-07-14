-- Phase 2 (Sofía 2.0): add the 'accountability' skill (progress/seguimiento) to the registry.
-- Idempotent — new key, so it inserts on first run and no-ops afterwards. Prompt addendum default
-- ships in engine_config via CONFIG_DEFAULTS ('skill_prompt.accountability').

INSERT INTO sofia_skills (key, name, router_description, example_utterances, prompt_config_key, context_loaders, requires_program, priority, metadata)
VALUES
  ('accountability',
   'Seguimiento',
   'La persona pregunta por SU avance/progreso o pide seguimiento: cómo viene, cuánto lleva, si está atrasada, qué le falta, en qué semana/cápsula está. Foco en motivación y próxima acción, no en explicar el contenido.',
   '["cómo vengo","cuánto me falta","estoy muy atrasado?","en qué cápsula voy","cuántas cápsulas llevo"]'::jsonb,
   'skill_prompt.accountability', '["profile","progress"]'::jsonb, false, 105,
   '{"keywords": ["cómo vengo","como vengo","cómo voy","como voy","mi progreso","cuánto me falta","cuanto me falta","cuánto llevo","cuanto llevo","en qué voy","en que voy","avance","atrasado","atrasada","me atrasé","me atrase","al día","al dia","cuántas cápsulas","cuantas capsulas","qué me falta","que me falta"]}'::jsonb)
ON CONFLICT (key) DO NOTHING;
