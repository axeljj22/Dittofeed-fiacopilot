/**
 * Bidirectional response handler.
 *
 * Processes incoming WhatsApp replies and takes action:
 * - STOP / PARAR → opt out
 * - SI / RETOMAR → log reactivation
 * - AYUDA / HELP → reply with help link
 * - VENTAS → link to upgrade/FIA Ventas page
 * - DIAGNOSTICO → link to diagnostic results
 * - PERFIL → link to user profile
 * - PUNTOS → fetch and reply with current lead score
 * - Anything else → AI reply (Sofía) with segmentation, rate limiting, loop detection
 */
import { config } from "../config";
import { logger } from "../logger";
import {
  getSupabaseClient,
  getLeadScoreForUser,
  insertIncomingMessage,
  getUserSegment,
  getConversationState,
  upsertConversationState,
  deactivateSofia,
  activateSofia,
  logConversation,
  findProfileByPhone,
  getOrCreateSofiaGroup,
  updateSofiaGroupStudent,
  updateSofiaGroupLabel,
  upsertGroupMembers,
  getGroupHistory,
} from "../db/supabase";
import type { GroupMember } from "../db/supabase";
import { getCommandReply, getTrackingLinkBase, getPositiveShortResponses } from "../config/engineConfigCache";
import { generateInboundReply, generateGroupReply } from "../generators/messageGenerator";

export interface IncomingMessage {
  from: string; // WhatsApp number
  body: string;
  messageId?: string;
}

export interface ResponseAction {
  type: "opt_out" | "reactivation" | "help" | "ventas" | "diagnostico" | "perfil" | "puntos" | "default";
  replyText: string;
  updateProfile?: Record<string, unknown>;
  logEvent?: string;
}

/** Mensaje para números no registrados en FIA Copilot */
const UNREGISTERED_MESSAGE =
  `Hola! Para recibir mensajes de Sofía necesitás registrarte en FIA Copilot ` +
  `y agregar tu número de WhatsApp en Ajustes: ${config.engine.appBaseUrl}/ajustes`;

/** Fallback message for low-engagement loop close (overridable via /admin/config key: cmd_reply.low_engagement_close) */
const LOW_ENGAGEMENT_CLOSE_DEFAULT = `Cuando quieras retomar estoy acá. Tu dashboard: ${config.engine.appBaseUrl}/dashboard`;

/** Respuestas cortas con intención clara — no silenciar aunque sean breves */
const POSITIVE_SHORT_RESPONSES = new Set([
  // Afirmaciones
  "si", "sí", "dale", "ok", "okay", "bueno", "buenas", "claro", "bien", "listo", "va", "vamos",
  // Curiosidad / interés
  "me interesa", "contame", "quiero", "cómo", "como", "cuando", "cuándo", "que", "qué",
  "donde", "dónde", "porque", "porqué", "por qué",
  // Agradecimiento
  "gracias", "muchas gracias", "graci", "gracis", "thx",
  // Apreciación
  "genial", "perfecto", "entendido", "excelente", "buenísimo", "buenisimo",
  "bárbaro", "barbaro", "piola", "copado", "interesante", "buena", "buenaza",
  // Continuidad
  "adelante", "seguí", "segui", "contá", "conta", "me llama la atención",
  // Confusión / ayuda (NO silenciar — son señales de que necesita guía)
  "no entiendo", "no se", "no sé", "no comprendo", "explicame", "explicá", "explica",
  "ayuda", "help", "como hago", "cómo hago", "y eso", "y entonces",
  // Estados
  "ahora no", "después", "despues", "más tarde", "mas tarde", "luego",
  // Saludos
  "hola", "buenas", "holi", "ey", "hey", "buen día", "buen dia",
  "buenos días", "buenas tardes", "buenas noches",
  // Despedidas
  "chau", "nos vemos", "hasta luego", "saludos",
]);

