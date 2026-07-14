/**
 * Pure program-profile resolution (Sofía 2.0, Phase 0). No runtime imports (types only), so it is
 * unit-testable without loading config/env or the Supabase client. The async wrapper that fetches
 * the profiles and injects appBaseUrl lives in ./programProfiles.
 *
 * v1 precedence preserved: Empresas > (enrolled program, e.g. Ventas) > Pro > Lead. A user enrolled
 * in a program with no matching profile (e.g. FIA Agéntica before the seed) falls through to Pro,
 * exactly as the old resolveSegmentInfo() did (agéntica users are isPaid).
 */
import type { UserSegment } from "../db/supabase";
import type { SofiaProgramProfile } from "../db/types";

export interface ResolvedProgramProfile {
  profileKey: string;
  /** display_name — injected as "SEGMENTO". */
  name: string;
  /** sofia_objective — injected as "OBJETIVO DE ESTA CONVERSACIÓN" (may include the trial line). */
  objective: string;
  /** Slugs to scope the RAG. [] means "use the user's enrolledPrograms" (caller decides). */
  knowledgeScope: string[];
  adminLinks: Record<string, string>;
  supportLevel: string;
  enabledSkills: string[];
  toneOverrides: string | null;
}

/** Trial-offer nudge appended to the Lead objective, mirroring resolveSegmentInfo(). */
function trialLine(segment: UserSegment, appBaseUrl: string): string {
  return segment.trialOfferExpiresAt
    ? ` Si tiene sentido en la conversación, mencioná una vez que tiene una oferta de prueba disponible: ${appBaseUrl}/upgrade`
    : "";
}

/**
 * Hardcoded fallbacks — verbatim copies of the v1 resolveSegmentInfo() texts. Keyed by the
 * resolution key: program slug ('fia-ventas') or synthetic ('__pro__', '__lead__', '__empresas_*__').
 * Only the keys v1 actually produced are here; unknown enrolled slugs fall through to '__pro__'/'__lead__'.
 */
export function hardcodedFor(key: string, segment: UserSegment, appBaseUrl: string): ResolvedProgramProfile | null {
  switch (key) {
    case "__empresas_sponsor__":
      return {
        profileKey: key,
        name: "FIA Empresas - Sponsor",
        objective:
          "El usuario es Sponsor de FIA Empresas (dueño o decisor). Puede preguntarte sobre el progreso de su equipo, los implementadores, o la hoja de ruta. Tu objetivo: mantenerlo informado y motivado. Si pregunta algo técnico de implementación, derivá al equipo.",
        knowledgeScope: ["fia-empresas"], adminLinks: {}, supportLevel: "standard", enabledSkills: [], toneOverrides: null,
      };
    case "__empresas_implementador__":
      return {
        profileKey: key,
        name: "FIA Empresas - Implementador",
        objective:
          "El usuario está implementando FIA Empresas en su empresa (rol implementador, 4–8h/semana). Tu objetivo: ayudarlo a avanzar en la fase que corresponde, resolver dudas sobre el proceso, guiarlo en documentación de SOPs o creación de asistentes IA. Conocé bien las 3 fases del programa.",
        knowledgeScope: ["fia-empresas"], adminLinks: {}, supportLevel: "standard", enabledSkills: [], toneOverrides: null,
      };
    case "fia-ventas":
      return {
        profileKey: key,
        name: "FIA Ventas - Alumno",
        objective:
          "El usuario es alumno de FIA Ventas. Tu objetivo: ayudarlo a avanzar en las 10 semanas. Conocé bien el contenido de cada semana. Si pregunta sobre contenido, explicalo con las herramientas del programa. Si está atascado en una semana específica, ayudalo a desbloquear.",
        knowledgeScope: ["fia-ventas"], adminLinks: {}, supportLevel: "standard", enabledSkills: [], toneOverrides: null,
      };
    case "__pro__":
      return {
        profileKey: key,
        name: "FIA Copilot Pro",
        objective:
          "El usuario tiene plan Pro activo. Tu objetivo: que aproveche los Workers y avance en las cápsulas. Podés guiarlo a la cápsula siguiente, sugerirle el Worker más útil para su situación, o ayudarlo a entender qué construyó en su Bóveda.",
        knowledgeScope: [], adminLinks: {}, supportLevel: "standard", enabledSkills: [], toneOverrides: null,
      };
    case "__lead__":
      return {
        profileKey: key,
        name: "Lead / Sin plan activo",
        objective:
          `El usuario no tiene un plan activo. Tu objetivo: mostrarle el valor de FIA Copilot de forma natural, basándote en su negocio y sus áreas de dolor. No presionés. Si el tema fluye, podés mencionar que las primeras 3 cápsulas son gratis.${trialLine(segment, appBaseUrl)}`,
        knowledgeScope: [], adminLinks: {}, supportLevel: "standard", enabledSkills: [], toneOverrides: null,
      };
    default:
      return null;
  }
}

