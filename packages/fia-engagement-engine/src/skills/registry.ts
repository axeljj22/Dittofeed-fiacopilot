/**
 * Skill registry (Sofía 2.0, Phase 1). The in-code SKILL_DEFAULTS is the zero-downtime fallback used
 * when the sofia_skills table is absent; when present, DB rows override the metadata (router text,
 * examples, keywords, priority) so Axel can tune routing without a deploy. Prompt addenda live in
 * engine_config ('skill_prompt.<key>', see engineConfigCache.getSkillPromptAddendum).
 */
import { getSkillRows } from "../db/supabase";
import type { Skill } from "./types";

/** In-code definitions — mirror the seed in migration 012. Source of truth before the table exists. */
export const SKILL_DEFAULTS: Skill[] = [
  {
    key: "general",
    name: "General",
    routerDescription:
      "Conversación general, small talk, dudas amplias, o cualquier cosa que no encaje claramente en otra skill. Es el fallback por defecto.",
    exampleUtterances: ["hola", "gracias", "cómo estás", "qué es FIA", "contame más"],
    contextLoaders: ["profile"],
    tools: [],
    requiresProgram: false,
    priority: 50,
    keywords: [],
  },
  {
    key: "content_qa",
    name: "Dudas de contenido",
    routerDescription:
      "Preguntas sobre el CONTENIDO de la formación que cursa el alumno: qué se vio en una clase/cápsula/semana, cómo hacer un ejercicio o entregable, dudas conceptuales del material, en qué semana está tal tema.",
    exampleUtterances: [
      "qué vimos en la clase 3",
      "cómo hago el ejercicio de la semana 2",
      "no entendí lo de los agentes",
      "en qué cápsula está el tema de n8n",
      "cuál es el entregable de esta semana",
    ],
    contextLoaders: ["profile", "progress", "knowledge_rag", "capsule_rag"],
    tools: [],
    requiresProgram: true,
    priority: 100,
    keywords: [
      "clase", "cápsula", "capsula", "semana", "módulo", "modulo", "ejercicio", "entregable", "tarea",
      "lección", "leccion", "tema", "contenido", "material", "cómo hago", "como hago", "no entendí",
      "no entendi", "explicá", "explica", "qué es", "que es", "concepto", "práctica", "practica", "workshop",
    ],
  },
  {
    key: "accountability",
    name: "Seguimiento",
    routerDescription:
      "La persona pregunta por SU avance/progreso o pide seguimiento: cómo viene, cuánto lleva, si está atrasada, qué le falta, en qué semana/cápsula está. Foco en motivación y próxima acción, no en explicar el contenido.",
    exampleUtterances: [
      "cómo vengo",
      "cuánto me falta",
      "estoy muy atrasado?",
      "en qué cápsula voy",
      "cuántas cápsulas llevo",
    ],
    contextLoaders: ["profile", "progress"],
    tools: [],
    requiresProgram: false,
    priority: 105,
    keywords: [
      "cómo vengo", "como vengo", "cómo voy", "como voy", "mi progreso", "cuánto me falta", "cuanto me falta",
      "cuánto llevo", "cuanto llevo", "en qué voy", "en que voy", "avance", "atrasado", "atrasada", "me atrasé",
      "me atrase", "al día", "al dia", "cuántas cápsulas", "cuantas capsulas", "qué me falta", "que me falta",
    ],
  },
  {
    key: "admin_support",
    name: "Soporte administrativo",
    routerDescription:
      "Cuestiones OPERATIVAS/administrativas: accesos, links, dónde entrar, grabaciones, calendario, horario de la próxima clase, pagos, facturas, Skool, comunidad, problemas de login. NO es contenido de la formación.",
    exampleUtterances: [
      "cuál es el link de la clase",
      "dónde veo las grabaciones",
      "no puedo entrar a la plataforma",
      "cuándo es la próxima clase",
      "cómo pago",
      "link de Skool",
      "no me llegó el acceso",
      "dónde está el calendario",
    ],
    contextLoaders: ["admin_links"],
    tools: [],
    requiresProgram: false,
    priority: 110,
    keywords: [
      "link", "enlace", "acceso", "acceder", "entrar", "ingresar", "grabación", "grabacion", "grabaciones",
      "calendario", "agenda", "horario", "cuándo es", "cuando es", "próxima clase", "proxima clase", "pago",
      "pagar", "factura", "cobro", "skool", "comunidad", "plataforma", "login", "contraseña", "password",
      "no puedo entrar", "no me llega", "no me llegó", "no me llego", "soporte",
    ],
  },
];

function rowToSkill(row: Awaited<ReturnType<typeof getSkillRows>>[number]): Skill {
  const kw = (row.metadata?.["keywords"] as string[] | undefined) ?? [];
  return {
    key: row.key,
    name: row.name,
    routerDescription: row.router_description,
    exampleUtterances: Array.isArray(row.example_utterances) ? row.example_utterances : [],
    contextLoaders: Array.isArray(row.context_loaders) ? row.context_loaders : [],
    tools: Array.isArray(row.tools) ? row.tools : [],
    requiresProgram: !!row.requires_program,
    priority: row.priority ?? 100,
    keywords: Array.isArray(kw) ? kw : [],
  };
}

/**
 * The active skill registry: DB rows (sofia_skills) when present, else the in-code SKILL_DEFAULTS.
 * Always includes 'general' (the universal fallback) even if the DB omits it.
 */
export async function getSkillRegistry(): Promise<Skill[]> {
  const rows = await getSkillRows();
  if (rows.length === 0) return SKILL_DEFAULTS;
  const skills = rows.map(rowToSkill);
  if (!skills.some((s) => s.key === "general")) {
    const general = SKILL_DEFAULTS.find((s) => s.key === "general");
    if (general) skills.push(general);
  }
  return skills;
}
