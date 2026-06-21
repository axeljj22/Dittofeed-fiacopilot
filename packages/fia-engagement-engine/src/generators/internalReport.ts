/**
 * Generates the internal staff report text from a built context. Tries Codex → Claude for an
 * actionable, well-written report; falls back to a deterministic template so a report ALWAYS
 * goes out. Output is WhatsApp-formatted (single-asterisk bold), in Spanish (Argentina).
 */
import { config } from "../config";
import { logger } from "../logger";
import { generateWithCodex } from "./codexGenerator";
import type { InternalReportContext, StudentSnapshot } from "../detectors/internalReport";

const STATUS_LABEL: Record<StudentSnapshot["status"], string> = {
  inactivo_critico: "🔴 inactivo crítico",
  inactivo: "🟠 inactivo",
  registrado: "⚪ sin arrancar",
  activo: "🟢 activo",
  graduado: "🎓 graduado",
};

/** Compact data block fed to the model (and reused to reason about follow-ups). */
function dataBlock(ctx: InternalReportContext): string {
  const t = ctx.totals;
  const lines: string[] = [];
  lines.push(`PROGRAMA: ${ctx.programLabel}`);
  lines.push(`TOTALES: ${t.students} alumnos | activos ${t.activos} | inactivos ${t.inactivos} | sin arrancar ${t.sinActividad} | graduados ${t.graduados} | con preguntas abiertas ${t.conPreguntasAbiertas}`);
  lines.push("");
  lines.push("ALUMNOS QUE NECESITAN ATENCIÓN:");
  for (const s of ctx.needAttention.slice(0, 25)) {
    const act = s.daysInactive < 0 ? "nunca registró actividad" : `${s.daysInactive}d sin actividad`;
    const grp = s.groupMsgs7d > 0 ? `, ${s.groupMsgs7d} msj en su grupo (semana)${s.groupAudios7d ? ` (${s.groupAudios7d} audios)` : ""}` : "";
    lines.push(`- ${s.name} [${STATUS_LABEL[s.status]}] · ${s.completedTotal} cápsulas (${s.completedThisWeek} esta semana) · ${act}${grp}`);
    for (const q of s.groupQuestions) lines.push(`    · dijo/preguntó: "${q}"`);
  }
  if (ctx.knowledgeGaps.length) {
    lines.push("");
    lines.push("PREGUNTAS QUE SOFÍA NO PUDO RESPONDER (gaps de contenido):");
    for (const g of ctx.knowledgeGaps) lines.push(`- "${g}"`);
  }
  return lines.join("\n");
}

const SYSTEM_PROMPT = `Sos el analista interno de FIA (no le hablás a un alumno, le hablás al equipo: Axel y Lautaro).
Generás un REPORTE SEMANAL de control para revisar el estado de los alumnos y proponer seguimientos.
Reglas:
- Español rioplatense, tono profesional y directo. Formato WhatsApp: *negrita* con un asterisco, emojis ok, sin markdown de títulos (#).
- Estructura: (1) un encabezado corto con la semana en números; (2) "Alumnos a seguir" — por cada uno: nombre, una línea de diagnóstico, y UNA propuesta de seguimiento concreta marcada [Manual] (la hace el coach) o [🤖 Sofía puede] (la puede ejecutar Sofía, ej. recordatorio/responder duda); (3) si hay, "Gaps de contenido" (qué cargar a la base).
- Sé conciso y accionable. No inventes datos: usá SOLO lo que está en el bloque de datos. Si un dato no está, no lo menciones.
- No saludes como si fuera un alumno. Es un reporte interno.
- Cerrá recordando que para ejecutar algo, te lo pidan por este grupo y vos proponés el plan para aprobar.`;

function buildFallback(ctx: InternalReportContext): string {
  const t = ctx.totals;
  const out: string[] = [];
  out.push(`📊 *Reporte semanal — control interno*`);
  out.push(`Programa: ${ctx.programLabel}`);
  out.push(`${t.students} alumnos · 🟢 ${t.activos} activos · 🟠🔴 ${t.inactivos} inactivos · ⚪ ${t.sinActividad} sin arrancar · 🎓 ${t.graduados} graduados`);
  out.push("");
  out.push(`*Alumnos a seguir (${Math.min(ctx.needAttention.length, 15)})*`);
  for (const s of ctx.needAttention.slice(0, 15)) {
    const act = s.daysInactive < 0 ? "nunca registró actividad" : `${s.daysInactive}d sin actividad`;
    const sug = (s.status === "inactivo_critico" || s.status === "inactivo" || s.status === "registrado")
      ? "[🤖 Sofía puede] mandar un recordatorio para retomar."
      : "[Manual] revisar su avance y dar feedback.";
    out.push(`• *${s.name}* — ${STATUS_LABEL[s.status]}, ${s.completedTotal} cápsulas, ${act}. ${sug}`);
  }
  if (ctx.knowledgeGaps.length) {
    out.push("");
    out.push(`*Gaps de contenido* (cargar a la base):`);
    for (const g of ctx.knowledgeGaps.slice(0, 8)) out.push(`• "${g}"`);
  }
  out.push("");
  out.push(`_Para ejecutar un seguimiento, pídanmelo por acá y les propongo el plan para aprobar._`);
  return out.join("\n");
}

export async function generateInternalReport(ctx: InternalReportContext): Promise<string> {
  if (ctx.totals.students === 0) {
    return `📊 *Reporte semanal — control interno*\nNo encontré alumnos activos en ${ctx.programLabel} esta semana.`;
  }
  const userMessage = `${dataBlock(ctx)}\n\nGenerá el reporte semanal interno con esos datos.`;

  // 1) Codex
  try {
    const codex = await generateWithCodex(SYSTEM_PROMPT, userMessage);
    if (codex && codex.trim().length > 40) return codex.trim();
  } catch (error) {
    logger.warn({ error: (error as Error).message }, "internal report: Codex failed");
  }
  // 2) Claude
  if (config.anthropic.apiKey) {
    try {
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const client = new Anthropic({ apiKey: config.anthropic.apiKey });
      const resp = await client.messages.create({
        model: config.anthropic.model,
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      });
      const tb = resp.content.find((b) => b.type === "text");
      if (tb && tb.type === "text" && tb.text.trim().length > 40) return tb.text.trim();
    } catch (error) {
      logger.warn({ error: (error as Error).message }, "internal report: Claude failed");
    }
  }
  // 3) Deterministic fallback
  return buildFallback(ctx);
}
