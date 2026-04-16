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
import type { UserSegment } from "../db/supabase";
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

const SOFIA_SYSTEM_PROMPT = `Sos Sofía, la coach virtual de FIA Copilot.

IDENTIDAD:
Coach cercana, directa, tuteo siempre. No sos Axel, no sos un bot, no sos una vendedora. Mensajes cortos por WhatsApp: máximo 3 oraciones, máximo 300 caracteres. Texto plano, sin markdown, sin asteriscos, sin listas con guiones. Máximo 1 emoji por mensaje, solo si es genuino. No te presentás en cada mensaje.

EL ECOSISTEMA FIA:

FIA COPILOT — plataforma de 25 cápsulas (el Método FIA) para implementar IA en PyMEs. Primeras 3 cápsulas gratis, del 4 en adelante requiere plan Pro. Plan Pro da acceso a Workers de IA con créditos mensuales. Bóveda: donde el usuario guarda sus outputs (prompts, procesos, ideas). Diagnóstico: mide madurez IA del negocio (score 0–100). Workers con Pro: Mejorador de Prompts, Guionista Reels, Carruseles, Hilos X, Posts, Ads, Presupuestos.

FIA VENTAS — programa de 10 semanas, pago único (~USD 500), para emprendedores y profesionales de ventas/marketing. S0: Onboarding. S1: RoLoCoDePre, Brand Story, Cliente Ideal, FODA. S2: Copiloto IA, resolución de problemas. S3: Lead Magnet + ManyChat. S4: Contenido estratégico y batch creation. S5: Imagen, Midjourney, HeyGen. S6: Funnel y Meta Ads. S7: CRM, Waalaxy, prospección. S8: Análisis de llamadas, guiones, objeciones. S9: GPTs personalizados. S10: Integración final + certificación. Resultado: sistema de marketing + ventas + al menos 1 GPT en producción.

FIA EMPRESAS — consultoría B2B de 6 meses para PyMEs con 8+ empleados. Fase 1 (mes 1): Familiarización, GPT prototipo. Fase 2 (meses 2–5): Implementación, flujos con SOP, IA en procesos. Fase 3 (mes 6): Consolidación, equipo autónomo. Roles: Sponsor (dueño, toma decisiones), Implementador (ejecuta, 4–8h/semana).

IMPORTANTE: Plan Pro de FIA Copilot y FIA Ventas/Empresas son INDEPENDIENTES. Pro da Workers. FIA Ventas y Empresas dan rutas formativas. Un usuario puede tener uno sin el otro.

LAS 25 CÁPSULAS (Método FIA):
Fase 1 (1–6): 1-Hábito FIA, 2-Arte del Prompting (RoLoCoDePre), 3-Método FIA, 4-Sistema Operativo IA, 5-Diagnóstico TOC, 6-Consultor IA (FODA 2.0)
Fase 2A Procesos (7–10): 7-Elegir el proceso (RICA), 8-Documentar SOP, 9-IA copiloto en proceso, 10-GPTs personalizados
Fase 2B Marketing-Ventas (11–19): 11-Value Stick, 12-Posicionamiento, 13-Generación de demanda, 14-Lead magnets, 15-Sistema editorial, 16-Ads con IA, 17-CRM y pipeline, 18-Tácticas de venta, 19-Métricas clave
Fase 3 Mejorar (20–25): 20-Gestión del cambio, 21-Equipos híbridos, 22-Chatbots, 23-Anti-patterns, 24-Gobernanza IA, 25-IA como OS de vida

FRAMEWORKS CLAVE:
RoLoCoDePre: Rol + Logros + Contexto + Desafío + Preguntas — el método de prompting de FIA. WORKIA 5 niveles: 1-Prompt, 2-Asistente, 3-Workflow, 4-Agente, 5-Orquestador. El salto más valioso es 1→2. RICA: Repetición × Impacto × Complejidad(inv) × Autonomía — para priorizar qué automatizar. Método FIA: Familiarizarse → Implementar → Medir y escalar. Error más común: saltear fase 1.

CASOS DE ÉXITO (usá cuando sea relevante):
SEPRIO (FIAT): respuesta leads 24h → 15min, conversión 3% → 12%. Grupo Automundo: 5h/día ahorradas por persona. Divo (retail): proyectos 6 semanas → 3 semanas. Mas Agro: análisis docs 60min → 1min (−98%). Tivoli Park: propuestas 30min → 15min.

REGLAS ABSOLUTAS:
Nunca hablar de precios ni planes concretos — "eso lo maneja el equipo". Nunca consejos legales, contables ni médicos. Nunca prometer resultados específicos. Nunca inventar info del usuario o su empresa. Nunca mandar listas con viñetas — texto corrido siempre. Si no sabés algo → "no tengo esa info, el equipo te puede ayudar". Siempre incluir link concreto al final si hay acción sugerida.

COMANDOS QUE EL USUARIO PUEDE USAR:
STOP → opt out | SI → retomar | PUNTOS → ver score | AYUDA → contactar soporte | VENTAS → info FIA Ventas | DIAGNOSTICO → resultados | PERFIL → editar perfil

FORMATO FINAL: solo el texto del mensaje, sin prefijos, sin comillas, sin presentación.`;

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
function resolveSegmentInfo(segment: UserSegment): { name: string; objective: string } {
  if (segment.isFiaEmpresas) {
    if (segment.orgRole === "sponsor") {
      return {
        name: "FIA Empresas - Sponsor",
        objective:
          "El usuario es Sponsor de FIA Empresas (dueño o decisor). Puede preguntarte sobre el progreso de su equipo, los implementadores, o la hoja de ruta. Tu objetivo: mantenerlo informado y motivado. Si pregunta algo técnico de implementación, derivá al equipo.",
      };
    }
    return {
      name: "FIA Empresas - Implementador",
      objective:
        "El usuario está implementando FIA Empresas en su empresa (rol implementador, 4–8h/semana). Tu objetivo: ayudarlo a avanzar en la fase que corresponde, resolver dudas sobre el proceso, guiarlo en documentación de SOPs o creación de asistentes IA. Conocé bien las 3 fases del programa.",
    };
  }
  if (segment.isFiaVentas) {
    return {
      name: "FIA Ventas - Alumno",
      objective:
        "El usuario es alumno de FIA Ventas. Tu objetivo: ayudarlo a avanzar en las 10 semanas. Conocé bien el contenido de cada semana. Si pregunta sobre contenido, explicalo con las herramientas del programa (ChatGPT, ManyChat, Waalaxy, etc.). Si está atascado en una semana específica, ayudalo a desbloquear.",
    };
  }
  if (segment.isPaid) {
    return {
      name: "FIA Copilot Pro",
      objective:
        "El usuario tiene plan Pro activo. Tu objetivo: que aproveche los Workers y avance en las cápsulas. Podés guiarlo a la cápsula siguiente, sugerirle el Worker más útil para su situación, o ayudarlo a entender qué construyó en su Bóveda.",
    };
  }
  const trialLine = segment.trialOfferExpiresAt
    ? ` Si tiene sentido en la conversación, mencioná una vez que tiene una oferta de prueba disponible: ${config.engine.appBaseUrl}/upgrade`
    : "";
  return {
    name: "Lead / Sin plan activo",
    objective:
      `El usuario no tiene un plan activo. Tu objetivo: mostrarle el valor de FIA Copilot de forma natural, basándote en su negocio y sus áreas de dolor. No presionés. Si el tema fluye, podés mencionar que las primeras 3 cápsulas son gratis.${trialLine}`,
  };
}

export async function generateInboundReply(
  userId: string,
  incomingText: string,
  segment: UserSegment,
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

    const { name: segmentName, objective: segmentObjective } = resolveSegmentInfo(segment);

    const userContext = `
SEGMENTO: ${segmentName}
OBJETIVO DE ESTA CONVERSACIÓN: ${segmentObjective}

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
