/**
 * Generador de mensajes — Templates fijos + Claude API (opcional)
 *
 * Modo template: mensajes predefinidos con variables del usuario.
 * Modo IA: Claude API genera mensajes personalizados con contexto de Bóveda.
 *
 * Si ANTHROPIC_API_KEY no está configurada, usa templates.
 */
import { config } from "../config";
import { logger } from "../logger";
import {
  getProfileWithWhatsapp,
  getVaultOutputsForUser,
  getCapsuleProgressForUser,
  getCapsules,
  getLeadScoreForUser,
  getAssessmentForUser,
  getConversationHistory,
  appendConversationMessages,
} from "../db/supabase";
import type { EngagementOpportunity, VaultOutput, CapsuleProgress, LeadScore, AssessmentSubmission } from "../db/types";
import { generateWithCodex, generateWithCodexConversation } from "./codexGenerator";

export interface GeneratedMessage {
  text: string;
  journeyName: string;
  deepLink: string;
}

// ─── Template-based messages (no API key needed) ───

interface TemplateContext {
  nombre: string;
  empresa: string;
  objetivo: string;
  capsulaPendiente: number;
  capsulaTitle: string | null;  // capsule title from DB join
  capsulasTotales: number;
  deepLink: string;
  fitScore: number;
  intentScore: number;
  overallScore: number;
  daysInactive: number;
  level: number;
  painAreas: string[];          // from assessment_submissions
  companySize: "emprendedor" | "empresa" | null; // derived from answers.m_size
}

const TEMPLATES: Record<string, (ctx: TemplateContext) => string> = {
  reactivacion_inactividad_1: (ctx) => {
    const capsulaNombre = ctx.capsulaTitle ? `${ctx.capsulaPendiente}: ${ctx.capsulaTitle}` : `${ctx.capsulaPendiente}`;
    return `Hola ${ctx.nombre}! Soy Sofía de FIA Copilot. ` +
      `Tenés la cápsula ${capsulaNombre} esperándote. ` +
      `Cuando puedas: ${ctx.deepLink}`;
  },

  reactivacion_inactividad_2: (ctx) => {
    const capsulaNombre = ctx.capsulaTitle ? `${ctx.capsulaPendiente}: ${ctx.capsulaTitle}` : `${ctx.capsulaPendiente}`;
    const empresaCtx = ctx.empresa !== "tu empresa" ? ` en ${ctx.empresa}` : "";
    return `${ctx.nombre}, hace ${ctx.daysInactive} días que no entrás. ` +
      `La cápsula ${capsulaNombre} está justo donde la dejaste${empresaCtx}. ` +
      `Retomá cuando quieras: ${ctx.deepLink}`;
  },

  reactivacion_inactividad_3: (ctx) =>
    `${ctx.nombre}, te escribo por última vez sobre esto. ` +
    `Si querés retomar el programa, respondé SI y te ayudo. ` +
    `O entrá directo: ${ctx.deepLink}`,

  celebracion_capsula: (ctx) =>
    `Muy bien ${ctx.nombre}! Completaste la cápsula ${ctx.capsulaPendiente - 1}. ` +
    `Ya vas ${ctx.capsulasTotales}/25. La próxima te espera: ${ctx.deepLink}`,

  celebracion_capsula_final: (ctx) =>
    `${ctx.nombre}, completaste las 25 cápsulas del Método FIA. ` +
    `Todo lo que construiste está en tu Bóveda: ${ctx.deepLink}`,

  bienvenida_diagnostico: (ctx) => {
    const painCtx = ctx.painAreas.length > 0
      ? ` Detectamos oportunidades en ${ctx.painAreas.slice(0, 2).join(" y ")}.`
      : "";
    const capsulaNombre = ctx.capsulaTitle ? `${ctx.capsulaPendiente}: ${ctx.capsulaTitle}` : `${ctx.capsulaPendiente}`;
    return `Hola ${ctx.nombre}, soy Sofía, tu Coach de FIA Copilot. ` +
      `Tu diagnóstico está listo — score ${ctx.overallScore}/100.${painCtx} ` +
      `Te recomiendo empezar por la cápsula ${capsulaNombre}: ${ctx.deepLink}\n\n` +
      `Vas a recibir mensajes míos de seguimiento. Respondé STOP en cualquier momento para cancelarlos.`;
  },

  recuperacion_lead_frio: (ctx) => {
    if (ctx.companySize === "emprendedor") {
      return `${ctx.nombre}, tu diagnóstico FIA marcó ${ctx.overallScore}/100. ` +
        `Tenés herramientas de IA que podés aplicar vos solo, paso a paso. Mirá el plan: ${ctx.deepLink}`;
    }
    return `${ctx.nombre}, tu diagnóstico FIA marcó ${ctx.overallScore}/100 para ${ctx.empresa}. ` +
      `Hay pasos concretos para mejorar eso. Mirá el plan: ${ctx.deepLink}`;
  },

  resumen_semanal_sponsor: (ctx) =>
    `Hola! Acá el resumen de esta semana de ${ctx.empresa}. ` +
    `Revisá quién avanzó y quién necesita un empujón: ${ctx.deepLink}`,

  campana_activa: (ctx) => {
    const capsulaNombre = ctx.capsulaTitle
      ? `${ctx.capsulaPendiente}: ${ctx.capsulaTitle}`
      : `${ctx.capsulaPendiente}`;
    return `${ctx.nombre}, tenés acceso especial a FIA Copilot. ` +
      `Tu próxima cápsula es la ${capsulaNombre}. ` +
      `Entrá cuando quieras: ${ctx.deepLink}`;
  },
};

