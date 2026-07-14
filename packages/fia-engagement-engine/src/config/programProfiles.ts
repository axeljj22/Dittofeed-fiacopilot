/**
 * Data-driven program-profile resolution (Sofía 2.0, Phase 0).
 *
 * Replaces the hardcoded resolveSegmentInfo() switch with a DB-backed lookup (sofia_program_profiles)
 * so Axel can add a program/audience as a row, no deploy. The pure resolution logic lives in
 * ./programProfileResolver (unit-tested); this module is the async wrapper that fetches the profiles
 * and injects config. Zero-downtime: getProgramProfiles() returns [] when the table is absent, and
 * pickProgramProfile() then reproduces the exact v1 objectives.
 */
import { config } from "../config";
import { getProgramProfiles } from "../db/supabase";
import type { UserSegment } from "../db/supabase";
import { pickProgramProfile, type ResolvedProgramProfile } from "./programProfileResolver";

export type { ResolvedProgramProfile } from "./programProfileResolver";

/**
 * Resolves the program profile for a user. `activeSlug` (from the persisted active track, Phase 2)
 * wins when it matches an enrolled program; otherwise the highest-priority enrolled program is used.
 */
export async function resolveProgramProfile(
  segment: UserSegment,
  activeSlug?: string | null,
): Promise<ResolvedProgramProfile> {
  const profiles = await getProgramProfiles();
  return pickProgramProfile(profiles, segment, activeSlug, config.engine.appBaseUrl);
}
