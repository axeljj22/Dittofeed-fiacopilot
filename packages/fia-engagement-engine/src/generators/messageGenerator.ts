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
  getVaultOutputsForUser,
  getCapsuleProgressForUser,
  getLeadScoreForUser,
} from "../db/supabase";
import type { EngagementOpportunity, VaultOutput } from "../db/types";
import { generateWithCodex } from "./codexGenerator";

export interface GeneratedMessage {
  text: string;
  journeyName: string;
  deepLink: string;
}

// ─── Template-based messages (no API key needed) ───

interface TemplateContext {
  nombre: string;
  empresa: string;
  capsulaPendiente: number;
  capsulasTotales: number;
  deepLink: string;
  fitScore: number;
  intentScore: number;
  overallScore: number;
  diasInactivo: number;
  level: number;
}

const TEMPLATES: Record<string, (ctx: TemplateContext) => string> = {
  reactivacion_inactividad_1: (ctx) =>
    `Hola ${ctx.nombre}! Soy Sofía de FIA Copilot. ` +
    `Tenés la cápsula ${ctx.capsulaPendiente} esperándote. ` +
    `Cuando puedas: ${ctx.deepLink}`,

  reactivacion_inactividad_2: (ctx) =>
    `${ctx.nombre}, hace ${ctx.diasInactivo} días que no entrás. ` +
    `La cápsula ${ctx.capsulaPendiente} está justo donde la dejaste. ` +
    `Retomá cuando quieras: ${ctx.deepLink}`,

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

  bienvenida_diagnostico: (ctx) =>
    `Hola ${ctx.nombre}, soy Sofía, tu Coach de FIA Copilot. ` +
    `Tu diagnóstico está listo — score ${ctx.overallScore}/100. ` +
    `Te recomiendo empezar por la cápsula ${ctx.capsulaPendiente}: ${ctx.deepLink}`,

  recuperacion_lead_frio: (ctx) =>
    `${ctx.nombre}, tu diagnóstico FIA marcó ${ctx.overallScore}/100 para ${ctx.empresa}. ` +
    `Hay pasos concretos para mejorar eso. Mirá el plan: ${ctx.deepLink}`,

  resumen_semanal_sponsor: (ctx) =>
    `Hola! Acá el resumen de esta semana de ${ctx.empresa}. ` +
    `Revisá quién avanzó y quién necesita un empujón: ${ctx.deepLink}`,
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

async function generateFromTemplate(
  opportunity: EngagementOpportunity,
): Promise<GeneratedMessage | null> {
  const capsuleProgress = await getCapsuleProgressForUser(opportunity.userId);
  const scores = await getLeadScoreForUser(opportunity.userId);

  const completedCount = capsuleProgress.filter(
    (p) => p.status === "completed",
  ).length;

  const ctx: TemplateContext = {
    nombre: opportunity.profile.name || "ahí",
    empresa: opportunity.profile.company_name || "tu empresa",
    capsulaPendiente:
      (opportunity.context as { pendingCapsuleNumero?: number })
        .pendingCapsuleNumero ??
      (opportunity.context as { nextCapsuleNumero?: number })
        .nextCapsuleNumero ??
      (opportunity.context as { recommendedCapsule?: number })
        .recommendedCapsule ??
      1,
    capsulasTotales: completedCount,
    deepLink: opportunity.deepLink,
    fitScore: scores?.fit_score ?? 0,
    intentScore: scores?.intent_score ?? 0,
    overallScore: scores?.overall_score ?? 0,
    diasInactivo:
      (opportunity.context as { daysSinceLastEvent?: number })
        .daysSinceLastEvent ?? 0,
    level: opportunity.level ?? 1,
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
  const text = templateFn(ctx);

  return {
    text,
    journeyName: opportunity.journeyName,
    deepLink: opportunity.deepLink,
  };
}

// ─── Claude API messages (when API key is available) ───

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
    (o) =>
      `- (${o.content_type}): ${o.content.slice(0, 200)}`,
  );

  sections.push(`Outputs recientes:\n${recentOutputs.join("\n")}`);

  return sections.join("\n\n");
}