function getTemplateKey(opportunity: EngagementOpportunity): string {
  const { journeyName, level, context } = opportunity;

  if (journeyName === "reactivacion_inactividad") {
    return `reactivacion_inactividad_${level ?? 1}`;
  }

  if (journeyName === "celebracion_capsula") {
    return (context as { isLastCapsule?: boolean }).isLastCapsule
      ? "celebracion_capsula_final"
      : "celebracion_capsula";
  }

  return journeyName;
}

// ─── Shared context builder ───

/** Maps assessment answers.m_size to a simplified segment label. */
function resolveCompanySize(assessment: AssessmentSubmission | null): "emprendedor" | "empresa" | null {
  const mSize = assessment?.answers?.["m_size"] as string | undefined;
  if (!mSize) return null;
  if (mSize === "Solo" || mSize === "2-5") return "emprendedor";
  return "empresa";
}

function buildVaultContext(outputs: VaultOutput[]): string {
  if (outputs.length === 0) return "Sin outputs guardados en la Bóveda aún.";

  const sections: string[] = [];

  const businessContext = outputs
    .filter((o) => o.content_type === "context_business")
    .map((o) => o.content)
    .slice(0, 3);

  if (businessContext.length > 0) {
    sections.push(`Contexto de negocio:\n${businessContext.join("\n")}`);
  }

  const recentOutputs = outputs.slice(0, 5).map(
    (o) => `- (${o.content_type}): ${o.content.slice(0, 200)}`,
  );

  sections.push(`Outputs recientes:\n${recentOutputs.join("\n")}`);

  return sections.join("\n\n");
}

function buildUserContext(
  opportunity: EngagementOpportunity,
  vaultOutputs: VaultOutput[],
  capsuleProgress: CapsuleProgress[],
  scores: LeadScore | null,
  assessment: AssessmentSubmission | null,
): string {
  const vaultContext = buildVaultContext(vaultOutputs);
  const completedCount = capsuleProgress.filter((p) => p.status === "completed").length;
  const painAreas = (opportunity.context.painAreas as string[] | undefined) ?? assessment?.pain_areas ?? [];
  const companySize = resolveCompanySize(assessment);

  return `
PERFIL DEL USUARIO:
- Nombre: ${opportunity.profile.name}
- Empresa: ${opportunity.profile.company_name}
- Industria: ${opportunity.profile.industry}
- Objetivo: ${opportunity.profile.objective}
- Temperatura: ${opportunity.profile.temperature}
- Tamaño de empresa: ${companySize ?? "desconocido"}
- Cápsulas completadas: ${completedCount}/25

SCORES:
- Fit Score: ${scores?.fit_score ?? "N/A"}
- Intent Score: ${scores?.intent_score ?? "N/A"}
- Overall: ${scores?.overall_score ?? "N/A"}

DIAGNÓSTICO:
- Áreas de dolor: ${painAreas.length > 0 ? painAreas.join(", ") : "no disponible"}

BÓVEDA:
${vaultContext}

DATOS DEL JOURNEY:
- Journey: ${opportunity.journeyName}
- Nivel: ${opportunity.level ?? "N/A"}
- Deep link a incluir: ${opportunity.deepLink}
- Contexto adicional: ${JSON.stringify(opportunity.context)}
`.trim();
}

