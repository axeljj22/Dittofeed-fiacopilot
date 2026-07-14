/**
 * Write tools (Sofía 2.0, Phase 4). Kept intentionally low-risk:
 *  - schedule_reminder: inserts a one-shot reminder for the SAME user (self-messaging, opt-out honored
 *    by the scheduler). The tool description tells the model to confirm with the user first.
 *  - escalate_to_human: notifies the team so a HUMAN follows up (leads, unresolved issues). This is the
 *    safe path for "cargar un lead": Sofía escalates instead of creating CRM/auth records herself.
 *
 * create_crm_lead is deliberately NOT implemented as an auto-executing tool: upsertCampaignLead()
 * creates Supabase auth users + profiles, which must not be triggered unattended by an LLM.
 */
import { insertReminder, getProfileWithWhatsapp } from "../../db/supabase";
import { buildReminderRequest } from "../reminderTime";
import { logger } from "../../logger";
import type { ToolDef } from "../types";

export const scheduleReminderTool: ToolDef = {
  key: "schedule_reminder",
  description:
    "Programá un recordatorio por WhatsApp para el alumno dentro de N horas. Confirmá con el alumno ANTES de agendarlo (qué le recuerdo y cuándo).",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "El texto del recordatorio a enviarle" },
      delay_hours: { type: "number", description: "En cuántas horas enviarlo (entre 1 y 720)" },
    },
    required: ["message", "delay_hours"],
  } as unknown as Record<string, unknown>,
  mode: "write",
  approval: "user_confirm",
  handler: async (ctx, args) => {
    const req = buildReminderRequest(args as { message?: unknown; delay_hours?: unknown }, Date.now());
    if ("error" in req) return req.error;
    const ok = await insertReminder(ctx.userId, req.message, req.dueAtIso, "sofia_tool");
    return ok
      ? `Listo, te lo recuerdo por acá cuando llegue el momento.`
      : "No pude agendar el recordatorio ahora, probá más tarde.";
  },
};

export const escalateToHumanTool: ToolDef = {
  key: "escalate_to_human",
  description:
    "Avisá al equipo humano de FIA para que le hagan seguimiento al alumno/lead (ej. interesado en un programa, problema que no podés resolver, alguien que necesita atención personal). Usá esto en vez de prometer que 'alguien lo va a contactar'.",
  parameters: {
    type: "object",
    properties: { reason: { type: "string", description: "Por qué escalás y qué necesita la persona" } },
    required: ["reason"],
  } as unknown as Record<string, unknown>,
  mode: "write",
  approval: "none",
  handler: async (ctx, args) => {
    const reason = String((args as { reason?: unknown }).reason ?? "").trim().slice(0, 500);
    try {
      const profile = await getProfileWithWhatsapp(ctx.userId);
      const { evolutionManager } = await import("../../senders/whatsappEvolution");
      await evolutionManager.notifyAdmin(
        `🙋 Escalación de Sofía\nPersona: ${profile?.name ?? ctx.userId}${profile?.phone ? ` (${profile.phone})` : ""}\nMotivo: ${reason}`,
      );
      return "Listo, ya avisé al equipo para que se pongan en contacto con vos. En breve alguien te escribe.";
    } catch (error) {
      logger.warn({ error: (error as Error).message }, "escalate_to_human notify failed");
      return "Tomo nota y le paso el dato al equipo.";
    }
  },
};