/** ¿El mensaje es de baja calidad? Solo lo verdaderamente vacío — WhatsApp es naturalmente corto */
async function isLowEngagement(body: string): Promise<boolean> {
  const normalized = body.trim().toLowerCase();
  if (POSITIVE_SHORT_RESPONSES.has(normalized)) return false;
  // Respuestas positivas configurables desde /admin/config (se suman al set local)
  try {
    const configured = await getPositiveShortResponses();
    if (configured.has(normalized)) return false;
  } catch { /* fallback al set local */ }
  // Si tiene ?, ! o emoji, hay intención
  if (/[?!¿¡]/.test(body)) return false;
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(body)) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  // Subido de <3 a <2: solo mensajes de UNA palabra sin marcadores cuentan como bajo
  return words.length < 2;
}

export function classifyResponse(body: string): ResponseAction {
  const normalized = body.trim().toUpperCase();

  // Opt-out: STOP / PARAR
  if (normalized === "STOP" || normalized === "PARAR") {
    return {
      type: "opt_out",
      replyText:
        "Listo, no recibirás más mensajes de seguimiento. Si en algún momento querés retomar, respondé SI.",
      updateProfile: { whatsapp_opt_in: false },
    };
  }

  // Reactivation: SI / SÍ / RETOMAR
  if (normalized === "SI" || normalized === "SÍ" || normalized === "RETOMAR") {
    return {
      type: "reactivation",
      replyText: `¡Genial! Tu progreso te espera: ${config.engine.appBaseUrl}/dashboard`,
      logEvent: "reactivacion_confirmada",
    };
  }

  // Help: AYUDA / HELP
  if (normalized === "AYUDA" || normalized === "HELP") {
    return {
      type: "help",
      replyText: `Agendá una llamada con el equipo acá: ${config.engine.appBaseUrl}/agendar`,
    };
  }

  // FIA Ventas / upgrade
  if (normalized === "VENTAS") {
    return {
      type: "ventas",
      replyText: `Mirá todo lo que incluye FIA Ventas acá: ${config.engine.appBaseUrl}/upgrade?ref=wa_ventas`,
    };
  }

  // Diagnostic results
  if (normalized === "DIAGNOSTICO") {
    return {
      type: "diagnostico",
      replyText: `Tus resultados del diagnóstico están acá: ${config.engine.appBaseUrl}/diagnostico`,
    };
  }

  // User profile
  if (normalized === "PERFIL") {
    return {
      type: "perfil",
      replyText: `Editá tu perfil desde acá: ${config.engine.appBaseUrl}/perfil`,
    };
  }

  // Lead score — reply text is enriched in processIncomingResponse once we have the userId
  if (normalized === "PUNTOS") {
    return {
      type: "puntos",
      replyText: `Tu score de FIA está disponible en tu dashboard: ${config.engine.appBaseUrl}/dashboard`,
    };
  }

  return {
    type: "default",
    replyText: "",
  };
}

/**
 * Process an incoming WhatsApp response.
 * Returns the reply text to send back (empty string = no reply / silence).
 */
