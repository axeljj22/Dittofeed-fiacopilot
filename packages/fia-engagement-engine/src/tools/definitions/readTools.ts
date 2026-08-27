/** Read-only tools (Sofía 2.0, Phase 3). Each maps to an existing DB helper. Never mutate. */
import {
  searchCapsuleContent,
  formatCapsuleContent,
  searchKnowledge,
  getCapsuleProgressForUser,
  getPathTotals,
  resolveUserPaths,
} from "../../db/supabase";
import type { ToolDef } from "../types";

const queryParam = {
  type: "object",
  properties: { query: { type: "string", description: "El tema o pregunta a buscar" } },
  required: ["query"],
} as const;

export const searchCapsulesTool: ToolDef = {
  key: "search_capsules",
  description:
    "Busca en el contenido de las cápsulas/clases del programa que cursa el alumno (transcripciones, resúmenes). Usalo para responder dudas de contenido. Ya viene acotado al programa del alumno.",
  parameters: queryParam as unknown as Record<string, unknown>,
  mode: "read",
  approval: "none",
  handler: async (ctx, args) => {
    const q = String(args["query"] ?? "").trim();
    if (!q) return "Sin consulta.";
    // "Sin alcance" y "busqué y no encontré nada" son dos cosas distintas, y devolver el
    // mismo texto para las dos hace que Sofía diga "no encontré nada en tu programa" a
    // alguien que no cursa ningún programa. Suena a que el contenido no existe, cuando lo
    // que pasa es que esa persona no tiene acceso.
    if (!ctx.scopedSlugs || !ctx.scopedSlugs.length) {
      return "Esta persona no tiene ningún programa asignado, así que no hay contenido de clases para buscar. Respondé con lo que sepas en general, sin inventar contenido de clases.";
    }
    const hits = await searchCapsuleContent(q, ctx.scopedSlugs);
    const out = formatCapsuleContent(hits);
    return out || "No encontré contenido relevante en las cápsulas del programa del alumno.";
  },
};

export const searchKnowledgeTool: ToolDef = {
  key: "search_knowledge",
  description:
    "Busca en la base de conocimiento de FIA (frameworks, principios, casos, productos). Usalo para dudas conceptuales o sobre FIA. Ya viene acotado al programa del alumno + conocimiento global.",
  parameters: queryParam as unknown as Record<string, unknown>,
  mode: "read",
  approval: "none",
  handler: async (ctx, args) => {
    const q = String(args["query"] ?? "").trim();
    if (!q) return "Sin consulta.";
    const entries = await searchKnowledge(q, ctx.scopedSlugs);
    if (entries.length === 0) return "No encontré nada relevante en la base de conocimiento.";
    return entries
      .slice(0, 4)
      .map((e) => `- ${e.title}: ${(e.summary ?? e.content ?? "").slice(0, 300)}`)
      .join("\n");
  },
};

export const getStudentProgressTool: ToolDef = {
  key: "get_student_progress",
  description:
    "Devuelve el progreso del alumno: cápsulas completadas, en curso, próxima acción y avance del track. Usalo para preguntas de seguimiento (cómo viene, cuánto le falta).",
  parameters: { type: "object", properties: {} } as unknown as Record<string, unknown>,
  mode: "read",
  approval: "none",
  handler: async (ctx) => {
    const [progress, totals] = await Promise.all([getCapsuleProgressForUser(ctx.userId), getPathTotals()]);
    const paths = resolveUserPaths(progress, totals);
    const active = paths.find((p) => p.activePath) ?? paths[0];
    const completed = progress.filter((p) => p.status === "completed").length;
    const inProg = progress.find((p) => p.status === "in_progress");
    const parts = [`${completed} cápsulas completadas`];
    if (active) parts.push(`avance ${active.completed}/${active.total} en ${active.name}`);
    if (inProg) parts.push(`en curso: cápsula ${inProg.capsule_number}`);
    if (active?.nextCapsuleNumber) parts.push(`próxima: cápsula ${active.nextCapsuleNumber}${active.nextCapsuleTitle ? ` (${active.nextCapsuleTitle})` : ""}`);
    return parts.join("; ") + ".";
  },
};

export const getAdminLinksTool: ToolDef = {
  key: "get_admin_links",
  description:
    "Devuelve los links administrativos del programa del alumno (calendario, grabaciones, Skool, pagos, soporte). Usalo para dudas operativas/administrativas.",
  parameters: { type: "object", properties: {} } as unknown as Record<string, unknown>,
  mode: "read",
  approval: "none",
  handler: async (ctx) => {
    const entries = Object.entries(ctx.adminLinks ?? {}).filter(([, v]) => v);
    if (entries.length === 0) return "No tengo links administrativos cargados para este programa. Derivá a soporte o al coach.";
    return entries.map(([k, v]) => `${k}: ${v}`).join("\n");
  },
};