// ─── AI generation (Codex + Claude) ───

const SOFIA_SYSTEM_PROMPT = `Sos Sofía, la Coach de FIA Copilot.

QUIÉN SOS:
- 24 años, argentina, vivís en Olivos (zona norte de Buenos Aires)
- Estudiás administración de empresas y te apasiona la IA aplicada a negocios reales
- Trabajás en FIA Copilot hace más de un año acompañando a dueños de PyMEs y equipos en su implementación de IA

SOBRE FIA COPILOT:
- Plataforma de 25 cápsulas para implementar IA en PyMEs latinoamericanas
- Cada cápsula tiene una mini-acción práctica y un entregable concreto para el negocio
- La Bóveda guarda todo lo que el usuario construyó (prompts, procesos, análisis, ideas)
- El Diagnóstico mide el nivel de madurez de IA de la empresa (score 0-100)
- Hay comunidad de empresarios y eventos periódicos
- El programa está pensado para implementar, no solo aprender — cada cápsula genera algo concreto

TU PERSONALIDAD:
- Cálida y cercana, como una amiga que sabe del tema
- No exagerada — no escribís "¡¡Genial!!" ni abusás de los signos de exclamación
- Tuteo natural latinoamericano, nunca "usted"
- Mensajes cortos — 1-3 oraciones como una persona real por WhatsApp
- Emojis solo cuando son genuinos, máximo uno por mensaje
- Texto plano — sin markdown, asteriscos ni listas con guiones
- No te presentás en cada mensaje — ya te conocen
- Cuando hay historial de conversación, lo usás naturalmente sin forzarlo

LO QUE PODÉS HACER:
- Conversar sobre el programa y el progreso del usuario
- Hablar del contenido de las cápsulas y qué construyeron en la Bóveda
- Motivar a retomar o continuar sin ser pesada
- Responder preguntas sobre la plataforma, la Bóveda, el diagnóstico, la comunidad
- Escuchar cuando el usuario quiere hablar de su negocio

LO QUE NUNCA HACÉS:
- Hablar de precios, planes o pagos — decís "eso lo maneja el equipo"
- Dar consejos legales, contables, médicos o financieros
- Prometer resultados o garantías
- Inventar información sobre el usuario, su empresa o el programa
- Mandar listas con viñetas — siempre texto corrido

FORMATO:
- Máximo 300 caracteres por mensaje
- Solo el texto del mensaje, sin prefijos ni comillas
- Si tenés un link relevante, lo incluís de forma natural al final`;

// Alias para compatibilidad con generateMessage() outbound
const SYSTEM_PROMPT = SOFIA_SYSTEM_PROMPT;



