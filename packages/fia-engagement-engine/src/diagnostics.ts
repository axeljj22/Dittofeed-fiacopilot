/**
 * Fase 1 — instrumentacion. NO cambia ninguna decision: solo deja rastro.
 *
 * Existe porque 4 de las 5 causas de que Sofia responda mal son invisibles desde la base:
 * hoy `sofia_conversations` guarda lo que entra y lo que sale, y nada de lo que pasa en el
 * medio. Sin esto, cualquier arreglo se evalua por sensacion.
 *
 * Se escribe en `metadata`, que ya es JSONB — no hace falta migracion.
 */
import { logConversation } from "./db/supabase";
import { logger } from "./logger";

/** Por que Sofia no contesto. */
export type MotivoSilencio =
  | "no_etiquetada"        // la nombraron pero no la @etiquetaron
  | "rate_limit"           // tope de respuestas por hora del grupo
  | "sin_respuesta"        // el generador no devolvio nada
  | "mensaje_vacio"        // texto sin contenido util
  | "grupo_no_registrado"; // el grupo no esta en el roster

export interface RastroDecision {
  conversationId?: string;
  groupJid?: string;
  /** Quien escribio (telefono normalizado). */
  askerPhone?: string;
  /** El id que Sofia uso como sujeto de la respuesta. */
  subjectUserId?: string | null;
  /** De donde salio ese sujeto: del grupo o del que pregunto. */
  subjectOrigin?: "grupo" | "quien_pregunta" | "ninguno";
  /** Que motor de busqueda se uso de verdad. */
  motorBusqueda?: "semantico" | "palabras" | "ninguno";
  /** Cuantos fragmentos pasaron el umbral. */
  fragmentos?: number;
  /** Similitudes crudas, para poder mover el umbral con datos y no a ojo. */
  similitudes?: number[];
  textoEntrante?: string;
}

/**
 * Registra que Sofia decidio CALLARSE, con el motivo.
 * Hoy esto no existe: cuando no contesta, no queda rastro. Por eso el sintoma que reporto
 * Axel —"no responde cuando la llaman"— era imposible de medir.
 */
export async function registrarSilencio(motivo: MotivoSilencio, rastro: RastroDecision): Promise<void> {
  try {
    await logConversation({
      conversation_id: rastro.conversationId,
      user_id: rastro.subjectUserId ?? null,
      direction: "out",
      kind: "silenced",
      body: `[sin respuesta: ${motivo}]`,
      status: "skipped",
      metadata: {
        fase1: true,
        motivo,
        group_jid: rastro.groupJid ?? null,
        asker_phone: rastro.askerPhone ?? null,
        subject_user_id: rastro.subjectUserId ?? null,
        subject_origin: rastro.subjectOrigin ?? null,
        texto: (rastro.textoEntrante ?? "").slice(0, 300),
      },
    });
  } catch (e) {
    // La instrumentacion NUNCA puede romper el flujo: si falla, se pierde el dato y ya.
    logger.warn({ e, motivo }, "no se pudo registrar el silencio");
  }
}

/** Registra COMO se armo una respuesta: sujeto, motor de busqueda y calidad de los hits. */
export async function registrarRespuesta(rastro: RastroDecision): Promise<void> {
  try {
    await logConversation({
      conversation_id: rastro.conversationId,
      user_id: rastro.subjectUserId ?? null,
      direction: "out",
      kind: "diagnostico",
      body: "[fase 1: como se armo la respuesta]",
      status: "skipped",
      metadata: {
        fase1: true,
        group_jid: rastro.groupJid ?? null,
        asker_phone: rastro.askerPhone ?? null,
        subject_user_id: rastro.subjectUserId ?? null,
        subject_origin: rastro.subjectOrigin ?? null,
        motor_busqueda: rastro.motorBusqueda ?? null,
        fragmentos: rastro.fragmentos ?? 0,
        similitudes: (rastro.similitudes ?? []).slice(0, 10),
        texto: (rastro.textoEntrante ?? "").slice(0, 300),
      },
    });
  } catch (e) {
    logger.warn({ e }, "no se pudo registrar el diagnostico de respuesta");
  }
}

/**
 * Guarda que motor de busqueda se uso en la ultima consulta del proceso.
 * Es un modulo suelto y no un parametro nuevo a proposito: asi `searchKnowledge` no cambia
 * de firma, y la Fase 1 no toca ninguna llamada existente.
 */
let ultimaBusqueda: { motor: "semantico" | "palabras" | "ninguno"; similitudes: number[] } = {
  motor: "ninguno",
  similitudes: [],
};
export function anotarBusqueda(motor: "semantico" | "palabras" | "ninguno", similitudes: number[] = []): void {
  ultimaBusqueda = { motor, similitudes };
}
export function leerUltimaBusqueda(): { motor: "semantico" | "palabras" | "ninguno"; similitudes: number[] } {
  return ultimaBusqueda;
}
