# Sofía 2.0 — Especificación de implementación

> Estado: **planificado, en ejecución por fases**. Cada fase es deployable y no rompe v1.
> Todo comportamiento nuevo queda detrás de un flag apagado por default hasta que Axel lo active.

## Principios de diseño (no negociables)

1. **Zero-downtime / tolerante a migración no aplicada.** Todo lo que lee una tabla nueva debe caer a
   un default hardcodeado si la tabla/columna no existe todavía (mismo patrón que `getPathTotals` y
   `engineConfigCache`). El código se puede deployar ANTES de aplicar la migración.
2. **Data-driven.** Agregar un programa/público nuevo = insertar una fila. Agregar una skill = fila + un
   módulo TS.
3. **Aislamiento por formación.** El RAG de contenido se scopea a los programas que el alumno tiene
   (`enrolledPrograms`). Nunca contenido de un programa no comprado.
4. **Fallback universal.** Ante cualquier fallo del router/skills/tools, se cae a la ruta v1
   (skill `general`), que nunca deja a Sofía muda.

## Contexto de infraestructura (verificado)

- **Misma DB**: engine y FIA Copilot comparten la Supabase `amqqqqubpsjtdufoinlg`. Las tablas del engine
  (`engine_config`, `sofia_*`) viven ahí. El engine se conecta con `SUPABASE_SERVICE_ROLE_KEY`.
- **Deploy**: push a `main` → CI type-check + deploy al VPS Hetzner (`.github/workflows/fia-engine-deploy.yaml`).
  Health check verifica `gitSha` contra `https://engine.axeljutoran.com/health`.
- **Migraciones**: no hay runner en el engine. Se aplican con el script de FIA Copilot
  `node scripts/apply-migration.mjs <archivo.sql>` (usa `SUPABASE_ACCESS_TOKEN` de su `.env.local`,
  Management API). Los `.sql` del engine se pueden pasar a ese script. Todas las migraciones son
  **idempotentes** (`IF NOT EXISTS`, `ON CONFLICT`).
- **Sin tests hoy**: se agrega un verificador de funciones puras que corre contra el `dist` compilado
  (`test/verify-*.mjs`, cero dependencias, `node:assert`), invocable con
  `yarn workspace fia-engagement-engine test`. Se eligió sobre vitest porque el path del repo tiene un
  acento (`Programación`) y rompe la resolución de módulos de vitest en Windows — el verificador
  compilado funciona en cualquier entorno. Smoke test = type-check + build + verifier + `/health` gitSha.
- **Feature flags**: patrón `PILOT_PHONE` + `PILOT_WHITELIST_PHONES` (`config.ts:107-113`). Los flags
  nuevos se agregan como env en `config.ts`.

## Slugs y tiers (fuente de verdad: FIA Copilot)

`user_program_access.program_slug ∈ {fia-ventas, fia-empresas, fia-agentica, diagnostico-empresarial,
fia-claude, fia-claude-labarranca, fia-core, claude-code, google-ai, claude-code-labarranca}`.
`tier ∈ {standard, vip, equipo, preview, selfpaced}`.
Sofía hoy atiende `{fia-ventas, fia-empresas, fia-agentica}` (`has-sofia-access.ts`). El Método 25 pasos
regular = suscriptor sin fila de acceso (`__pro__` sintético). `fia-empresas` es acceso por organización
(`org_role ∈ {sponsor, implementador}`).

---

## Fase 0 — Program profiles data-driven

**Objetivo**: reemplazar `resolveSegmentInfo()` hardcodeado (messageGenerator.ts:464-501) por una tabla
editable, sin cambiar el comportamiento de los segmentos actuales.

**Migración `supabase/migrations/011_sofia_program_profiles.sql`** (idempotente):
```
sofia_program_profiles(
  id uuid pk default gen_random_uuid(),
  profile_key text unique not null,      -- 'fia-agentica:selfpaced', 'fia-ventas:standard', '__pro__', '__lead__', '__empresas_sponsor__'
  program_slug text,                      -- null para sintéticos
  tier_match text,                        -- null = cualquier tier; 'selfpaced'|'vip'|... = específico
  display_name text not null,
  sofia_objective text not null,          -- reemplaza el texto de resolveSegmentInfo
  tone_overrides text,
  catalog_blurb text,
  knowledge_scope jsonb default '[]',     -- slugs para el RAG; [] = usar enrolledPrograms
  enabled_skills jsonb default '[]',
  enabled_journeys jsonb default '["reporte_semanal"]',
  admin_links jsonb default '{}',
  support_level text default 'standard',  -- 'standard'|'vip'|'one_on_one'
  routing_priority int default 100,
  is_active boolean default true,
  updated_at timestamptz default now()
)
```
Seed inicial: perfiles para `fia-agentica:selfpaced`, `fia-agentica:standard`, `fia-agentica:vip`,
`fia-ventas:standard`, `fia-ventas:vip`, `__empresas_sponsor__`, `__empresas_implementador__`, `__pro__`,
`__lead__`. Los `sofia_objective` de empresas/ventas/pro/lead se copian **textualmente** de
`resolveSegmentInfo()` para garantizar comportamiento idéntico.