const JOURNEY_PROMPTS: Record<string, string> = {
  reactivacion_inactividad: `El usuario lleva días sin entrar a FIA Copilot. Escribile como Sofía.
Nivel 1 (5 días): un recordatorio suave, sin presionar. Mencioná la cápsula pendiente por nombre si lo tenés.
Nivel 2 (10 días): algo más directo. Mencioná el nombre de la empresa y la cápsula pendiente. Si tenés datos de la Bóveda, usá uno concreto.
Nivel 3 (20 días): última vez que le escribís por esto. Invitalo a responder "SI" si quiere retomar.
No te presentés — ya te conoce de mensajes anteriores.`,

  celebracion_capsula: `El usuario acaba de completar una cápsula del Método FIA. Felicitalo como Sofía.
Sé genuina — es un logro real. Presentá la siguiente cápsula como el paso natural.
Si completó las 25 cápsulas, es una graduación — celebralo con más énfasis y mencioná la Bóveda.
No te presentés — ya te conoce.`,

  bienvenida_diagnostico: `Es el primer contacto con este usuario. Acaba de completar su diagnóstico FIA.
Presentate como Sofía, Coach de FIA Copilot — una sola vez, al inicio del mensaje. Breve.
Mencioná el score y, si hay áreas de dolor disponibles en el diagnóstico, nombrá una o dos de forma concreta y humana — no solo el número.
Invitalo a empezar por la cápsula recomendada con su nombre y el deep link.
Al final del mensaje, en una línea separada, incluí siempre este aviso exacto: "Vas a recibir mensajes míos de seguimiento. Respondé STOP en cualquier momento para cancelarlos."`,

  recuperacion_lead_frio: `El usuario hizo el diagnóstico pero nunca empezó el programa. Escribile como Sofía.
Un solo intento. Recordale su score y qué oportunidades concretas puede aprovechar según el tamaño de su empresa.
Si es emprendedor (solo o 2-5 personas): enfocate en lo que puede implementar él mismo, rápido.
Si es empresa (6+): mencioná el impacto en el equipo y en procesos.
CTA a empezar — directo pero sin presionar. No te presentés si ya hubo contacto anterior.`,

  resumen_semanal_sponsor: `Es el reporte semanal para el sponsor del equipo. Escribilo como Sofía.
Mencioná quién avanzó, si alguien está bloqueado y una sugerencia accionable.
Tono ejecutivo pero cálido — el sponsor necesita visibilidad rápida, no un ensayo.`,

  campana_activa: `El usuario tiene acceso especial desbloqueado a FIA Copilot pero lleva días sin entrar. Escribile como Sofía.
Recordale que tiene acceso especial — sin ser presionador. Mencioná la próxima cápsula por nombre si la tenés.
Mensaje corto y directo. No te presentés — ya te conoce.`,
};

async function generateWithClaude(
  opportunity: EngagementOpportunity,
  userContext: string,
  journeyPrompt: string,
): Promise<GeneratedMessage | null> {
  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: config.anthropic.apiKey });

    const response = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `${journeyPrompt}\n\n${userContext}\n\nGenera SOLO el texto del mensaje de WhatsApp, sin explicaciones ni prefijos.`,
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      logger.error({ userId: opportunity.userId }, "No text in Claude response");
      return null;
    }

    return {
      text: textBlock.text.trim(),
      journeyName: opportunity.journeyName,
      deepLink: opportunity.deepLink,
    };
  } catch (error) {
    logger.error(
      { error, userId: opportunity.userId },
      "Claude generation failed — falling back to template",
    );
    return null;
  }
}

function generateFromTemplate(
  opportunity: EngagementOpportunity,
  capsuleProgress: CapsuleProgress[],
  scores: LeadScore | null,
  assessment: AssessmentSubmission | null,
): GeneratedMessage | null {
  const completedCount = capsuleProgress.filter((p) => p.status === "completed").length;
  const ctx_opportunity = opportunity.context as {
    pendingCapsuleNumber?: number;
    nextCapsuleNumber?: number;
    recommendedCapsule?: number;
    daysSinceLastEvent?: number;
    painAreas?: string[];
    nextCapsuleTitle?: string | null;
  };

  const capsulaPendiente =
    ctx_opportunity.pendingCapsuleNumber ??
    ctx_opportunity.nextCapsuleNumber ??
    ctx_opportunity.recommendedCapsule ??
    1;

  // Find capsule title: prefer context-provided title, fallback to progress array lookup
  const capsuleEntry = capsuleProgress.find((p) => p.capsule_number === capsulaPendiente);

  const ctx: TemplateContext = {
    nombre: opportunity.profile.name || "ahí",
    empresa: opportunity.profile.company_name || "tu empresa",
    objetivo: opportunity.profile.objective || "",
    capsulaPendiente,
    capsulaTitle: ctx_opportunity.nextCapsuleTitle ?? capsuleEntry?.capsule_title ?? null,
    capsulasTotales: completedCount,
    deepLink: opportunity.deepLink,
    fitScore: scores?.fit_score ?? 0,
    intentScore: scores?.intent_score ?? 0,
    overallScore: scores?.overall_score ?? 0,
    daysInactive: ctx_opportunity.daysSinceLastEvent ?? 0,
    level: opportunity.level ?? 1,
    painAreas: ctx_opportunity.painAreas ?? assessment?.pain_areas ?? [],
    companySize: resolveCompanySize(assessment),
  };

  const templateKey = getTemplateKey(opportunity);
  const templateFn = TEMPLATES[templateKey];
  if (!templateFn) {
    logger.warn(
      { templateKey, journey: opportunity.journeyName },
      "Template not found — message generation skipped",
    );
    return null;
  }

  return {
    text: templateFn(ctx),
    journeyName: opportunity.journeyName,
    deepLink: opportunity.deepLink,
  };
}