const SYSTEM_PROMPT = `Sos Sofía, Coach de FIA Copilot. Tenés 24 años, sos argentina, vivís en Olivos y estudiás administración de empresas. Tu trabajo es acompañar a los usuarios en su recorrido por el Método FIA (25 cápsulas para implementar IA en PyMEs latinoamericanas).

Tu personalidad:
- Cercana y humana, pero siempre respetuosa y profesional
- Tuteo natural latinoamericano — nada forzado
- Mensajes cortos como los manda cualquier persona real por WhatsApp
- Pocos emojis — máximo uno por mensaje, y solo si suma
- Texto plano — sin markdown, sin asteriscos, sin listas con guiones

Lo que podés hacer:
- Hablar del contenido y avance de las cápsulas
- Hacer seguimiento del progreso del usuario
- Motivar a retomar o continuar el programa
- Responder dudas sobre la plataforma FIA Copilot

Lo que nunca hacés:
- Hablar de precios, planes o pagos
- Dar diagnósticos, consejos legales ni médicos
- Prometer resultados específicos o garantías
- Inventar información sobre el usuario o su empresa

Formato de respuesta:
- Máximo 300 caracteres
- Solo el texto del mensaje, sin prefijos ni explicaciones
- Si tenés el deep link, incluilo de forma natural al final`;



const JOURNEY_PROMPTS: Record<string, string> = {
  reactivacion_inactividad: `El usuario lleva días sin entrar a FIA Copilot. Escribile como Sofía.
Nivel 1 (5 días): un recordatorio suave, sin presionar. Mencioná la cápsula que tiene pendiente.
Nivel 2 (10 días): algo más directo. Si tenés datos de su empresa o Bóveda, usá uno concreto.
Nivel 3 (20 días): última vez que le escribís por esto. Invitalo a responder "SI" si quiere retomar.
No te presentés — ya te conoce de mensajes anteriores.`,

  celebracion_capsula: `El usuario acaba de completar una cápsula del Método FIA. Felicitalo como Sofía.
Sé genuina — es un logro real. Presentá la siguiente cápsula como el paso natural.
Si completó las 25 cápsulas, es una graduación — celebralo con más énfasis y mencioná la Bóveda.
No te presentés — ya te conoce.`,

  bienvenida_diagnostico: `Es el primer contacto con este usuario. Acaba de completar su diagnóstico FIA.
Presentate como Sofía, Coach de FIA Copilot — una sola vez, al inicio del mensaje. Breve.
Mencioná algo del resultado (score) de forma concreta y humana — no solo el número.
Invitalo a empezar por la cápsula recomendada con el deep link.`,

  recuperacion_lead_frio: `El usuario hizo el diagnóstico pero nunca empezó el programa. Escribile como Sofía.
Un solo intento. Recordale su score y qué oportunidades concretas puede aprovechar.
CTA a empezar — directo pero sin presionar. No te presentés si ya hubo contacto anterior.`,

  resumen_semanal_sponsor: `Es el reporte semanal para el sponsor del equipo. Escribilo como Sofía.
Mencioná quién avanzó, si alguien está bloqueado y una sugerencia accionable.
Tono ejecutivo pero cálido — el sponsor necesita visibilidad rápida, no un ensayo.`,
};

