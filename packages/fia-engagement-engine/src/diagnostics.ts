/**
 * Fase 1 — instrumentacion. NO cambia ninguna decision: solo deja rastro.
 *
 * Existe porque 4 de las 5 causas de que Sofia responda mal son invisibles desde la base:
 * hoy solo se guarda lo que entra y lo que sale, y nada de lo que pasa en el medio.
 *
 * DOS DECISIONES DE DISENO, las dos por errores de la primera version:
 *
 * 1. Escribe en `sofia_diagnostics`, tabla propia. La v1 escribia en `sofia_conversations`
 *    y esas filas entraban al prompt del modelo como si fueran mensajes de Sofia, ademas
 *    de romper `truncatedThreads` — la metrica que mide justo el sintoma que vinimos a
 *    arreglar. Una tabla aparte no puede contaminar ninguna ventana de contexto.
 *
 * 2. El rastro de la busqueda viaja por AsyncLocalStorage, no por una variable de modulo.
 *    La v1 usaba un global "para no cambiar la firma de searchKnowledge". Entre que se
 *    escribe y se lee hay una llamada al LLM de varios segundos: con dos conversaciones
 *    simultaneas, la fila de una quedaba estampada con los numeros de la otra. Justo bajo
 *    carga, que es cuando estos datos importan.
 */
import { getSupabaseClient } from "./db/supabase";
import { leerRastro } from "./diagnosticsContext";
import { logger } from "./logger";

export type MotivoSilencio =
  | "no_etiquetada"
  | "rate_limit"
  | "sin_respuesta"
  | "mensaje_vacio"
  | "grupo_no_registrado";

export interface Rastro {
  conversationId?: string | null;
  groupJid?: string | null;
  askerPhone?: string | null;
  askerLid?: string | null;
  subjectUserId?: string | null;
  subjectOrigin?: "grupo" | "quien_pregunta" | "ninguno";
  textoEntrante?: string;
}

const UMBRAL = 0.25; // el mismo corte que aplica searchKnowledge

/**
 * Escribe una fila de diagnostico. NO se debe esperar con `await` en el camino de la
 * respuesta: `logConversation` no tiene timeout, y colgarse escribiendo un dato de
 * diagnostico demoraria el mensaje al usuario. Se llama con `void`.
 */
async function escribir(fila: Record<string, unknown>): Promise<void> {
  try {
    const { error } = await getSupabaseClient().from("sofia_diagnostics").insert(fila);
    if (error) logger.warn({ error }, "no se pudo escribir sofia_diagnostics");
  } catch (e) {
    logger.warn({ e }, "escribir diagnostico tiro");
  }
}

/** Registra que Sofia decidio CALLARSE, con el motivo. */
export function registrarSilencio(motivo: MotivoSilencio, r: Rastro): void {
  void escribir({
    group_jid: r.groupJid ?? null,
    conversation_id: r.conversationId ?? null,
    asker_phone: r.askerPhone ?? null,
    asker_lid: r.askerLid ?? null,
    subject_user_id: r.subjectUserId ?? null,
    subject_origin: r.subjectOrigin ?? null,
    motivo_silencio: motivo,
    texto: (r.textoEntrante ?? "").slice(0, 300),
  });
}

/** Registra COMO se armo una respuesta: sujeto, motor de busqueda y calidad de los hits. */
export function registrarRespuesta(r: Rastro): void {
  const b = leerRastro();
  void escribir({
    group_jid: r.groupJid ?? null,
    conversation_id: r.conversationId ?? null,
    asker_phone: r.askerPhone ?? null,
    asker_lid: r.askerLid ?? null,
    subject_user_id: r.subjectUserId ?? null,
    subject_origin: r.subjectOrigin ?? null,
    motivo_silencio: null,
    motor_busqueda: b.motor,
    fragmentos: b.similitudes.filter((x) => x >= UMBRAL).length,
    similitudes: b.similitudes.slice(0, 10),
    texto: (r.textoEntrante ?? "").slice(0, 300),
  });
}