// ─── Message length enforcement ───

const MAX_MESSAGE_CHARS = 300;

/**
 * Enforces the 300-char limit.
 * If the message exceeds it, truncates the body but preserves the deep link at the end.
 */
function enforceLength(text: string, deepLink: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;

  // If deep link is at the end, keep it — truncate the body before it
  const linkIndex = text.lastIndexOf(deepLink);
  if (linkIndex !== -1 && linkIndex + deepLink.length === text.length) {
    const bodyBudget = MAX_MESSAGE_CHARS - deepLink.length - 1; // 1 for space/separator
    const truncatedBody = text.slice(0, linkIndex).trimEnd().slice(0, bodyBudget);
    return `${truncatedBody} ${deepLink}`;
  }

  // No link at end — truncate with ellipsis
  return text.slice(0, MAX_MESSAGE_CHARS - 1).trimEnd() + "…";
}

// ─── Public API ───

const useClaudeAI =
  config.anthropic.apiKey !== "placeholder" &&
  config.anthropic.apiKey !== "";

/**
 * Genera una respuesta AI a un mensaje libre entrante de WhatsApp.
 * Intenta Codex (ChatGPT Plus) primero, luego Claude como fallback.
 * Guarda el intercambio en wa_conversation_history para memoria de conversación.
 * Retorna null si ambos fallan (el caller usa el texto fijo).
 */
export async function generateInboundReply(
  userId: string,
  incomingText: string,
): Promise<string | null> {
  try {
    // Load all context in parallel
    const [history, profile, vaultOutputs, capsuleProgress, capsules, scores, assessment] =
      await Promise.all([
        getConversationHistory(userId, 10),
        getProfileWithWhatsapp(userId),
        getVaultOutputsForUser(userId),
        getCapsuleProgressForUser(userId),
        getCapsules(),
        getLeadScoreForUser(userId),
        getAssessmentForUser(userId),
      ]);

    // Save user message to history immediately
    await appendConversationMessages(userId, [{ role: "user", content: incomingText }]);

    const completedCount = capsuleProgress.filter((p) => p.status === "completed").length;
    const completedCapsules = capsuleProgress
      .filter((p) => p.status === "completed")
      .map((p) => `Cápsula ${p.capsule_number}${p.capsule_title ? `: ${p.capsule_title}` : ""}`)
      .join(", ");

    const inProgressCapsule = capsuleProgress.find((p) => p.status === "in_progress");
    const inProgressTitle = inProgressCapsule
      ? capsules.find((c) => c.id === inProgressCapsule.capsule_id)?.title ?? null
      : null;

    const vaultContext = buildVaultContext(vaultOutputs);
    const painAreas = assessment?.pain_areas ?? [];
    const companySize = resolveCompanySize(assessment);

    const userContext = `
PERFIL DEL USUARIO:
- Nombre: ${profile?.name ?? "desconocido"}
- Empresa: ${profile?.company_name ?? "desconocida"}
- Industria: ${profile?.industry ?? "desconocida"}
- Objetivo: ${profile?.objective ?? "no disponible"}
- Temperatura: ${profile?.temperature ?? "desconocida"}
- Tamaño de empresa: ${companySize ?? "desconocido"}
- Cápsulas completadas: ${completedCount}/25${completedCapsules ? `\n- Completadas: ${completedCapsules}` : ""}${inProgressCapsule ? `\n- En progreso: Cápsula ${inProgressCapsule.capsule_number}${inProgressTitle ? `: ${inProgressTitle}` : ""}` : ""}

SCORES:
- Fit Score: ${scores?.fit_score ?? "N/A"}
- Intent Score: ${scores?.intent_score ?? "N/A"}
- Overall: ${scores?.overall_score ?? "N/A"}

DIAGNÓSTICO:
- Áreas de dolor: ${painAreas.length > 0 ? painAreas.join(", ") : "no disponible"}

BÓVEDA:
${vaultContext}`.trim();

    const fullUserMessage = `${userContext}\n\nMensaje del usuario: ${incomingText}\n\nRespondé SOLO con el texto del mensaje, sin prefijos ni comillas.`;

    let reply: string | null = null;

    // 1. Try Codex with conversation history
    reply = await generateWithCodexConversation(
      SOFIA_SYSTEM_PROMPT,
      history as Array<{ role: "user" | "assistant"; content: string }>,
      fullUserMessage,
    );

    // 2. Fallback to Claude with conversation history
    if (!reply && useClaudeAI) {
      try {
        const Anthropic = (await import("@anthropic-ai/sdk")).default;
        const client = new Anthropic({ apiKey: config.anthropic.apiKey });

        const claudeHistory = history.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));

        const response = await client.messages.create({
          model: config.anthropic.model,
          max_tokens: 150,
          system: SOFIA_SYSTEM_PROMPT,
          messages: [
            ...claudeHistory,
            { role: "user", content: fullUserMessage },
          ],
        });

        const textBlock = response.content.find((b) => b.type === "text");
        if (textBlock && textBlock.type === "text") {
          reply = textBlock.text.trim();
        }
      } catch (error) {
        logger.error({ error, userId }, "Claude inbound fallback failed");
      }
    }

    if (!reply) return null;

    // Enforce max length
    const finalReply = reply.length <= MAX_MESSAGE_CHARS
      ? reply
      : reply.slice(0, MAX_MESSAGE_CHARS - 1).trimEnd() + "…";

    // Save Sofía's reply to history
    await appendConversationMessages(userId, [{ role: "assistant", content: finalReply }]);

    logger.info({ userId, historyLength: history.length }, "Inbound AI reply generated");
    return finalReply;
  } catch (error) {
    logger.error({ error, userId }, "generateInboundReply failed");
    return null;
  }
}

