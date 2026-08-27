-- Fase 1 de Sofía: rastro de por qué decidió callarse y cómo armó cada respuesta.
--
-- Va en TABLA PROPIA, y no es preferencia de estilo. La primera versión escribía en
-- `sofia_conversations` y eso rompía tres cosas a la vez:
--   1. `getGroupHistory` no filtra por `kind`, así que las filas de diagnóstico entraban
--      al prompt del modelo etiquetadas como mensajes de Sofía.
--   2. `truncatedThreads` cuenta hilos cuyo último mensaje es entrante — o sea, sin
--      contestar. Agregar una fila `out` después de cada entrante lo llevaba a cero, y esa
--      es justo la métrica que mide el síntoma que vinimos a arreglar.
--   3. `getConversationHistory` filtra solo por `user_id`, así que un diagnóstico de grupo
--      terminaba dentro del hilo privado de otra persona.
--
-- Una tabla aparte no puede contaminar ninguna ventana de contexto.

create table if not exists public.sofia_diagnostics (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),

  -- Contexto del mensaje
  group_jid         text,
  conversation_id   uuid,

  -- Quién escribió. Se guardan por separado a propósito: en grupos WhatsApp identifica
  -- por @lid, no por teléfono, y mezclarlos hace que un join contra profiles matchee mal.
  asker_phone       text,
  asker_lid         text,

  -- Causa raíz A: un mismo id servía para "quién pregunta" y "de quién es la pregunta".
  subject_user_id   uuid,
  subject_origin    text check (subject_origin in ('grupo','quien_pregunta','ninguno')),

  -- Por qué se calló. Null si respondió.
  motivo_silencio   text check (motivo_silencio in
                      ('no_etiquetada','rate_limit','sin_respuesta','mensaje_vacio','grupo_no_registrado')),

  -- Causa raíz D: dos motores de búsqueda que devuelven cosas distintas
  motor_busqueda    text check (motor_busqueda in ('semantico','palabras','ninguno')),
  fragmentos        int,
  -- Similitudes CRUDAS, antes del corte: sin esto el umbral solo se puede mover a ojo
  similitudes       numeric[],

  texto             text
);

create index if not exists sofia_diagnostics_created_idx on public.sofia_diagnostics (created_at desc);
create index if not exists sofia_diagnostics_group_idx   on public.sofia_diagnostics (group_jid, created_at desc);
create index if not exists sofia_diagnostics_motivo_idx  on public.sofia_diagnostics (motivo_silencio)
  where motivo_silencio is not null;

alter table public.sofia_diagnostics enable row level security;

-- Solo service role, igual que sofia_conversations: acá hay texto de conversaciones.
drop policy if exists sofia_diagnostics_service_only on public.sofia_diagnostics;
create policy sofia_diagnostics_service_only on public.sofia_diagnostics
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
