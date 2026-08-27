/**
 * Contexto por pedido para la instrumentacion (Fase 1).
 *
 * Modulo aparte y SIN dependencias a proposito: `db/supabase` necesita anotar la busqueda,
 * y `diagnostics` necesita escribir en supabase. Si viven en el mismo archivo hay un ciclo
 * de imports.
 *
 * Se usa AsyncLocalStorage y no una variable de modulo porque entre que se anota la
 * busqueda y se lee el rastro hay una llamada al LLM de varios segundos. Con dos
 * conversaciones simultaneas, un global hace que la fila de una quede estampada con los
 * numeros de la otra — justo bajo carga, que es cuando estos datos importan.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type MotorBusqueda = "semantico" | "palabras" | "ninguno";

export interface RastroBusqueda {
  motor: MotorBusqueda;
  similitudes: number[];
}

const almacen = new AsyncLocalStorage<RastroBusqueda>();

/** Envuelve el manejo de UN mensaje para que su rastro no se mezcle con el de otro. */
export function conRastro<T>(fn: () => Promise<T>): Promise<T> {
  return almacen.run({ motor: "ninguno", similitudes: [] }, fn);
}

/** Lo llama searchKnowledge. Fuera de un pedido instrumentado no hace nada. */
export function anotarBusqueda(motor: MotorBusqueda, similitudes: number[] = []): void {
  const r = almacen.getStore();
  if (!r) return; // sin contexto activo no se inventa un dato
  r.motor = motor;
  r.similitudes = similitudes;
}

export function leerRastro(): RastroBusqueda {
  return almacen.getStore() ?? { motor: "ninguno", similitudes: [] };
}
