# Runbook — Alta de un programa/audiencia nuevo en Sofía (≈15 min, sin deploy)

Sofía 2.0 es data-driven: agregar una formación o audiencia nueva es **insertar/editar filas**, no
tocar código. Este runbook cubre el caso "quiero que Sofía atienda un programa nuevo".

## Requisitos previos
- El programa existe en FIA Copilot (`learning_paths.program_slug`) y los alumnos tienen acceso en
  `user_program_access` (con su `tier`).
- Contenido del programa cargado (cápsulas / `knowledge_base`) taggeado con ese `program_slug`, para que
  el RAG lo encuentre.

## Pasos

### 1. Crear el perfil de programa (define cómo Sofía lo atiende)
Insertá una fila en `sofia_program_profiles`. `profile_key` = `program_slug` (o `program_slug:tier` si
querés distinguir por tier, ej. `mi-programa:vip`).

```sql
INSERT INTO sofia_program_profiles
  (profile_key, program_slug, tier_match, display_name, sofia_objective, knowledge_scope, enabled_skills, admin_links, support_level, routing_priority)
VALUES
  ('mi-programa', 'mi-programa', NULL,
   'Mi Programa - Alumno',
   'El usuario cursa Mi Programa. Tu objetivo: <qué querés que haga Sofía con este alumno>.',
   '["mi-programa"]'::jsonb,
   '["content_qa","accountability","admin_support","sales"]'::jsonb,
   '{"calendario":"https://...","grabaciones":"https://...","skool":"https://...","soporte":"https://..."}'::jsonb,
   'standard', 150)
ON CONFLICT (profile_key) DO NOTHING;
```

- `knowledge_scope`: los slugs a los que se acota el RAG → **aislamiento** (nunca contenido de otro
  programa). Podés compartir scope (ej. `["mi-programa","fundamentos"]`).
- `enabled_skills`: qué skills puede usar el router para este alumno.
- `admin_links`: los que devuelve la skill de soporte administrativo.
- `support_level`: `standard` | `vip` | `one_on_one`.
- `routing_priority`: desempate cuando el alumno está en varios programas (mayor gana).

### 2. (Opcional) Variantes por tier
Si el mismo `program_slug` tiene modalidades distintas (ej. cohorte vs self-paced vs VIP), agregá filas
con `tier_match` = `'standard'` | `'selfpaced'` | `'vip'`, etc. El resolver busca `slug:tier` y cae a la
fila `slug` (tier_match NULL) como catch-all.

### 3. Aplicar y verificar
- Aplicá el SQL: `node scripts/apply-migration.mjs <archivo.sql>` (desde el repo de FIA Copilot).
- La cache del engine refresca sola en ≤5 min. Para forzar: reiniciá el container o esperá.
- Verificá: `GET /api/program-profiles` (con `Authorization: Bearer <ADMIN_API_TOKEN>`).

### 4. Editar sin SQL (después del alta)
Desde el panel/endpoints admin: `PUT /api/program-profiles/<profile_key>` con el/los campos a cambiar.
Los prompts por skill se editan en `engine_config` (`skill_prompt.<skill>`), vía `/admin/config`.

## Notas
- **Nada rompe si no cargás el perfil**: Sofía cae al comportamiento por defecto (Pro/Lead) hasta que la
  fila exista.
- Para que el router/skills actúen hace falta `SKILLS_ROUTER_ENABLED=true` en el env del container. Para
  tool use, además `SOFIA_TOOLS_ENABLED=true`.
- Un programa nuevo NO necesita código salvo que quieras una **skill** nueva (eso sí es código: un módulo
  en `src/skills` + su handler).