/** Maps a DB profile row to the resolved shape, appending the trial line for the lead profile. */
function fromDbProfile(p: SofiaProgramProfile, segment: UserSegment, appBaseUrl: string): ResolvedProgramProfile {
  const objective = p.profile_key === "__lead__" ? `${p.sofia_objective}${trialLine(segment, appBaseUrl)}` : p.sofia_objective;
  return {
    profileKey: p.profile_key,
    name: p.display_name,
    objective,
    knowledgeScope: Array.isArray(p.knowledge_scope) ? p.knowledge_scope : [],
    adminLinks: p.admin_links ?? {},
    supportLevel: p.support_level ?? "standard",
    enabledSkills: Array.isArray(p.enabled_skills) ? p.enabled_skills : [],
    toneOverrides: p.tone_overrides ?? null,
  };
}

/** Finds the DB profile for a slug+tier: exact 'slug:tier' first, then the tier-agnostic 'slug'. */
function matchDbProfile(profiles: SofiaProgramProfile[], slug: string, tier: string | null): SofiaProgramProfile | null {
  if (tier) {
    const exact = profiles.find((p) => p.program_slug === slug && p.tier_match === tier);
    if (exact) return exact;
  }
  const generic = profiles.find((p) => p.program_slug === slug && !p.tier_match);
  return generic ?? null;
}

/** Effective priority of an enrolled program (DB routing_priority, or a v1-preserving fallback). */
function priorityOf(
  profiles: SofiaProgramProfile[],
  enrolled: UserSegment["enrolledPrograms"][number],
  segment: UserSegment,
  appBaseUrl: string,
): number {
  const db = matchDbProfile(profiles, enrolled.slug, enrolled.tier);
  if (db) return db.routing_priority;
  // No DB profile: give slugs that had a v1 hardcoded objective (fia-ventas) precedence over
  // "isPaid-only" programs (agéntica), matching v1's isFiaVentas-before-isPaid ordering.
  return hardcodedFor(enrolled.slug, segment, appBaseUrl) ? 170 : 0;
}

/**
 * Resolves the program profile for a user from an already-fetched profile list. `activeSlug` (the
 * persisted active track, Phase 2) wins when it matches an enrolled program; otherwise the
 * highest-priority enrolled program is used. Pure — safe to unit-test.
 */
export function pickProgramProfile(
  profiles: SofiaProgramProfile[],
  segment: UserSegment,
  activeSlug: string | null | undefined,
  appBaseUrl: string,
): ResolvedProgramProfile {
  const dbOrHardcoded = (key: string): ResolvedProgramProfile => {
    const db = profiles.find((p) => p.profile_key === key);
    return db ? fromDbProfile(db, segment, appBaseUrl) : (hardcodedFor(key, segment, appBaseUrl) ?? hardcodedFor("__lead__", segment, appBaseUrl)!);
  };

  // 1. FIA Empresas takes precedence (org-role based), matching v1.
  if (segment.isFiaEmpresas) {
    return dbOrHardcoded(segment.orgRole === "sponsor" ? "__empresas_sponsor__" : "__empresas_implementador__");
  }

  // 2. Enrolled program (excluding empresas, handled above). Pick the active/highest-priority one.
  const candidates = segment.enrolledPrograms.filter((p) => p.slug !== "fia-empresas");
  if (candidates.length > 0) {
    let chosen = activeSlug ? candidates.find((c) => c.slug === activeSlug) : undefined;
    if (!chosen) {
      chosen = candidates
        .slice()
        .sort((a, b) => priorityOf(profiles, b, segment, appBaseUrl) - priorityOf(profiles, a, segment, appBaseUrl))[0];
    }
    const db = matchDbProfile(profiles, chosen.slug, chosen.tier);
    if (db) return fromDbProfile(db, segment, appBaseUrl);
    const hc = hardcodedFor(chosen.slug, segment, appBaseUrl);
    if (hc) return hc;
    // Unknown enrolled slug with no profile (e.g. agéntica pre-seed) → fall through to Pro/Lead (v1).
  }

  // 3. Paid but no matching program profile → Pro. 4. Otherwise Lead.
  return segment.isPaid ? dbOrHardcoded("__pro__") : dbOrHardcoded("__lead__");
}
