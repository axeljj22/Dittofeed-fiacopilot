/**
 * Control-group action loop (Phase 2). In the internal control group, a staff member asks Sofía
 * to do something ("mandá un recordatorio a los inactivos") → Sofía interprets it, resolves the
 * concrete recipients + a draft message, and posts a PLAN. Nothing is sent until a SUPERADMIN
 * replies "aprobado". Refinements re-propose; approval executes via the normal sender.
 */
import { config } from "../config";
import { logger } from "../logger";
import { generateWithCodex } from "../generators/codexGenerator";
import { evolutionManager } from "../senders/whatsappEvolution";
import {
  getProfilesForUsers,
  createPendingAction,
  getLatestPendingAction,
  updatePendingAction,
  logConversation,
  type PendingAction,
} from "../db/supabase";
import { buildInternalReportContext } from "../detectors/internalReport";

function norm(s: string): string {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}
function isApproval(text: string): boolean {
  return /\b(aprobado|aprobada|aprobar|dale|ok dale|ejecuta(lo|r)?|hacelo|mandalo|envialo|aprobad[oa] ?\W*)\b/.test(norm(text));
}
function isChangeRequest(text: string): boolean {
  return /\b(cambia|cambi[aá]|en vez|mejor|modific|ajust|no,|en lugar|sac[aá]|agreg)/.test(norm(text));
}

interface Interpreted { audience: string; studentName: string | null; message: string }

async function interpretCommand(text: string, pending: PendingAction | null): Promise<Interpreted | null> {
  const ctxLine = pending
    ? `\nHay una propuesta previa (audiencia=${pending.audience}, mensaje="${(pending.draft_message ?? "").slice(0, 300)}"). El equipo pide AJUSTARLA con el texto de abajo.`
    : "";
  const system = `Sos el asistente de operaciones de FIA. El equipo (Axel/Lautaro) te da una instrucción para contactar alumnos por WhatsApp.${ctxLine}
Devolvé EXCLUSIVAMENTE un JSON válido, sin texto extra ni \`\`\`, con esta forma:
{"audience":"inactivos|sin_arrancar|activos|todos|alumno","studentName": string|null, "message": string}
- audience: a quién apunta. "alumno" si menciona a una persona puntual (poné su nombre en studentName).
- message: el texto EXACTO que Sofía le enviaría al alumno (en su voz: cálida, breve, español rioplatense, 1ª persona, sin saludo genérico largo). Si el equipo dictó el mensaje, respetalo.`;
  let raw = await generateWithCodex(system, text).catch(() => null);
  if (!raw && config.anthropic.apiKey) {
    try {
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const client = new Anthropic({ apiKey: config.anthropic.apiKey });
      const resp = await client.messages.create({ model: config.anthropic.model, max_tokens: 600, system, messages: [{ role: "user", content: text }] });
      const tb = resp.content.find((b) => b.type === "text");
      if (tb && tb.type === "text") raw = tb.text;
    } catch (e) { logger.warn({ error: (e as Error).message }, "interpretCommand Claude failed"); }
  }
  if (!raw) return null;
  try {
    const json = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(json) as Interpreted;
    if (!parsed.audience || !parsed.message) return null;
    return parsed;
  } catch { return null; }
}

interface Recipient { userId: string; name: string; phone: string }

async function resolveRecipients(a: Interpreted, programSlug: string): Promise<{ recipients: Recipient[]; skipped: number }> {
  const ctx = await buildInternalReportContext([programSlug]);
  let pool = ctx.all;
  if (a.audience === "inactivos") pool = pool.filter((s) => s.status === "inactivo" || s.status === "inactivo_critico");
  else if (a.audience === "sin_arrancar") pool = pool.filter((s) => s.status === "registrado");
  else if (a.audience === "activos") pool = pool.filter((s) => s.status === "activo");
  else if (a.audience === "alumno" && a.studentName) {
    const n = norm(a.studentName);
    pool = pool.filter((s) => norm(s.name).includes(n) || n.includes(norm(s.name)));
  }
  // audience "todos" → keep all
  const profiles = await getProfilesForUsers(pool.map((s) => s.userId));
  const recipients: Recipient[] = [];
  let skipped = 0;
  for (const s of pool) {
    const p = profiles.get(s.userId);
    const phone = (p?.phone || "").replace(/\D/g, "");
    if (!phone || p?.whatsapp_opt_in === false) { skipped++; continue; }
    recipients.push({ userId: s.userId, name: s.name, phone });
  }
  return { recipients, skipped };
}

