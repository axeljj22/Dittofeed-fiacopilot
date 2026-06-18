/**
 * Conversation classification job.
 *
 * Labels recent inbound messages into categories so the observability dashboard can show
 * "what kind of questions are users asking". Tries Claude (if configured), falls back to a
 * keyword heuristic so the job always produces labels even without an API key.
 *
 * Categories: contenido_programa | soporte_tecnico | ventas | motivacion | queja | saludo | otro
 */
import { config } from "../config";
import { logger } from "../logger";
import { getUnlabeledConversations, setConversationLabel } from "../db/supabase";

export const CONVERSATION_LABELS = [
  "contenido_programa",
  "soporte_tecnico",
  "ventas",
  "motivacion",
  "queja",
  "saludo",
  "otro",
] as const;

type Label = (typeof CONVERSATION_LABELS)[number];

const HEURISTICS: Array<{ label: Label; re: RegExp }> = [
  { label: "queja", re: /\b(no\s+funciona|error|mal|p[ée]simo|cancelar|reembolso|estafa|molesto|enojad)/i },
  { label: "ventas", re: /\b(precio|cu[áa]nto\s+(sale|cuesta)|plan|pagar|upgrade|comprar|factura|suscripci[oó]n)/i },
  { label: "soporte_tecnico", re: /\b(no\s+puedo\s+(entrar|acceder)|login|contrase[ñn]a|no\s+carga|bug|pantalla|link\s+roto|no\s+anda)/i },
  { label: "contenido_programa", re: /\b(c[áa]psula|paso|m[oó]dulo|semana|fase|prompt|worker|b[oó]veda|gpt|ejercicio|lecci[oó]n|contenido)/i },
  { label: "motivacion", re: /\b(no\s+tengo\s+tiempo|desanimad|cuesta|no\s+s[ée]\s+si|abandonar|dej[ée]\s+de|me\s+trab)/i },
  { label: "saludo", re: /^\s*(hola|buenas|buen\s+d[ií]a|gracias|chau|saludos|hey)\b/i },
];

function classifyHeuristic(text: string): Label {
  for (const { label, re } of HEURISTICS) {
    if (re.test(text)) return label;
  }
  return "otro";
}

const useClaude = config.anthropic.apiKey !== "" && config.anthropic.apiKey !== "placeholder";

async function classifyWithClaude(text: string): Promise<Label | null> {
  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: config.anthropic.apiKey });
    const response = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: 16,
      system:
        "Clasificás un mensaje de WhatsApp de un alumno en UNA categoría. Respondé SOLO con una de: " +
        CONVERSATION_LABELS.join(", ") + ". Sin explicación.",
      messages: [{ role: "user", content: text.slice(0, 500) }],
    });
    const block = response.content.find((b) => b.type === "text");
    const raw = block && block.type === "text" ? block.text.trim().toLowerCase() : "";
    const match = CONVERSATION_LABELS.find((l) => raw.includes(l));
    return match ?? null;
  } catch (error) {
    logger.warn({ error }, "Claude classification failed — using heuristic");
    return null;
  }
}

export async function classifyRecentConversations(limit = 50): Promise<{ classified: number }> {
  const rows = await getUnlabeledConversations(limit);
  if (rows.length === 0) {
    logger.info("No unlabeled conversations to classify");
    return { classified: 0 };
  }

  let classified = 0;
  for (const row of rows) {
    let label: Label | null = null;
    if (useClaude) label = await classifyWithClaude(row.body);
    if (!label) label = classifyHeuristic(row.body);
    await setConversationLabel(row.id, label);
    classified++;
  }

  logger.info({ classified }, "Conversation classification completed");
  return { classified };
}
