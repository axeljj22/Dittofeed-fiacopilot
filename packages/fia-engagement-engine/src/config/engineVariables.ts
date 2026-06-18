/**
 * Canonical registry of template variables available in message generation.
 * Exposed via GET /api/variables so the Visual Designer can display them with metadata.
 *
 * These correspond to fields in TemplateContext (messageGenerator.ts) and
 * are filled at runtime from Supabase user data.
 */

export interface EngineVariable {
  key: string;        // Variable name as used in templates: {{nombre}}
  label: string;      // Human-readable label for the UI
  source: string;     // Where the value comes from (DB table / computed)
  example: string;    // Example value for preview rendering
  category: "perfil" | "capsula" | "score" | "contexto" | "programa";
  description: string;
}

export const ENGINE_VARIABLES: EngineVariable[] = [
  // ── Perfil del usuario ──
  {
    key: "{{nombre}}",
    label: "Nombre",
    source: "profiles.name",
    example: "Axel",
    category: "perfil",
    description: "Nombre del usuario tal como está en su perfil.",
  },
  {
    key: "{{empresa}}",
    label: "Empresa",
    source: "profiles.company_name",
    example: "SEPRIO",
    category: "perfil",
    description: "Nombre de la empresa u organización del usuario.",
  },
  {
    key: "{{objetivo}}",
    label: "Objetivo",
    source: "profiles.objective",
    example: "implementar IA en el equipo de ventas",
    category: "perfil",
    description: "Objetivo declarado del usuario al registrarse.",
  },
  // ── Cápsulas ──
  {
    key: "{{capsulaPendiente}}",
    label: "Cápsula pendiente (número)",
    source: "capsule_progress (calculado)",
    example: "5",
    category: "capsula",
    description: "Número de la próxima cápsula que el usuario debe completar.",
  },
  {
    key: "{{capsulaTitle}}",
    label: "Título de la cápsula",
    source: "capsules.title (join)",
    example: "Diagnóstico TOC",
    category: "capsula",
    description: "Nombre o título de la cápsula pendiente. Puede ser null si no está disponible.",
  },
  {
    key: "{{capsulasTotales}}",
    label: "Cápsulas completadas",
    source: "capsule_progress (conteo)",
    example: "4",
    category: "capsula",
    description: "Cantidad de cápsulas completadas por el usuario hasta ahora.",
  },
  // ── Scores ──
  {
    key: "{{overallScore}}",
    label: "Score general FIA",
    source: "lead_scores.overall_score",
    example: "78",
    category: "score",
    description: "Score general de madurez IA del usuario (0–100).",
  },
  {
    key: "{{fitScore}}",
    label: "Fit Score",
    source: "lead_scores.fit_score",
    example: "82",
    category: "score",
    description: "Qué tan bien encaja el usuario con el perfil FIA (0–100).",
  },
  {
    key: "{{intentScore}}",
    label: "Intent Score",
    source: "lead_scores.intent_score",
    example: "65",
    category: "score",
    description: "Intención de compra o avance del usuario (0–100).",
  },
  // ── Programa formativo ──
  {
    key: "{{programa}}",
    label: "Programa activo",
    source: "learning_paths.name (calculado por path_id activo)",
    example: "FIA Ventas",
    category: "programa",
    description: "Nombre del programa formativo en el que está activo el usuario (FIA Ventas, FIA Empresas, FIA Agéntica, o Método FIA).",
  },
  {
    key: "{{capsulasDelPrograma}}",
    label: "Total cápsulas del programa",
    source: "capsules filtradas por path_id",
    example: "14",
    category: "programa",
    description: "Cantidad total de cápsulas en el programa del usuario (no el global de 25).",
  },
  {
    key: "{{pathProgress}}",
    label: "Progreso en el programa",
    source: "capsule_progress + capsules por path_id",
    example: "3/14",
    category: "programa",
    description: "Progreso del usuario dentro de su programa activo: completadas / total de esa ruta.",
  },
  // ── Contexto del journey ──
  {
    key: "{{daysInactive}}",
    label: "Días sin actividad",
    source: "calculado desde events",
    example: "7",
    category: "contexto",
    description: "Cantidad de días desde la última actividad del usuario en la plataforma.",
  },
  {
    key: "{{deepLink}}",
    label: "Link de acción",
    source: "generado por el orchestrator",
    example: "https://fiacopilot.com/capsula/5",
    category: "contexto",
    description: "URL de destino específica para el journey. Siempre presente en outbound. NO inventar — usar este valor.",
  },
  {
    key: "{{level}}",
    label: "Nivel del journey",
    source: "engagement_opportunities.level",
    example: "2",
    category: "contexto",
    description: "Nivel dentro del journey (ej: nivel 2 de reactivación = 10 días inactivo).",
  },
];

/** Group variables by category for UI display */
export function getVariablesByCategory(): Record<string, EngineVariable[]> {
  return ENGINE_VARIABLES.reduce(
    (acc, v) => {
      if (!acc[v.category]) acc[v.category] = [];
      acc[v.category]!.push(v);
      return acc;
    },
    {} as Record<string, EngineVariable[]>,
  );
}

/** Get a variable by its key (e.g. "{{nombre}}") */
export function getVariable(key: string): EngineVariable | undefined {
  return ENGINE_VARIABLES.find((v) => v.key === key);
}