export async function processIncomingResponse(
  message: IncomingMessage,
): Promise<ResponseAction> {
  const normalizedFrom = message.from.replace(/\D/g, "");

  // ── 1. Classify message ──────────────────────────────────────────────────
  let classified = classifyResponse(message.body);

  // ── 2. Look up profile ──────────────────────────────────────────────────
  // Try both "5491125120212" and "+5491125120212" — apps may store either format.
  const { data: profile } = await getSupabaseClient()
    .from("profiles")
    .select("id, whatsapp_opt_in, wp_opted_out, sofia_activated_at")
    .or(`phone.eq.${normalizedFrom},phone.eq.+${normalizedFrom}`)
    .maybeSingle();

  if (!profile) {
    // Silenciar — no enviar UNREGISTERED_MESSAGE. Si alguien escribe y no está
    // en la DB, probablemente fue alguien que recibió un mensaje nuestro (piloto)
    // cuyo teléfono aún no está sincronizado. Logueamos y quedamos en silencio.
    logger.warn({ from: message.from, normalizedFrom }, "No profile found for incoming number — silencing");
    await insertIncomingMessage(message.from, message.body, null, message.messageId ?? null);
    return { type: "default", replyText: "" };
  }

  const userId = profile.id as string;

  // ── 3. Opt-out check ────────────────────────────────────────────────────
  // If user opted out, stay silent (don't even save to DB to avoid noise)
  const optedOut =
    profile.whatsapp_opt_in === false ||
    (profile as Record<string, unknown>)["wp_opted_out"] === true;

  if (optedOut && classified.type !== "opt_out") {
    logger.info({ userId }, "Incoming message from opted-out user — silencing");
    return { type: "default", replyText: "" };
  }

  // ── 4. Save incoming message ─────────────────────────────────────────────
  await insertIncomingMessage(message.from, message.body, userId, message.messageId ?? null);

  // ── 4b. Inbound-first activation ─────────────────────────────────────────
  // The "Activar Sofía" button in /perfil opens WhatsApp with a pre-filled message.
  // The first inbound from a recognized user CONFIRMS activation — but only if they
  // already opted in (the front gates opt-in/email/paid before showing the button).
  // Without the opt-in check, anyone whose phone is on file would get auto-activated.
  if (
    profile.sofia_activated_at == null &&
    profile.whatsapp_opt_in === true &&
    classified.type !== "opt_out"
  ) {
    await activateSofia(userId);
  }

  // ── 5. Handle commands (non-default) ────────────────────────────────────
  if (classified.type !== "default") {
    // Try to load dynamic command reply from DB (editable via /admin/config)
    const cmdKeyMap: Partial<Record<ResponseAction["type"], string>> = {
      opt_out: "stop", reactivation: "si", help: "ayuda",
      ventas: "ventas", diagnostico: "diagnostico", perfil: "perfil", puntos: "puntos",
    };
    const cmdKey = cmdKeyMap[classified.type];
    if (cmdKey) {
      const dynamicReply = await getCommandReply(cmdKey);
      if (dynamicReply) classified = { ...classified, replyText: dynamicReply };
    }

    let action = classified;

    // Enrich PUNTOS with actual score
    if (action.type === "puntos") {
      const scores = await getLeadScoreForUser(userId);
      if (scores) {
        action = {
          ...action,
          replyText:
            `Tu score FIA: ${scores.overall_score}/100 ` +
            `(Fit: ${scores.fit_score}, Intent: ${scores.intent_score}). ` +
            `Ver detalle: ${config.engine.appBaseUrl}/diagnostico`,
        };
      }
    }

    // Update profile if needed.
    if (action.type === "opt_out") {
      // STOP → fully deactivate Sofía (clears whatsapp_opt_in AND sofia_activated_at)
      await deactivateSofia(userId);
      logger.info({ userId }, "Sofía deactivated via STOP");
    } else if (action.updateProfile) {
      await getSupabaseClient()
        .from("profiles")
        .update(action.updateProfile)
        .eq("id", userId);
      logger.info({ userId, action: action.type }, "Profile updated from response");
    }

    // Log event if needed
    if (action.logEvent) {
      await getSupabaseClient().from("events").insert({
        lead_id: userId,
        event_type: action.logEvent,
        metadata: { source: "whatsapp_response", message: message.body.slice(0, 500) },
      });
    }

    // Wrap link in command replies for click tracking too
    if (action.replyText && action.replyText.includes("http")) {
      action = { ...action, replyText: await wrapLinksWithTracking(action.replyText, userId, normalizedFrom) };
    }

    // Unified conversation log (inbound command + outbound reply)
    await logConversation({ user_id: userId, direction: "in", kind: "command", body: message.body });
    if (action.replyText) {
      await logConversation({ user_id: userId, direction: "out", kind: "command", body: action.replyText });
    }

    logger.info({ userId, type: action.type, from: message.from }, "Command response processed");
    return action;
  }

  // ── 6. Free-text: log response in engagement_log + enrich deep link ─────
  let action = classified; // type === "default", replyText === ""

  const { data: latestLog } = await getSupabaseClient()
    .from("engagement_log")
    .select("id, message, metadata")
    .eq("lead_id", userId)
    .eq("status", "sent")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (latestLog?.id) {
    await getSupabaseClient()
      .from("engagement_log")
      .update({
        metadata: {
          ...(latestLog.metadata as Record<string, unknown>),
          responded: true,
          response_text: message.body.slice(0, 1000),
        },
      })
      .eq("id", latestLog.id);
  }

  // ── 7. Pilot mode guard ──────────────────────────────────────────────────
  // Si el engine le escribió primero en los últimos 14 días, siempre responde con IA.
  // Evita el caso: "te escribí pero no te reconozco cuando me respondés".
  const isWhitelisted = config.engine.pilotWhitelistPhones.some((p) => normalizedFrom.includes(p));
  const since14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentOutbound } = await getSupabaseClient()
    .from("engagement_log")
    .select("id")
    .eq("lead_id", userId)
    .eq("status", "sent")
    .gte("created_at", since14d)
    .limit(1)
    .maybeSingle();
  const hadRecentOutbound = recentOutbound !== null;
  const isAIPilot = !config.engine.pilotPhone
    || normalizedFrom.includes(config.engine.pilotPhone)
    || isWhitelisted
    || hadRecentOutbound;
  if (!isAIPilot) {
    logger.warn(
      { userId, from: message.from, body: message.body.slice(0, 200) },
      "AI inbound reply skipped — user not in pilot whitelist and no recent outbound",
    );
    // Avisar a Axel que alguien le habló a Sofía pero no le respondimos
    try {
      const { evolutionManager } = await import("./whatsappEvolution");
      await evolutionManager.notifyAdmin(
        `🤐 Mensaje silenciado (fuera de piloto)\n📞 ${message.from}\n📥 "${message.body.slice(0, 200)}"\n💡 Whitelistear: agregá ${normalizedFrom} a PILOT_WHITELIST_PHONES`,
      );
    } catch { /* notify es best-effort */ }
    return action;
  }

  // ── 8. Rate limiting + loop detection ───────────────────────────────────
  const state = await getConversationState(userId);
  const consecutiveLow = state?.consecutiveLowEngagement ?? 0;

  if (await isLowEngagement(message.body)) {
    const newCount = consecutiveLow + 1;
    await upsertConversationState(userId, { consecutiveLowEngagement: newCount });

    if (newCount >= 4) {
      logger.info({ userId, consecutiveLow: newCount }, "Loop detected — sending close message");
      const closeMsg = await getCommandReply("low_engagement_close") || LOW_ENGAGEMENT_CLOSE_DEFAULT;
      return { type: "default", replyText: closeMsg };
    }

    // 1, 2 o 3 mensajes low-engagement → stay silent
    logger.warn({ userId, from: message.from, body: message.body.slice(0, 80), consecutiveLow: newCount }, "Low-engagement message — silencing");
    return { type: "default", replyText: "" };
  }

  // Good engagement → reset counter
  await upsertConversationState(userId, { consecutiveLowEngagement: 0 });

  // ── 9. Determine user segment ────────────────────────────────────────────
  const segment = await getUserSegment(userId);

  // ── 10. Generate AI reply ────────────────────────────────────────────────
  const aiReply = await generateInboundReply(userId, message.body, segment);

  if (aiReply) {
    action = { ...action, replyText: await wrapLinksWithTracking(aiReply, userId, normalizedFrom) };
  } else {
    logger.warn({ userId }, "AI inbound reply returned null — no reply sent");
  }

  logger.info(
    { userId, type: action.type, from: message.from, hasReply: Boolean(aiReply) },
    "Incoming response processed",
  );

  return action;
}