function planMessage(a: Interpreted, recipients: Recipient[], skipped: number): string {
  const names = recipients.slice(0, 30).map((r) => r.name).join(", ");
  return [
    `📋 *Propuesta de seguimiento*`,
    `Audiencia: *${a.audience}*${a.studentName ? ` (${a.studentName})` : ""} → *${recipients.length}* alumno(s)${skipped ? ` (${skipped} omitidos: sin WhatsApp / baja)` : ""}`,
    ``,
    `Mensaje a enviar:`,
    `"${a.message}"`,
    ``,
    recipients.length ? `Destinatarios: ${names}${recipients.length > 30 ? "…" : ""}` : `⚠️ No encontré destinatarios para esa audiencia.`,
    ``,
    recipients.length ? `Respondé *aprobado* para enviar, o decime qué cambiar.` : `Reformulá la audiencia y lo vuelvo a proponer.`,
  ].join("\n");
}

async function executeAction(action: PendingAction, groupJid: string): Promise<string> {
  const ids = (action.target_user_ids ?? []) as string[];
  const profiles = await getProfilesForUsers(ids);
  let sent = 0, failed = 0;
  for (const id of ids) {
    const p = profiles.get(id);
    const phone = (p?.phone || "").replace(/\D/g, "");
    if (!phone || p?.whatsapp_opt_in === false) { failed++; continue; }
    const res = await evolutionManager.sendMessage(phone, action.draft_message ?? "");
    if (res.success) {
      sent++;
      await logConversation({ user_id: id, direction: "out", kind: "staff_broadcast", body: action.draft_message ?? "", status: "sent", metadata: { via: "control_group", audience: action.audience } });
    } else { failed++; }
  }
  await updatePendingAction(action.id, { status: "executed", result: { sent, failed } });
  logger.info({ groupJid, sent, failed }, "Control action executed");
  return `✅ Enviado a *${sent}* alumno(s)${failed ? ` · ${failed} no se pudieron enviar` : ""}.`;
}

/**
 * Entry point for messages in the control group. Returns a reply to post, or null to stay silent.
 * Only staff (superadmin/coach) drive it; only superadmin can approve execution.
 */
export async function handleControlMessage(opts: {
  groupJid: string;
  text: string;
  senderRole: string | null;
  mentioned: boolean;
}): Promise<string | null> {
  const { groupJid, text, senderRole, mentioned } = opts;
  if (senderRole !== "superadmin" && senderRole !== "coach") return null; // ignore non-staff

  const pending = await getLatestPendingAction(groupJid);

  // Approval (no tag needed; reply to her proposal)
  if (pending && isApproval(text)) {
    if (senderRole !== "superadmin") return "Solo un superadmin puede aprobar el envío.";
    return executeAction(pending, groupJid);
  }

  // New command or refinement: needs to be directed at Sofía (tagged/named) or a change to a pending plan
  if (!mentioned && !(pending && isChangeRequest(text))) return null;

  const programSlug = (pending?.program_slug) || "fia-agentica";
  const interp = await interpretCommand(text, pending ?? null);
  if (!interp) return "No te entendí bien. Decime a quién contactar (ej. \"inactivos de Agéntica\") y qué mensaje mandar.";

  const { recipients, skipped } = await resolveRecipients(interp, programSlug);
  await createPendingAction({
    group_jid: groupJid,
    action_type: "broadcast",
    audience: interp.audience,
    program_slug: programSlug,
    target_user_ids: recipients.map((r) => r.userId),
    draft_message: interp.message,
    created_by: senderRole,
  });
  return planMessage(interp, recipients, skipped);
}
