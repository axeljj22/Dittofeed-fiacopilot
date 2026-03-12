/**
 * Agente Generador — Claude API
 *
 * Genera mensajes personalizados usando el contexto real del usuario:
 * perfil, Bóveda, scores, progreso de cápsulas.
 */
import Anthropic from "anthropic";
import { config } from "../config";
import { logger } from "../logger";
import {
  getVaultOutputsForUser,
  getCapsuleProgressForUser,
  getLeadScoreForUser,
} from "../db/supabase";
import type { EngagementOpportunity, VaultOutput } from "../db/types";

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  return anthropicClient;
}

/**
 * Builds a rich context string from the user's Bóveda outputs.
 * This is what makes messages deeply personalized.
 */
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

export interface GeneratedMessage {
  text: string;
  journeyName: string;
  deepLink: string;
}

export async function generateMessage(
  opportunity: EngagementOpportunity,
): Promise<GeneratedMessage | null> {
  try {
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

    const response = await getAnthropicClient().messages.create({
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

    const messageText = textBlock.text.trim();

    logger.info(
      {
        userId: opportunity.userId,
        journey: opportunity.journeyName,
        messageLength: messageText.length,
      },
      "Message generated",
    );

    return {
      text: messageText,
      journeyName: opportunity.journeyName,
      deepLink: opportunity.deepLink,
    };
  } catch (error) {
    logger.error(
      { error, userId: opportunity.userId },
      "Failed to generate message",
    );
    return null;
  }
}