/**
 * Replace fiacopilot.com links in inbound replies with tracked redirect URLs.
 * Creates a minimal engagement_log entry per link so click tracking works.
 *
 * Trims trailing punctuation (.,!?;) from the matched URL so the redirect doesn't break.
 */
async function wrapLinksWithTracking(text: string, userId: string, phone: string): Promise<string> {
  const escaped = config.engine.appBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // [^\s.,!?;]+ avoids consuming sentence-final punctuation as part of the URL
  const linkRegex = new RegExp(`${escaped}[^\\s]*?[^\\s.,!?;\\)]`, "g");
  const links = text.match(linkRegex);
  if (!links || links.length === 0) return text;

  // Use only the first link to avoid creating excessive log entries per reply
  const link = links[0] as string;
  const { insertEngagementLog } = await import("../db/supabase");
  const logEntry = await insertEngagementLog({
    lead_id: userId,
    status: "sent",
    message: text.slice(0, 2000),
    channel: "whatsapp",
    trigger_type: "inbound_reply",
    metadata: {
      journey_name: "inbound_ai_reply",
      whatsapp_number: phone,
      deep_link: link,
    },
  });
  if (!logEntry?.id) return text;
  const trackedLink = `${await getTrackingLinkBase()}/r/${logEntry.id}`;
  return text.replace(link, trackedLink);
}

