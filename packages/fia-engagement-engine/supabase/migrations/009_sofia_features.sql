-- Sofia features registry: living "estado del arte" of what Sofía can do.
-- Feeds: FIACO Pilot context, developer reference, landing page copy.
-- Three consumers:
--   • GET /api/sofia/features  → FIACO Pilot / landing page (public)
--   • Direct DB query          → programmer / admin reference
--   • Future: FC knowledge_base seed via a separate script

CREATE TABLE IF NOT EXISTS sofia_features (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  key             TEXT        UNIQUE NOT NULL,
  category        TEXT        NOT NULL CHECK (category IN (
                                'outbound_journey',
                                'inbound_command',
                                'inbound_ai',
                                'admin',
                                'infrastructure'
                              )),
  title           TEXT        NOT NULL,
  summary         TEXT        NOT NULL,   -- 1 sentence; used in landing page + AI context
  description     TEXT        NOT NULL,   -- full description for AI grounding + developers
  technical_notes TEXT,                   -- implementation detail; developer-only
  status          TEXT        NOT NULL DEFAULT 'live' CHECK (status IN (
                                'live', 'beta', 'planned', 'deprecated'
                              )),
  since           DATE,
  metadata        JSONB       NOT NULL DEFAULT '{}',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION update_sofia_features_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sofia_features_updated_at
  BEFORE UPDATE ON sofia_features
  FOR EACH ROW EXECUTE PROCEDURE update_sofia_features_updated_at();

ALTER TABLE sofia_features ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service role full access" ON sofia_features
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_sofia_features_category ON sofia_features(category);
CREATE INDEX IF NOT EXISTS idx_sofia_features_status   ON sofia_features(status);
CREATE INDEX IF NOT EXISTS idx_sofia_features_updated  ON sofia_features(updated_at DESC);

-- ─── Seed: initial state of the art (idempotent) ───────────────────────────

INSERT INTO sofia_features (key, category, title, summary, description, technical_notes, status, metadata) VALUES

-- ── Outbound journeys ──────────────────────────────────────────────────────

('weekly_report', 'outbound_journey',
  'Reporte semanal personalizado',
  'Cada domingo Sofía envía por WhatsApp un resumen de lo que el alumno logró en la semana y cuál es su próximo paso en el programa.',
  'Sofía genera un mensaje personalizado para cada usuario activo basado en: cápsulas completadas en los últimos 7 días, próxima acción pendiente en el track activo (o en el Método de 25 pasos para alumnos premium sin track), y un deep link a su panel. El mensaje es generado por IA (Codex → Claude → template como fallback) y está limitado a 320 caracteres para asegurar legibilidad en WhatsApp.',
  'Detector: src/detectors/weeklyReport.ts. Generador: src/generators/messageGenerator.ts#generateWeeklyReport. Cron configurable desde /admin/schedule, default "0 17 * * 0" (domingo 17 hs UTC). Sólo envía a usuarios con whatsapp_opt_in=true y sofia_activated_at no nulo.',
  'live',
  '{"cron_default": "0 17 * * 0", "max_chars": 320, "ai_chain": ["codex", "claude", "template"]}'::jsonb),

('click_tracking', 'outbound_journey',
  'Rastreo de clics en deep links',
  'Todos los links enviados por Sofía pasan por un redirect tracker que registra si el alumno hizo clic y cuándo.',
  'Cada mensaje saliente incluye un link del tipo /r/{uuid} que registra el evento de clic en engagement_log (metadata.clicked=true, metadata.clicked_at) antes de redirigir al destino final. Esto permite medir el click-through rate del reporte semanal y otros mensajes.',
  'Endpoint: GET /r/:logId en src/server.ts. Actualiza engagement_log via updateEngagementLogClicked() en src/db/supabase.ts.',
  'live',
  '{}'::jsonb),

-- ── Inbound commands ───────────────────────────────────────────────────────

('cmd_stop', 'inbound_command',
  'Baja voluntaria (STOP)',
  'El alumno puede escribir STOP o PARAR en cualquier momento para dejar de recibir mensajes de Sofía.',
  'Al detectar la keyword STOP o PARAR (insensible a mayúsculas/acentos), Sofía desactiva el opt-in del usuario (whatsapp_opt_in=false, sofia_deactivated_at=now()) y envía un mensaje de confirmación. El panel de FIA Copilot muestra el estado "diste de baja por WhatsApp" con opción de reactivar.',
  'Clasificado en classifyResponse() de src/senders/responses.ts. Escribe en profiles.whatsapp_opt_in y profiles.sofia_deactivated_at via setOptOut() en src/db/supabase.ts.',
  'live',
  '{"keywords": ["STOP", "PARAR"]}'::jsonb),

('cmd_retomar', 'inbound_command',
  'Reactivación (SÍ / RETOMAR)',
  'El alumno puede reactivar Sofía escribiendo SÍ, SI o RETOMAR después de haberse dado de baja.',
  'Al detectar las keywords SÍ, SI o RETOMAR, Sofía reactiva el opt-in (whatsapp_opt_in=true, sofia_activated_at=now(), sofia_deactivated_at=null) y envía un mensaje de bienvenida de vuelta con el link al dashboard.',
  'Clasificado en classifyResponse(). Escribe via reactivateSofia() en src/db/supabase.ts.',
  'live',
  '{"keywords": ["SI", "SÍ", "RETOMAR"]}'::jsonb),

('cmd_ayuda', 'inbound_command',
  'Pedido de ayuda (AYUDA / HELP)',
  'El alumno puede escribir AYUDA o HELP para recibir el link directo a reservar una llamada con el coach.',
  'Responde con un mensaje configurable desde /admin/config (key: reply_ayuda) que incluye el link de booking del coach.',
  'Clasificado en classifyResponse(). Respuesta cargada desde engine_config via getEngineConfig("reply_ayuda").',
  'live',
  '{"keywords": ["AYUDA", "HELP"]}'::jsonb),

('cmd_ventas', 'inbound_command',
  'Info de ventas (VENTAS)',
  'El alumno puede escribir VENTAS para recibir información sobre FIA Ventas y el link de upgrade.',
  'Responde con un mensaje configurable desde /admin/config (key: reply_ventas) que incluye el link a FIA Ventas.',
  'Clasificado en classifyResponse(). Respuesta cargada desde engine_config via getEngineConfig("reply_ventas").',
  'live',
  '{"keywords": ["VENTAS"]}'::jsonb),

('cmd_diagnostico', 'inbound_command',
  'Resultados de diagnóstico (DIAGNOSTICO)',
  'El alumno puede escribir DIAGNOSTICO para recibir el link directo a sus resultados de diagnóstico en FIA Copilot.',
  'Responde con un deep link a /diagnostico del panel del usuario, incluyendo un resumen del último score si está disponible.',
  'Clasificado en classifyResponse(). Deep link construido con config.engine.appBaseUrl + /diagnostico.',
  'live',
  '{"keywords": ["DIAGNOSTICO"]}'::jsonb),

('cmd_perfil', 'inbound_command',
  'Edición de perfil (PERFIL)',
  'El alumno puede escribir PERFIL para recibir el link directo a editar su perfil en FIA Copilot.',
  'Responde con el link a /perfil del panel del usuario para que pueda actualizar sus datos (empresa, industria, objetivo, etc.).',
  'Clasificado en classifyResponse(). Deep link construido con config.engine.appBaseUrl + /perfil.',
  'live',
  '{"keywords": ["PERFIL"]}'::jsonb),

('cmd_puntos', 'inbound_command',
  'Lead score (PUNTOS)',
  'El alumno puede escribir PUNTOS para ver su puntaje de fit e intent en el sistema CRM de FIA.',
  'Responde con un mensaje que incluye el overall_score, fit_score e intent_score del usuario (leídos de lead_scores en tiempo real) y el link a /puntos del panel.',
  'Clasificado en classifyResponse(). Lee lead_scores via getLeadScore(). Deep link a /puntos.',
  'live',
  '{"keywords": ["PUNTOS"]}'::jsonb),

-- ── Inbound AI ─────────────────────────────────────────────────────────────

('ai_conversation', 'inbound_ai',
  'Conversación IA con memoria multi-turn',
  'Sofía mantiene conversaciones naturales por WhatsApp con los alumnos, recordando el contexto de mensajes anteriores y usando el perfil, progreso y trabajo del alumno para dar respuestas personalizadas.',
  'Para mensajes de texto libre (no comandos), Sofía construye un prompt con: perfil del usuario (empresa, industria, objetivo), historial de conversación (últimos N turnos), outputs del vault (trabajo previo del alumno), respuestas de assessments, base de conocimiento de FIA (frameworks, principios, metodología), y hechos extraídos previamente. El prompt se envía a Codex o Claude con un system prompt configurable desde /admin/config.',
  'Generador: src/generators/messageGenerator.ts#generateInboundReply. Historial: sofia_conversations. State: wa_conversation_state. Límite de historial: configurable vía MAX_CONVERSATION_HISTORY_TURNS. Cooldown automático si Claude falla 3+ veces en 5 min.',
  'live',
  '{"max_history_turns": 20, "ai_chain": ["codex", "claude", "template_rotation"]}'::jsonb),

('low_engagement_filter', 'inbound_ai',
  'Filtro de mensajes de bajo engagement',
  'Sofía detecta mensajes vacuos (stickers, emojis solos, mensajes automáticos de WhatsApp) y no responde para evitar loops de spam.',
  'Antes de procesar cualquier mensaje entrante, el clasificador detecta señales de bajo engagement: conteo de palabras < 2, solo emojis, mensajes de estado de WhatsApp, o el mismo mensaje repetido 3+ veces consecutivas. Si el usuario supera el umbral de mensajes de bajo engagement consecutivos (wa_conversation_state.consecutive_low_engagement), Sofía silencia las respuestas automáticamente.',
  'Clasificador: isLowEngagement() en src/senders/responses.ts. Estado: wa_conversation_state.consecutive_low_engagement. Umbral: LOW_ENGAGEMENT_THRESHOLD (default: 5).',
  'live',
  '{"threshold": 5}'::jsonb),

('fact_extraction', 'inbound_ai',
  'Extracción de hechos del alumno',
  'Sofía detecta automáticamente cuando el alumno menciona datos de su negocio (equipo, herramientas, industria, blockers) y los guarda para enriquecer futuras respuestas.',
  'Luego de generar una respuesta IA, el generador extrae hechos estructurados del mensaje del usuario (tamaño del equipo, profesión, herramientas que usa, blockers, objetivos) y los persiste en wa_conversation_state.metadata.userFacts (máx. 8 hechos, rotativos). Estos hechos se inyectan en el contexto de futuras conversaciones para personalizar las respuestas sin que el alumno tenga que repetir su situación.',
  'Extractor: extractUserFacts() en src/generators/messageGenerator.ts. Storage: wa_conversation_state.metadata.userFacts (JSONB). Max 8 facts, FIFO rotation.',
  'live',
  '{"max_facts": 8}'::jsonb),

('group_replies', 'inbound_ai',
  'Respuestas en grupos de WhatsApp',
  'Sofía puede participar en grupos de WhatsApp de seguimiento de alumnos, respondiendo cuando alguien la menciona por nombre o la etiqueta directamente.',
  'Cuando se recibe un mensaje en un grupo (webhook de Evolution API), Sofía evalúa si debe responder: si el mensaje la menciona (sofia, sofi, @sofía) o si fue tagged. En grupos, Sofía tiene contexto del alumno asociado al grupo (sofia_groups.student_user_id), puede ver el historial de conversación del grupo (sofia_conversations con conversation_id del grupo), y conoce el rol de cada participante (sofia_group_members: coach, student, superadmin, bot).',
  'Webhook: POST /webhook/whatsapp/evolution en src/server.ts. Grupo lookup: sofia_groups. Miembros: sofia_group_members. Generador: src/generators/messageGenerator.ts#generateGroupReply. Trigger keywords configurables en engine_config (sofia_mention_triggers).',
  'live',
  '{"trigger_keywords": ["sofia", "sofi"]}'::jsonb),

-- ── Admin ──────────────────────────────────────────────────────────────────

('admin_panel', 'admin',
  'Panel CEO/coach de engagement',
  'Dashboard web con métricas de engagement en tiempo real: mensajes enviados, click rate, response rate, usuarios activos, y drill-down por alumno.',
  'El panel /admin muestra: métricas globales de la semana (enviados, clics, respuestas, bajas), lista de todos los usuarios con Sofía activa con su último mensaje y estado, y drill-down por usuario con historial completo de conversación y progreso en el programa.',
  'Handler: handleDashboard() en src/server.ts. Rendering: src/admin/panel.ts. Combina datos de: profiles, capsule_progress, engagement_log, sofia_conversations, lead_scores, vault_outputs, assessments.',
  'live',
  '{"url": "/admin"}'::jsonb),

('admin_config', 'admin',
  'Editor de prompts y respuestas sin redeploy',
  'Los prompts de Sofía, respuestas a comandos y configuraciones de comportamiento se pueden editar desde un panel web sin necesidad de redesplegar el servidor.',
  'El editor en /admin/config permite modificar en tiempo real: el system prompt de Sofía, las respuestas a cada comando (STOP, AYUDA, VENTAS, etc.), el mensaje de activación, el mensaje del reporte semanal (template fallback), y otros parámetros. Los cambios se guardan en engine_config y se aplican en el siguiente mensaje sin restart.',
  'UI: src/admin/config.ts. Cache: src/config/engineConfigCache.ts. Hot-reload: configCache.invalidate() al actualizar una key. Endpoint PUT /api/config/:key para actualizaciones.',
  'live',
  '{"url": "/admin/config"}'::jsonb),

('admin_observability', 'admin',
  'Dashboard de observabilidad y clasificación de conversaciones',
  'Panel de análisis que muestra las preguntas más frecuentes de los alumnos, el sentimiento de las conversaciones, la efectividad de las respuestas de Sofía, y patrones de uso.',
  'El dashboard /admin/observability clasifica automáticamente los mensajes entrantes por categoría (duda_metodologica, bloqueo_tecnico, motivacion, off_topic, etc.), sentimiento (positivo/negativo/neutro), y si la respuesta de Sofía fue efectiva. Un job periódico re-clasifica conversaciones recientes y actualiza sofia_conversations.metadata con los labels.',
  'Job: src/jobs/classifyConversations.ts. UI: src/admin/observability.ts. Clasificación via Claude (function calling). Endpoints GET /api/observability/stats, /threads, /thread/:id.',
  'live',
  '{"url": "/admin/observability"}'::jsonb),

('admin_schedule', 'admin',
  'Editor de cron del reporte semanal',
  'El horario del reporte semanal se puede cambiar desde un panel web sin editar código.',
  'El panel /admin/schedule muestra el cron actual y permite editarlo con un selector visual. El cambio se persiste en engine_config (key: report_schedule) y reactiva el scheduler en memoria sin restart.',
  'UI: src/admin/schedule.ts. Aplica nuevo cron via rescheduleReport() en src/reportScheduler.ts. Endpoint GET /api/schedule (leer) y POST /api/schedule (actualizar).',
  'live',
  '{"url": "/admin/schedule", "cron_default": "0 17 * * 0"}'::jsonb),

-- ── Infrastructure ─────────────────────────────────────────────────────────

('multi_provider', 'infrastructure',
  'Soporte multi-proveedor de WhatsApp',
  'El engine puede enviar mensajes via Evolution API, Meta Cloud API o Twilio, configurable por variable de entorno sin cambios de código.',
  'El proveedor se selecciona con WHATSAPP_PROVIDER (evolution | cloud_api | twilio). Evolution API corre en el VPS de Hostinger como container Docker. Meta Cloud API usa la Business API oficial de Meta. Twilio es el fallback si los otros dos no están disponibles. Todos exponen la misma interfaz sendMessage().',
  'Senders: src/senders/whatsappEvolution.ts, src/senders/whatsapp.ts. Factory: selectProvider() en src/senders/whatsapp.ts. Config: config.whatsapp en src/config.ts.',
  'live',
  '{"providers": ["evolution", "cloud_api", "twilio"], "default": "evolution"}'::jsonb),

('business_hours', 'infrastructure',
  'Enforcement de horario laboral por timezone',
  'Sofía solo envía mensajes entre las 9 AM y las 6 PM del horario local del alumno, respetando su país.',
  'Antes de enviar cualquier mensaje, el engine verifica que la hora actual en el timezone del usuario (Argentina, Chile, Colombia, México, España, etc.) sea lunes a viernes entre 9:00 y 18:00. Mensajes fuera de horario se encollan como pending para el próximo día hábil. Este comportamiento es bypasseable con BYPASS_BUSINESS_HOURS=true para testing.',
  'Check: isWithinBusinessHours() en src/orchestrator.ts. Timezone lookup: profiles.country → COUNTRY_TIMEZONE_MAP en src/config/engineVariables.ts. Bypass: config.engine.bypassBusinessHours.',
  'live',
  '{"hours": "09:00-18:00", "days": "Mon-Fri"}'::jsonb),

('rate_limiting', 'infrastructure',
  'Límite de mensajes por usuario por día',
  'El engine garantiza que ningún alumno reciba más de 1 mensaje de Sofía por día para evitar spam.',
  'Antes de enviar un mensaje, el engine consulta engagement_log para verificar que el usuario no recibió ya un mensaje en las últimas 24 horas. Si ya recibió uno, el mensaje se descarta con status skipped_paused. El límite es configurable via MAX_MESSAGES_PER_USER_PER_DAY.',
  'Check: hasRecentMessage() en src/db/supabase.ts. Configurable via config.engine.maxMessagesPerUserPerDay (default: 1). Status logged como "skipped_paused" en engagement_log.',
  'live',
  '{"max_per_day": 1}'::jsonb),

('ai_fallback_chain', 'infrastructure',
  'Cadena de fallback automático (Codex → Claude → template)',
  'Si el modelo IA principal falla, Sofía intenta automáticamente el siguiente hasta llegar a un template determinístico como último recurso.',
  'Para cada mensaje que requiere generación IA, el engine ejecuta en cadena: 1) Codex (ChatGPT Plus via OAuth), 2) Claude API (Anthropic), 3) Template determinístico hardcodeado. Si Claude falla 3 veces consecutivas en 5 minutos, activa un cooldown automático y rota entre respuestas seguras predefinidas. Esto garantiza que Sofía nunca deje de responder por fallas de APIs externas.',
  'Cadena: generateMessage() en src/generators/messageGenerator.ts. Cooldown: wa_conversation_state.metadata.aiReplyTimestamps. Template pool: SAFE_FALLBACK_RESPONSES en messageGenerator. Codex auth: src/generators/codex.ts.',
  'live',
  '{"chain": ["codex", "claude", "template"], "cooldown_after_failures": 3, "cooldown_window_minutes": 5}'::jsonb),

('knowledge_injection', 'infrastructure',
  'Inyección de base de conocimiento anti-alucinación',
  'Sofía gronda sus respuestas en la base de conocimiento real de FIA (frameworks, metodología, programas, ICP) para evitar inventar información.',
  'Antes de generar cada respuesta de conversación libre, el engine realiza una búsqueda semántica (pgvector cosine similarity) o keyword scoring sobre la tabla knowledge_base para recuperar los 6 chunks más relevantes a la pregunta del alumno. Estos se inyectan en el prompt de Sofía como contexto verificado. Si no hay embeddings disponibles (primer arranque), hace fallback a keyword search sobre el cache de knowledge_base.',
  'Búsqueda: searchKnowledge() en src/db/supabase.ts. Embedding: embedText() con OpenAI text-embedding-3-small. RPC: match_knowledge() (pgvector, migración 008). Cache: 5 min en memoria.',
  'live',
  '{"embedding_model": "text-embedding-3-small", "top_k": 6, "min_similarity": 0.25}'::jsonb),

('pilot_mode', 'infrastructure',
  'Modo piloto para testear sin afectar usuarios',
  'El modo piloto redirige todos los mensajes de Sofía a un único número de teléfono de prueba, sin afectar a los usuarios reales.',
  'Con PILOT_MODE=true y NOTIFY_PHONE configurado, el engine procesa el pipeline completo (detectores, generadores, engagement log) pero envía todos los mensajes WhatsApp al número de notificación en lugar de al usuario real. Los mensajes incluyen el nombre del destinatario original entre corchetes para identificarlos. Ideal para validar nuevo comportamiento antes de activar con toda la base.',
  'Config: config.engine.pilotMode y config.engine.notifyPhone en src/config.ts. Override en sendWhatsAppMessage() en src/senders/whatsapp.ts.',
  'live',
  '{"env_var": "PILOT_MODE", "notify_phone_var": "NOTIFY_PHONE"}'::jsonb)

ON CONFLICT (key) DO NOTHING;