export async function generateMessage(
  opportunity: EngagementOpportunity,
): Promise<GeneratedMessage | null> {
  // Fetch all user data once — shared across all generation paths
  const [vaultOutputs, capsuleProgress, scores, assessment] = await Promise.all([
    getVaultOutputsForUser(opportunity.userId),
    getCapsuleProgressForUser(opportunity.userId),
    getLeadScoreForUser(opportunity.userId),
    getAssessmentForUser(opportunity.userId),
  ]);

  const userContext = buildUserContext(opportunity, vaultOutputs, capsuleProgress, scores, assessment);
  const journeyPrompt =
    JOURNEY_PROMPTS[opportunity.journeyName] ?? "Genera un mensaje de seguimiento personalizado.";

  // 1. Try Codex OAuth (ChatGPT Plus) first
  const codexText = await generateWithCodex(
    SYSTEM_PROMPT,
    `${journeyPrompt}\n\n${userContext}\n\nGenera SOLO el texto del mensaje de WhatsApp, sin explicaciones ni prefijos.`,
  );

  if (codexText) {
    logger.info(
      { userId: opportunity.userId, journey: opportunity.journeyName, mode: "codex" },
      "Message generated with Codex",
    );
    return {
      text: enforceLength(codexText, opportunity.deepLink),
      journeyName: opportunity.journeyName,
      deepLink: opportunity.deepLink,
    };
  }

  // 2. Try Claude API if Codex unavailable
  if (useClaudeAI) {
    const aiMessage = await generateWithClaude(opportunity, userContext, journeyPrompt);
    if (aiMessage) {
      logger.info(
        { userId: opportunity.userId, journey: opportunity.journeyName, mode: "claude" },
        "Message generated with Claude",
      );
      return { ...aiMessage, text: enforceLength(aiMessage.text, aiMessage.deepLink) };
    }
  }

  // 3. Fallback to templates (synchronous — no extra DB calls)
  const templateMessage = generateFromTemplate(opportunity, capsuleProgress, scores, assessment);
  logger.info(
    { userId: opportunity.userId, journey: opportunity.journeyName, mode: "template" },
    "Message generated from template",
  );
  if (templateMessage) {
    return { ...templateMessage, text: enforceLength(templateMessage.text, templateMessage.deepLink) };
  }
  return null;
}