// ─── Group messages (Sofía in WhatsApp groups: listen + reply when mentioned) ───

export interface IncomingGroupMessage {
  groupJid: string;       // <id>@g.us
  senderJid: string;      // <phone>@s.whatsapp.net (key.participant)
  text: string;
  mentionedJid?: string[]; // contextInfo.mentionedJid
  messageId?: string;
}

/** Strips accents + lowercases for keyword matching ("Sofía" → "sofia"). */
function normalize(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** True if Sofía was called: a real @mention of her number, or a name keyword in the text. */
function isSofiaMentioned(text: string, mentionedJid?: string[]): boolean {
  const sofiaNum = config.engine.sofiaWhatsappNumber;
  if (sofiaNum && Array.isArray(mentionedJid) &&
      mentionedJid.some((j) => String(j).replace(/\D/g, "").includes(sofiaNum))) {
    return true;
  }
  const norm = normalize(text);
  return config.engine.groupMentionKeywords.some((k) => new RegExp(`\\b${normalize(k)}\\b`).test(norm));
}

// Per-group reply rate limit (in-memory; resets on restart).
const _groupReplyTimestamps = new Map<string, number[]>();
function groupRateLimited(groupJid: string): boolean {
  const hourAgo = Date.now() - 3600_000;
  const arr = (_groupReplyTimestamps.get(groupJid) ?? []).filter((t) => t > hourAgo);
  _groupReplyTimestamps.set(groupJid, arr);
  return arr.length >= config.engine.groupReplyMaxPerHour;
}
function recordGroupReply(groupJid: string): void {
  const arr = _groupReplyTimestamps.get(groupJid) ?? [];
  arr.push(Date.now());
  _groupReplyTimestamps.set(groupJid, arr);
}

// Group roster sync throttle (per process): groupJid → last sync (ms).
const _groupSyncedAt = new Map<string, number>();
const GROUP_SYNC_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Fetches the group's participants from Evolution, classifies each
 * (superadmin = is_admin, coach = is_coach, student = registered non-staff, bot = Sofía,
 * unknown = not in profiles) and persists the FULL roster (sofia_group_members).
 * Returns the unique student's user_id if there is exactly one (else null).
 */
export async function syncGroupMembers(groupJid: string): Promise<string | null> {
  const { evolutionManager } = await import("./whatsappEvolution");
  // Store the group's name (subject) too — best-effort.
  const subject = await evolutionManager.getGroupSubject(groupJid);
  if (subject) await updateSofiaGroupLabel(groupJid, subject);

  const phones = await evolutionManager.getGroupParticipants(groupJid);
  if (phones.length === 0) return null;
  const sofiaNum = config.engine.sofiaWhatsappNumber;
  const members: GroupMember[] = [];
  const students = new Set<string>();
  for (const phone of phones) {
    const isBot = Boolean(sofiaNum && phone.includes(sofiaNum));
    const p = isBot ? null : await findProfileByPhone(phone);
    let role = "unknown";
    if (isBot) role = "bot";
    else if (p?.is_admin) role = "superadmin";
    else if (p?.is_coach) role = "coach";
    else if (p) { role = "student"; students.add(p.id); }
    members.push({
      group_jid: groupJid,
      phone,
      user_id: p?.id ?? null,
      name: p?.name ?? (isBot ? "Sofía" : null),
      role,
      is_registered: Boolean(p),
    });
  }
  await upsertGroupMembers(members);
  _groupSyncedAt.set(groupJid, Date.now());
  return students.size === 1 ? [...students][0]! : null;
}

/**
 * Handle a group message: ALWAYS log it (observe), and reply ONLY when Sofía is mentioned.
 * Reply context = the group's mapped student (if any) else the sender's profile.
 */
export async function processGroupMessage(msg: IncomingGroupMessage): Promise<void> {
  const { groupJid, senderJid, text } = msg;
  const senderPhone = senderJid.replace(/\D/g, "");

  const [group, senderProfile] = await Promise.all([
    getOrCreateSofiaGroup(groupJid),
    findProfileByPhone(senderPhone),
  ]);
  const conversationId = group?.conversation_id;

  // Keep the full roster fresh (~every 6h, and on first contact) and auto-assign the student
  // when there is exactly one registered non-staff member.
  if (group && Date.now() - (_groupSyncedAt.get(groupJid) ?? 0) > GROUP_SYNC_TTL_MS) {
    const studentId = await syncGroupMembers(groupJid);
    if (studentId && !group.student_user_id) {
      await updateSofiaGroupStudent(groupJid, studentId);
      group.student_user_id = studentId;
      logger.info({ groupJid, studentId }, "Group student auto-assigned");
    }
  }
  const senderName = senderProfile?.name ?? `+${senderPhone.slice(-4)}`;

  // Listen: log every group message (even from unregistered senders).
  await logConversation({
    user_id: senderProfile?.id ?? null,
    conversation_id: conversationId,
    direction: "in",
    kind: "group_in",
    body: text,
    metadata: { group_jid: groupJid, sender_phone: senderPhone, sender_name: senderName },
  });

  // Respond only when mentioned.
  if (!isSofiaMentioned(text, msg.mentionedJid)) return;
  if (groupRateLimited(groupJid)) {
    logger.warn({ groupJid }, "Group reply rate-limited — skipping");
    return;
  }

  // Context: the group's mapped student wins; else the sender (if registered).
  const contextUserId = group?.student_user_id ?? senderProfile?.id ?? null;
  const segment = contextUserId ? await getUserSegment(contextUserId) : null;
  const groupHistory = conversationId ? await getGroupHistory(conversationId, 12) : [];

  const reply = await generateGroupReply({ contextUserId, segment, senderName, incomingText: text, groupHistory });
  if (!reply) {
    logger.warn({ groupJid }, "No group reply generated — staying silent");
    return;
  }

  const { evolutionManager } = await import("./whatsappEvolution");
  const result = await evolutionManager.sendMessage(groupJid, reply);
  recordGroupReply(groupJid);

  await logConversation({
    user_id: contextUserId,
    conversation_id: conversationId,
    direction: "out",
    kind: "group_reply",
    body: reply,
    status: result.success ? "sent" : "failed",
    generation_source: "ai",
    error_reason: result.success ? null : (result.error ?? "unknown"),
    metadata: { group_jid: groupJid },
  });

  logger.info({ groupJid, sent: result.success }, "Group reply processed");
}
