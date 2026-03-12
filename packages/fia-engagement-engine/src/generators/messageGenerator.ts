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
    `Hola ${ctx.nombre}! Tu cápsula ${ctx.capsulaPendiente} del Método FIA te está esperando. ` +
    `Retomá desde donde dejaste: ${ctx.deepLink}`,

  reactivacion_inactividad_2: (ctx) =>
    `${ctx.nombre}, van ${ctx.diasInactivo} días sin avanzar en tu plan de IA para ${ctx.empresa}. ` +
    `La cápsula ${ctx.capsulaPendiente} tiene justo lo que necesitás ahora. ` +
    `Entrá acá: ${ctx.deepLink}`,

  reactivacion_inactividad_3: (ctx) =>
    `${ctx.nombre}, hace ${ctx.diasInactivo} días que no entrás a FIA Copilot. ` +
    `¿Querés retomar? Respondé SI y te ayudamos a volver al camino. ` +
    `O entrá directo: ${ctx.deepLink}`,

  celebracion_capsula: (ctx) =>
    `Felicitaciones ${ctx.nombre}! Completaste la cápsula ${ctx.capsulaPendiente - 1} del Método FIA. ` +
    `Ya llevás ${ctx.capsulasTotales}/25. Tu próximo paso: ${ctx.deepLink}`,

  celebracion_capsula_final: (ctx) =>
    `${ctx.nombre}, completaste las 25 cápsulas del Método FIA! ` +
    `Tu Bóveda tiene todo lo que construiste. Revisala: ${ctx.deepLink}`,

  bienvenida_diagnostico: (ctx) =>
    `Bienvenido/a ${ctx.nombre}! Tu diagnóstico FIA está listo. ` +
    `Score: ${ctx.overallScore}/100. ` +
    `Te recomendamos empezar por la cápsula ${ctx.capsulaPendiente}: ${ctx.deepLink}`,

  recuperacion_lead_frio: (ctx) =>
    `${ctx.nombre}, tu diagnóstico FIA mostró un score de ${ctx.overallScore}/100 para ${ctx.empresa}. ` +
    `Hay oportunidades concretas de IA para tu negocio. ` +
    `Mirá el plan completo: ${ctx.deepLink}`,

  resumen_semanal_sponsor: (ctx) =>
    `Resumen semanal de ${ctx.empresa}: tu equipo avanzó esta semana. ` +
    `Revisá el detalle de quién avanzó y quién necesita ayuda: ${ctx.deepLink}`,
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
): Promise<GeneratedMessage> {
  const capsuleProgress = await getCapsuleProgressForUser(opportunity.userId);
  const scores = await getLeadScoreForUser(opportunity.userId);

  const completedCount = capsuleProgress.filter(
    (p) => p.status === "completed",
  ).length;

  const ctx: TemplateContext = {
    nombre: opportunity.profile.nombre || "ahí",
    empresa: opportunity.profile.empresa || "tu empresa",
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
  const templateFn = TEMPLATES[templateKey] ?? TEMPLATES["reactivacion_inactividad_1"];
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
    .filter((o) => o.context_business)
    .map((o) => o.context_business)
    .slice(0, 3);

  if (businessContext.length > 0) {
    sections.push(`Contexto de negocio:\n${businessContext.join("\n")}`);
  }

  const recentOutputs = outputs.slice(0, 5).map(
    (o) =>
      `- Cápsula ${o.capsule_numero} (${o.content_type}): ${o.content.slice(0, 200)}`,
  );

  sections.push(`Outputs recientes:\n${recentOutputs.join("\n")}`);

  return sections.join("\n\n");
}

const SYSTEM_PROMPT = `Eres el asistente de engagement de FIA Copilot, una plataforma que ayuda a PyMEs latinoamericanas a implementar IA en sus negocios siguiendo el Método FIA (25 cápsulas).

Tu rol es generar mensajes de WhatsApp cortos, cálidos y accionables. Reglas:
- Máximo 300 caracteres (WhatsApp se lee en móvil)
- Tono cercano pero profesional. Tuteo natural latinoamericano.
- Siempre incluye el deep link proporcionado como CTA claro
- Menciona datos concretos del negocio del usuario cuando los tengas
- No uses emojis excesivos (máximo 1-2 por mensaje)
- No uses formato markdown — es WhatsApp, texto plano
- El mensaje debe sentirse como si viniera de un coach humano, no de un bot`;

const JOURNEY_PROMPTS: Record<string, string> = {
  reactivacion_inactividad: `Genera un mensaje de reactivación para un usuario inactivo.
Nivel 1 (5 días): recordatorio suave, menciona la cápsula pendiente.
Nivel 2 (10 días): más directo, menciona algo concreto de su Bóveda/negocio.
Nivel 3 (20 días): última llamada, invita a responder "SI" para retomar.`,

  celebracion_capsula: `Genera un mensaje celebrando que el usuario completó una cápsula.
Felicita el logro concreto y presenta la siguiente cápsula como el paso natural inmediato.
Si es la última cápsula (25), celebra la graduación y dirige a la Bóveda.`,

  bienvenida_diagnostico: `Genera un mensaje de bienvenida post-diagnóstico.
Resume el score en términos concretos (no solo números) y recomienda por dónde empezar.
Transmite entusiasmo genuino por el potencial que tiene el usuario.`,

  recuperacion_lead_frio: `Genera un mensaje para un lead que hizo el diagnóstico pero no se suscribió.
Recuerda su score y el valor que podría obtener. CTA a suscribirse.
Un solo intento — debe ser convincente pero no presionante.`,

  resumen_semanal_sponsor: `Genera un resumen semanal del avance del equipo para el sponsor.
Incluye: quién avanzó, quién está bloqueado, sugerencia de acción concreta.
Tono ejecutivo pero cálido. El sponsor necesita visibilidad rápida.`,
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
- Nombre: ${opportunity.profile.nombre}
- Empresa: ${opportunity.profile.empresa}
- Industria: ${opportunity.profile.industria}
- Objetivo: ${opportunity.profile.objetivo}
- Plan: ${opportunity.profile.plan}
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

const useAI =
  config.anthropic.apiKey !== "placeholder" &&
  config.anthropic.apiKey !== "";

export async function generateMessage(
  opportunity: EngagementOpportunity,
): Promise<GeneratedMessage | null> {
  // Try Claude API first if configured
  if (useAI) {
    const aiMessage = await generateWithClaude(opportunity);
    if (aiMessage) {
      logger.info(
        {
          userId: opportunity.userId,
          journey: opportunity.journeyName,
          mode: "ai",
        },
        "Message generated with Claude",
      );
      return aiMessage;
    }
  }

  // Fallback to templates
  const templateMessage = await generateFromTemplate(opportunity);
  logger.info(
    {
      userId: opportunity.userId,
      journey: opportunity.journeyName,
      mode: "template",
    },
    "Message generated from template",
  );
  return templateMessage;
}
