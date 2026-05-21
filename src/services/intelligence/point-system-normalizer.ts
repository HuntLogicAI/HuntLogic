// =============================================================================
// Point System Normalizer
// =============================================================================
// Each western state runs a different math under "preference" or "bonus"
// points. The ML forecaster can't compare CO (pure preference) to NV (bonus²)
// to AZ (bonus) without first projecting every record onto a common axis.
//
// This module is the single source of truth for that projection. It maps
// (state_code, species_slug) → point_system_type, and converts raw
// min_points_drawn into an "effective preference-equivalent" score.
//
// The transformation is pure and stateless; it can be called from:
//   - the ingestion pipeline (when writing new draw_odds rows)
//   - the ML loader (when computing forecast inputs)
//   - the recommendation engine (when ranking cross-state options)
//
// References (state-specific math derived from each agency's regulations):
//   - CO: pure preference (max preference wins; ties broken randomly)
//   - WY: pure preference for resident/nonresident, separate
//   - AZ: bonus — each app = 1 + bonus_points (loyalty bonus capped at +5)
//   - NV: bonus² — each app = bonus_points² + 1
//   - UT: 50/50 split — half tags go to highest-points, half random
//   - WA: bonus_squared (matches NV)
//   - NM: random — no point system
//   - ID: random — no point system
//   - OR: pure preference
//   - MT: pure preference (most species)
// =============================================================================

export type PointSystemType =
  | "pure_preference"
  | "bonus"
  | "bonus_squared"
  | "weighted_preference" // e.g. UT 50/50: half tags random, half by points
  | "random"
  | "none";

export interface PointSystemRule {
  type: PointSystemType;
  // Optional caps / multipliers used by `effectivePoints`.
  loyaltyBonusCap?: number; // e.g. AZ +5 max
  randomShare?: number; // for weighted_preference: portion of tags drawn randomly (0..1)
}

// State+species → point system rule. (state_code, species_slug) keys.
// When a species isn't in the map, the state-level default applies.
// Defaults fall back to the entry where species_slug is "*".
const POINT_SYSTEM_RULES: Record<string, PointSystemRule> = {
  // Colorado — pure preference for all big game
  "CO:*": { type: "pure_preference" },

  // Wyoming — pure preference, separate resident/nonresident pools
  "WY:*": { type: "pure_preference" },

  // Arizona — bonus with loyalty cap
  "AZ:*": { type: "bonus", loyaltyBonusCap: 5 },

  // Nevada — bonus² (each bonus point squared + 1)
  "NV:*": { type: "bonus_squared" },

  // Utah — 50/50 split for most species
  "UT:*": { type: "weighted_preference", randomShare: 0.5 },
  // UT moose, sheep, goat, bison are 50/50 too (no override needed)

  // Washington — bonus²
  "WA:*": { type: "bonus_squared" },

  // Oregon — pure preference for big game
  "OR:*": { type: "pure_preference" },

  // Montana — pure preference for big game (most species)
  "MT:*": { type: "pure_preference" },

  // New Mexico — pure random draw
  "NM:*": { type: "random" },

  // Idaho — pure random draw (Hunt Planner only reports outcomes, no points)
  "ID:*": { type: "random" },

  // Alaska — random for most; pure_preference for some draw permits.
  "AK:*": { type: "random" },
};

/**
 * Resolve which point-system rule applies to a given state/species pair.
 * Falls back through species-specific → state-default → "none".
 */
export function getPointSystemRule(
  stateCode: string,
  speciesSlug: string | null | undefined
): PointSystemRule {
  const upperState = stateCode.toUpperCase();
  if (speciesSlug) {
    const speciesKey = `${upperState}:${speciesSlug}`;
    if (POINT_SYSTEM_RULES[speciesKey]) {
      return POINT_SYSTEM_RULES[speciesKey];
    }
  }
  const defaultKey = `${upperState}:*`;
  if (POINT_SYSTEM_RULES[defaultKey]) {
    return POINT_SYSTEM_RULES[defaultKey];
  }
  return { type: "none" };
}

/**
 * Convert raw `min_points_drawn` (as reported by the state) into an
 * effective preference-equivalent score that the ML model can compare
 * across systems.
 *
 * Returns:
 *   - For pure preference systems: the raw value (already comparable).
 *   - For bonus systems: an estimate of "preference points to match the
 *     same draw odds" — this is approximate but better than raw bonus
 *     points (which under-represent applicants under bonus² math).
 *   - For random/none: null (point context is meaningless).
 */
export function effectivePoints(
  rule: PointSystemRule,
  minPointsDrawn: number | null | undefined
): number | null {
  if (minPointsDrawn === null || minPointsDrawn === undefined) return null;
  if (minPointsDrawn < 0) return null;

  switch (rule.type) {
    case "pure_preference":
      return minPointsDrawn;

    case "bonus": {
      // In a bonus system, an applicant with N bonus points has N+1
      // entries (1 base + N bonus). The minimum points seen drawing is
      // closer to "preference equivalent" than raw, but agency reporting
      // already uses min_bonus_points as the cut. We just clamp to the
      // loyalty cap when set.
      const cap = rule.loyaltyBonusCap ?? Infinity;
      return Math.min(minPointsDrawn, cap);
    }

    case "bonus_squared": {
      // Probability of draw is proportional to (bp + 1)² + 1.
      // To convert this back to "what preference points would have given
      // the same odds," we use the bonus^2 as the effective scale.
      // This makes a 6-bonus-point hunter equivalent to ~36 preference
      // points, which is the right order-of-magnitude for comparison.
      return minPointsDrawn * minPointsDrawn;
    }

    case "weighted_preference": {
      // Half the tags go random, half go to highest preference. If
      // randomShare=0.5, the "preference-equivalent" is effectively
      // halved (a 5-point hunter is competing for ~half the pool with
      // the same advantage as a pure-preference state).
      const ps = rule.randomShare ?? 0.5;
      return minPointsDrawn * (1 - ps);
    }

    case "random":
    case "none":
      return null;
  }
}

/**
 * Convenience for ingestion: given a draw_odds row's state/species/points,
 * return the (point_system_type, effective_points) tuple to persist.
 */
export function computeNormalizedPointsFields(
  stateCode: string,
  speciesSlug: string | null | undefined,
  minPointsDrawn: number | null | undefined
): { pointSystemType: PointSystemType; effectivePoints: number | null } {
  const rule = getPointSystemRule(stateCode, speciesSlug);
  return {
    pointSystemType: rule.type,
    effectivePoints: effectivePoints(rule, minPointsDrawn),
  };
}