**`src/db/types.ts`**: agregar interfaz `SofiaProgramProfile`.

**`src/db/supabase.ts`**:
- `getUserSegment()` (1885): sumar `tier` y `cohort_start_date` al select de `user_program_access`;
  incluir `tier` y `cohortStartDate` en cada item de `enrolledPrograms`.
- Nueva `getProgramProfiles(): Promise<SofiaProgramProfile[]>` con cache 5 min (patrón de
  `getLearningPaths`) y `[]` si la tabla no existe.

**`src/config/programProfiles.ts`** (nuevo):
- `resolveProgramProfile(segment, activeSlug?): { name, objective, knowledgeScope, adminLinks, supportLevel, enabledSkills }`.
- Orden: (1) programa activo (`activeSlug` o el de mayor `routing_priority`/más reciente en enrolledPrograms)
  → busca `profile_key = slug:tier`, luego `slug`; (2) sintéticos por flags (empresas sponsor/impl → `__empresas_*__`;
  isPaid → `__pro__`; else `__lead__`).
- **Fallback hardcodeado** = los 4 textos actuales de `resolveSegmentInfo()` (función `HARDCODED_PROFILES`).
  Si `getProgramProfiles()` devuelve `[]` (tabla ausente), usa el fallback → comportamiento v1 exacto.

**`src/generators/messageGenerator.ts`**: reemplazar la llamada a `resolveSegmentInfo(segment)` (línea 552)
por `resolveProgramProfile(segment, activeSlug)`. `knowledgeScope` del perfil (si no vacío) reemplaza el
`programSlugs` crudo de la línea 514. `resolveSegmentInfo` se mueve a `programProfiles.ts` como fallback.

**Admin (API JSON, patrón de `/api/config`)** en `src/server.ts`:
- `GET /api/program-profiles` (admin) → lista.
- `PUT /api/program-profiles/:key` (admin) → upsert de una fila.
- (HTML `/admin/programs` opcional, se puede diferir a Fase 5.)

**Test (vitest)**: `resolveProgramProfile` con tabla vacía = textos v1; con perfil `fia-agentica:selfpaced`
presente = objetivo self-paced; alumno en 2 programas = elige el activo.

**Acceptance**: type-check + build OK; con la migración SIN aplicar, un usuario de cada segmento recibe el
mismo `SEGMENTO/OBJETIVO` que hoy (verificable en logs/dry-run). Con la migración aplicada + seed, los
perfiles nuevos (Agéntica self/cohorte/VIP) resuelven distinto.

---

## Fase 1 — Skills + router (detrás de feature flag)

**Migración `012_sofia_skills.sql`**: tabla `sofia_skills(key, name, router_description,
example_utterances jsonb, prompt_config_key, context_loaders jsonb, tools jsonb, requires_program bool,
priority int, is_active bool, metadata jsonb, updated_at)`. Seed: `general`, `content_qa`, `admin_support`.

**`src/skills/`** (nuevo): `types.ts` (interfaz `Skill` + `SkillContext`), `registry.ts` (mapa key→módulo
con loaders), `general.ts`, `contentQa.ts`, `adminSupport.ts`. Cada módulo declara loaders y arma su
addendum de prompt (`skill_prompt.<key>` en engine_config, con default en `CONFIG_DEFAULTS`).

**`src/router/skillRouter.ts`** (nuevo): `route(msg, recentTurns, enabledSkills, enrolledPrograms) →
{ skill, program_slug, confidence, source }`. Clasificador LLM barato con salida estructurada; primario
Codex (`generateWithCodexConversation` con prompt de router), fallback heurístico keyword. `confidence<0.6`
o error → `general`.

**`config.ts`**: flag `skillsRouterEnabled = optionalEnv("SKILLS_ROUTER_ENABLED","")==="true"`. Rollout
opcional por whitelist reutilizando `pilotWhitelistPhones`.

**`src/senders/responses.ts`** / punto de invocación de `generateInboundReply`: si el flag está ON (y el
usuario está en whitelist si se define), rutear a la skill; si no, comportamiento v1 idéntico.

**Logging**: `{skill, program_slug, confidence, router_source}` en `sofia_conversations.metadata`.

**`sofia_features.metadata.skill_key`**: vincular features a skills (no fusionar tablas).

**Acceptance**: flag OFF → salida byte-a-byte igual a v1. Flag ON en whitelist → el router loguea skill y
confidence; `content_qa` responde contenido, `admin_support` responde links sin contenido.

---

## Fase 2 — Track activo + aislamiento estricto + accountability

**Sin migración** (usa `wa_conversation_state.metadata.activeProgramSlug` + `activeProgramSetAt`, ya jsonb).

- **Track activo**: el router infiere `program_slug` del mensaje; se persiste en metadata (TTL 7 días o
  hasta señal contraria). Saludo/accountability usan el track activo.
- **content_qa aislado**: `knowledge_scope = enrolledPrograms` (todo lo comprado). Si el alumno pregunta
  por un programa que **no** tiene → responde la skill `sales` (deriva como oportunidad). Decisión de Axel:
  si está matriculado en ambos, responde de los dos.
