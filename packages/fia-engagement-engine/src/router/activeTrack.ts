/**
 * Active-track resolution (Sofía 2.0, Phase 2). Pure — no runtime imports, unit-testable.
 *
 * A multi-program student has ONE active track at a time so content stays isolated. The router's
 * inferred program (from the message) wins when valid; otherwise the persisted track is kept while
 * within TTL; otherwise there is no active track and the profile resolver falls back to priority.
 */
export const ACTIVE_TRACK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface ActiveTrackDecision {
  /** Slug to scope this turn to (null → resolver picks by priority). */
  activeSlug: string | null;
  /** True when the persisted value should be updated (i.e. a new valid track was inferred). */
  changed: boolean;
}

export function resolveActiveTrack(params: {
  persistedSlug: string | null;
  persistedSetAtMs: number | null;
  enrolledSlugs: string[];
  inferredSlug: string | null;
  nowMs: number;
  ttlMs?: number;
}): ActiveTrackDecision {
  const ttl = params.ttlMs ?? ACTIVE_TRACK_TTL_MS;
  const inferredValid = params.inferredSlug != null && params.enrolledSlugs.includes(params.inferredSlug);
  const persistedValid =
    params.persistedSlug != null &&
    params.enrolledSlugs.includes(params.persistedSlug) &&
    params.persistedSetAtMs != null &&
    params.nowMs - params.persistedSetAtMs < ttl;

  if (inferredValid) {
    return { activeSlug: params.inferredSlug, changed: params.inferredSlug !== params.persistedSlug };
  }
  if (persistedValid) {
    return { activeSlug: params.persistedSlug, changed: false };
  }
  return { activeSlug: null, changed: false };
}