async function generateWithClaude(
  opportunity: EngagementOpportunity,
): Promise<GeneratedMessage | null> {
  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: config.anthropic.apiKey });

    const [vaultOutputs, capsuleProgress, scores] = await Promise.all([
      getVaultOutputsForUser(opportunity.userId),
      getCapsuleProgressForUser(opportunity.userId),
      getLeadScoreForUser(opportunity.userId),
    ]);

    const vaultContext = buildVaultContext(vaultOutputs);
    const completedCount = capsuleProgress.filter(
      (p) => p.status === "completed",
    ).length;

    const userContext = `
PERFIL DEL USUARIO:
- Nombre: ${opportunity.profile.name}
- Empresa: ${opportunity.profile.company_name}
- Industria: ${opportunity.profile.industry}
- Objetivo: ${opportunity.profile.objective}
- Temperatura: ${opportunity.profile.temperature}
- Cápsulas completadas: ${completedCount}/25

SCORES:
- Fit Score: ${scores?.fit_score ?? "N/A"}
- Intent Score: ${scores?.intent_score ?? "N/A"}
- Overall: ${scores?.overall_score ?? "N/A"}

BÓVEDA:
${vaultContext}

DATOS DEL JOURNEY:
- Journey: ${opportunity.journeyName}
- Nivel: ${opportunity.level ?? "N/A"}
- Deep link a incluir: ${opportunity.deepLink}
- Contexto adicional: ${JSON.stringify(opportunity.context)}
`.trim();

    const journeyPrompt =
      JOURNEY_PROMPTS[opportunity.journeyName] ??
      "Genera un mensaje de seguimiento personalizado.";

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
      logger.error(
        { userId: opportunity.userId },
        "No text in Claude response",
      );
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

// ─── Public API ───

const useClaudeAI =
  config.anthropic.apiKey !== "placeholder" &&
  config.anthropic.apiKey !== "";

export async function generateMessage(
  opportunity: EngagementOpportunity,
): Promise<GeneratedMessage | null> {
  // 1. Try Codex OAuth (ChatGPT Plus) first
  const [vaultOutputs, capsuleProgress, scores] = await Promise.all([
    getVaultOutputsForUser(opportunity.userId),
    getCapsuleProgressForUser(opportunity.userId),
    getLeadScoreForUser(opportunity.userId),
  ]);

  const vaultContext = buildVaultContext(vaultOutputs);
  const completedCount = capsuleProgress.filter((p) => p.status === "completed").length;
  const journeyPrompt =
    JOURNEY_PROMPTS[opportunity.journeyName] ?? "Genera un mensaje de seguimiento personalizado.";

  const userContext = `
PERFIL DEL USUARIO:
- Nombre: ${opportunity.profile.name}
- Empresa: ${opportunity.profile.company_name}
- Industria: ${opportunity.profile.industry}
- Objetivo: ${opportunity.profile.objective}
- Temperatura: ${opportunity.profile.temperature}
- Cápsulas completadas: ${completedCount}/25

SCORES:
- Fit Score: ${scores?.fit_score ?? "N/A"}
- Intent Score: ${scores?.intent_score ?? "N/A"}
- Overall: ${scores?.overall_score ?? "N/A"}

BÓVEDA:
${vaultContext}

DATOS DEL JOURNEY:
- Journey: ${opportunity.journeyName}
- Nivel: ${opportunity.level ?? "N/A"}
- Deep link a incluir: ${opportunity.deepLink}
- Contexto adicional: ${JSON.stringify(opportunity.context)}
`.trim();

  const codexText = await generateWithCodex(
    SYSTEM_PROMPT,
    `${journeyPrompt}\n\n${userContext}\n\nGenera SOLO el texto del mensaje de WhatsApp, sin explicaciones ni prefijos.`,
  );

  if (codexText) {
    logger.info(
      { userId: opportunity.userId, journey: opportunity.journeyName, mode: "codex" },
      "Message generated with Codex",
    );
    return { text: codexText, journeyName: opportunity.journeyName, deepLink: opportunity.deepLink };
  }

  // 2. Try Claude API if Codex unavailable
  if (useClaudeAI) {
    const aiMessage = await generateWithClaude(opportunity);
    if (aiMessage) {
      logger.info(
        { userId: opportunity.userId, journey: opportunity.journeyName, mode: "claude" },
        "Message generated with Claude",
      );
      return aiMessage;
    }
  }

  // 3. Fallback to templates
  const templateMessage = await generateFromTemplate(opportunity);
  logger.info(
    { userId: opportunity.userId, journey: opportunity.journeyName, mode: "template" },
    "Message generated from template",
  );
  return templateMessage;
}