- **Desambiguación**: ante ambigüedad dura en `content_qa` con múltiples programas, Sofía pregunta una vez
  y persiste la respuesta.
- **skill `accountability`** (nueva): loaders `getCapsuleProgressForUser` + `getPathTotals` +
  `resolveUserPaths` + `getEventsForUserSince`.
- **`engine_scheduled_messages.segment`** acepta program_slugs; el orchestrator filtra por
  `enabled_journeys` del perfil.

**Acceptance**: alumno de Agéntica pregunta contenido de Ventas → NO recibe contenido de Ventas si no lo
compró; si lo compró, responde de ambos. Track activo persiste entre turnos.

---

## Fase 3 — Tool use read-only sobre Codex

**`src/generators/codexGenerator.ts`**: extender el parsing SSE para eventos `function_call`
(`response.output_item.added`/`.done` con `type:"function_call"` + `response.function_call_arguments.delta`).
Nueva `generateWithCodexTools(systemPrompt, history, message, tools)` que devuelve `{text?, toolCalls[]}`.

**`src/tools/`** (nuevo): `types.ts` (`Tool = {key, description, jsonSchema, handler, mode, approval}`),
`registry.ts`, `definitions/*.ts`. Adaptadores de schema a formato Responses API (Codex) y Anthropic.

**`src/generators/toolLoop.ts`** (nuevo): loop máx 3 iteraciones, timeout 15s, primario Codex → fallback
Claude/OpenAI pagos → degradación a contexto inyectado (v1). Solo las skills con `tools` entran al loop.

**Tools read-only**: `search_capsules`, `search_knowledge` (→ `searchCapsuleContent`/`searchKnowledge` con
`programSlugs` forzado al scope del perfil), `get_student_progress`, `get_admin_links` (lee
`sofia_program_profiles.admin_links`).

**`engine_config` nueva key `sofia_grounding_rules_tools`**: versión de las grounding rules que permite
usar herramientas (la actual prohíbe DB en tiempo real). `assembleSystemPrompt(profile, skill, toolMode)`
elige la variante según haya tools.

**Acceptance**: el tool loop devuelve resultados reales (no alucinados) y degrada a contexto inyectado con
Codex simulado caído. Costo ≈ $0 con Codex; fallback pago solo si Codex cae.

---

## Fase 4 — Tools de escritura + aprobaciones

**Migración `013_sofia_reminders.sql`**: `sofia_reminders(id, user_id, message, due_at, status, created_by,
created_at)`. Extender `sofia_pending_actions.action_type` con `'escalation'`, `'crm_lead'`.

**Tools write** (con gate `user_confirm` o `staff_approve`, patrón `sofia_pending_actions`):
- `schedule_reminder` → inserta en `sofia_reminders`; tick en `reportScheduler.ts` (respeta business hours +
  opt-out).
- `escalate_to_human` → `evolutionManager.notifyAdmin` + grupo interno + `sofia_pending_actions`.
- `create_crm_lead` → `upsertCampaignLead` + `program_applications` + notificación al closer.

**Acceptance**: ninguna tool de escritura ejecuta sin gate; el reminder se envía en la ventana correcta.

---

## Fase 5 — Consolidación

- Seed de `sofia_features` con las capacidades nuevas (`skill_key` en metadata).
- Runbook "alta de programa en 15 min" (fila en `sofia_program_profiles` + contenido taggeado).
- Dashboard de routing en `/admin/observability` (skill/confidence).
- Skill `sales` formalizada. Editor HTML `/admin/programs` si se difirió.

---

## Activación en producción (feature flags)

Todo lo nuevo (Fases 1-4) está detrás de flags apagados. Fase 0 (perfiles) ya está activa. Para prender:

1. **Router de skills** — env del container: `SKILLS_ROUTER_ENABLED=true`. Recomendado: primero con la
   whitelist piloto (`PILOT_WHITELIST_PHONES`) para probar con tráfico real, luego global.
2. **Tool use** — además: `SOFIA_TOOLS_ENABLED=true` (requiere el router ON). Verificá en vivo que Codex
   responda con function calls (el endpoint es no oficial; el parser está testeado pero la integración
   real solo se ve con tráfico). Si algo falla, degrada solo a la cadena normal.
3. Reiniciar el container (o re-deploy) para tomar el nuevo env. Verificá `GET /health` (gitSha) y
   `GET /api/observability/routing?days=1` para ver las decisiones del router.

Apagar cualquier flag revierte esa capa a v1 sin deploy de código.

## Flujo por fase (para cada una)
1. Implementar código (tolerante a migración ausente).
2. `yarn workspace fia-engagement-engine check` (o `node node_modules/typescript/bin/tsc --build ...` en Windows).
3. `yarn workspace fia-engagement-engine build`.
4. Tests vitest de la fase.
5. Commit + push a `main` (deploy auto, flags OFF).
6. Smoke: `curl https://engine.axeljutoran.com/health` → gitSha == commit; hit al endpoint nuevo.
7. Entregar el/los `.sql` de la fase + comando de aplicación; avanzar.
