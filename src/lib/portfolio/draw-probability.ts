/**
 * Per-system draw-probability calculators.
 *
 * Each state uses a different math:
 *   - preference: P(draw) = empirical, from drawn-at point thresholds
 *   - squared_bonus: entries = points² + 1
 *   - bonus_random: entries = points + 1 (loyalty multiplier optional)
 *   - random: P(draw) = quota / applicants (point-independent)
 *   - hybrid_wy: 75% preference + 25% random split
 *
 * All functions return P(draw) ∈ [0, 1]. They take observed agency data
 * (applicants, quota, drawn-at point thresholds) where available, and
 * fall back to qualitative defaults when data is missing.
 */

import type { DrawSystem } from "./types";

/** State → DrawSystem mapping. Source of truth for which math to apply. */
export const STATE_DRAW_SYSTEMS: Record<string, DrawSystem> = {
  CO: "preference",
  WY: "hybrid_wy",
  UT: "squared_bonus",
  NV: "squared_bonus",
  AZ: "bonus_random",
  NM: "random",
  ID: "random",       // controlled-hunt portion; OTC zones not modeled
  MT: "bonus_random",
  OR: "preference",
  WA: "bonus_random",
  CA: "preference",
};

export function getDrawSystem(stateCode: string): DrawSystem {
  return STATE_DRAW_SYSTEMS[stateCode.toUpperCase()] ?? "unknown";
}

// =============================================================================
// Per-system probability functions
// =============================================================================

/**
 * Preference-point system: at point level N, you draw IF total tags exceeds
 * the count of applicants with ≥ N points. We approximate this from observed
 * "minimum points to draw" data when available.
 *
 * Inputs:
 *   - userPoints: hunter's current point count for this state/species/unit
 *   - drawnAtPoints: the lowest point level that drew last year for this unit (from agency data)
 *
 * Returns P(draw) ∈ [0, 1].
 */
export function preferenceDrawProbability(
  userPoints: number,
  drawnAtPoints: number | null,
): number {
  if (drawnAtPoints == null) return 0.1; // unknown — assume 10% as honest default
  if (userPoints > drawnAtPoints) return 0.95; // basically guaranteed (5% margin)
  if (userPoints === drawnAtPoints) return 0.5; // tie-breaker draw at the cutoff
  // If user is below the cutoff, probability drops sharply. We model it as
  // exponential decay based on how far below the cutoff they are.
  const gap = drawnAtPoints - userPoints;
  return Math.max(0.01, 0.5 * Math.exp(-0.7 * gap));
}

/**
 * Squared-bonus system (UT, NV): your entries in the draw are (points² + 1).
 * P(draw) ≈ user_entries / total_entries.
 *
 * Inputs:
 *   - userPoints
 *   - totalApplicantPoints: array of all applicants' point counts (or aggregate stats)
 *   - quota: total tags available
 *
 * If we don't have full applicant distribution, we approximate from observed
 * draw rate at the hunter's point level.
 */
export function squaredBonusDrawProbability(
  userPoints: number,
  quota: number | null,
  observedTotalApplicants: number | null,
  observedDrawnAtMinPoints: number | null = null,
): number {
  if (quota == null || quota <= 0) return 0.01;

  // If we have observed "min points drawn", use that as a hard floor signal
  if (observedDrawnAtMinPoints != null && userPoints < observedDrawnAtMinPoints) {
    // User is below the observed threshold — odds are extremely low
    const gap = observedDrawnAtMinPoints - userPoints;
    return Math.max(0.005, 0.05 * Math.exp(-0.4 * gap));
  }

  if (observedTotalApplicants == null || observedTotalApplicants <= 0) {
    // Fall back to simple ratio with synthetic applicant pool assumption
    // (rough heuristic: assume 50 applicants per quota tag with avg 4 points)
    const syntheticTotal = quota * 50;
    const userEntries = userPoints * userPoints + 1;
    const avgEntries = 4 * 4 + 1; // 17 entries for the synthetic-avg 4-point hunter
    const estimatedTotalEntries = syntheticTotal * avgEntries;
    return Math.min(0.95, (userEntries * quota) / estimatedTotalEntries);
  }

  // We have a real applicant count. Compute user's share of squared-entry pool.
  // Assume applicant point distribution is roughly geometric with mean ~5pts
  // (this is a coarse approximation — actual NDOW/UTDWR data could refine this).
  const userEntries = userPoints * userPoints + 1;
  const meanEntries = 5 * 5 + 1; // 26 entries for the average applicant
  const totalPoolEntries = observedTotalApplicants * meanEntries;
  return Math.min(0.95, (userEntries * quota) / totalPoolEntries);
}

/**
 * Bonus-random system (AZ, MT, WA): entries = points + 1, then random draw.
 *
 * P(draw) ≈ (points + 1) / sum_of_all_entries.
 */
export function bonusRandomDrawProbability(
  userPoints: number,
  quota: number | null,
  observedTotalApplicants: number | null,
): number {
  if (quota == null || quota <= 0) return 0.01;
  if (observedTotalApplicants == null || observedTotalApplicants <= 0) {
    // fallback heuristic
    return Math.min(0.6, ((userPoints + 1) * quota) / (50 * quota * 3));
  }

  const userEntries = userPoints + 1;
  const meanEntries = 3; // assume avg hunter has 2 bonus points
  const totalEntries = observedTotalApplicants * meanEntries;
  return Math.min(0.95, (userEntries * quota) / totalEntries);
}

/**
 * Pure random (NM, ID): P(draw) = quota / applicants. Point-independent.
 */
export function randomDrawProbability(
  quota: number | null,
  observedTotalApplicants: number | null,
): number {
  if (quota == null || observedTotalApplicants == null || observedTotalApplicants <= 0) {
    return 0.05; // default 5% — honest unknown
  }
  return Math.min(0.95, quota / observedTotalApplicants);
}

/**
 * WY hybrid: 75% of tags go through preference draw + 25% random.
 * Effective P(draw) = 0.75 * P_preference + 0.25 * P_random.
 */
export function hybridWyDrawProbability(
  userPoints: number,
  quota: number | null,
  observedTotalApplicants: number | null,
  drawnAtPoints: number | null,
): number {
  const prefShare = 0.75;
  const randomShare = 0.25;
  const prefP = preferenceDrawProbability(userPoints, drawnAtPoints);
  const randomP = randomDrawProbability(quota, observedTotalApplicants);
  return prefShare * prefP + randomShare * randomP;
}

// =============================================================================
// Unified dispatcher
// =============================================================================

export interface DrawProbabilityInput {
  stateCode: string;
  userPoints: number;
  /** Optional observed agency data — improves accuracy when available */
  quota?: number | null;
  totalApplicants?: number | null;
  drawnAtMinPoints?: number | null;
}

export interface DrawProbabilityResult {
  probability: number;        // 0.0 to 1.0
  system: DrawSystem;
  basis: string;              // human-readable explanation
  confidence: "high" | "medium" | "low";
}

export function computeDrawProbability(input: DrawProbabilityInput): DrawProbabilityResult {
  const system = getDrawSystem(input.stateCode);
  let probability = 0.05; // honest default for unknown
  let basis = "Insufficient agency data — qualitative estimate";
  let confidence: "high" | "medium" | "low" = "low";

  switch (system) {
    case "preference":
      probability = preferenceDrawProbability(input.userPoints, input.drawnAtMinPoints ?? null);
      basis = input.drawnAtMinPoints != null
        ? `${input.stateCode} preference draw: last cut at ${input.drawnAtMinPoints} pts; you have ${input.userPoints}.`
        : `${input.stateCode} preference draw; no agency cutoff data — estimating from defaults.`;
      confidence = input.drawnAtMinPoints != null ? "high" : "low";
      break;

    case "squared_bonus":
      probability = squaredBonusDrawProbability(
        input.userPoints,
        input.quota ?? null,
        input.totalApplicants ?? null,
        input.drawnAtMinPoints ?? null,
      );
      basis = `${input.stateCode} squared bonus: you have ${input.userPoints}² + 1 = ${input.userPoints * input.userPoints + 1} entries.`;
      confidence = input.totalApplicants != null ? "high" : "medium";
      break;

    case "bonus_random":
      probability = bonusRandomDrawProbability(
        input.userPoints,
        input.quota ?? null,
        input.totalApplicants ?? null,
      );
      basis = `${input.stateCode} bonus + random: you have ${input.userPoints + 1} entries in the draw.`;
      confidence = input.totalApplicants != null ? "high" : "medium";
      break;

    case "random":
      probability = randomDrawProbability(input.quota ?? null, input.totalApplicants ?? null);
      basis = input.quota != null && input.totalApplicants != null
        ? `${input.stateCode} pure random: ${input.quota} tags / ${input.totalApplicants} applicants. Point count doesn't matter.`
        : `${input.stateCode} pure random — odds reset every year regardless of past applications.`;
      confidence = input.totalApplicants != null ? "high" : "low";
      break;

    case "hybrid_wy":
      probability = hybridWyDrawProbability(
        input.userPoints,
        input.quota ?? null,
        input.totalApplicants ?? null,
        input.drawnAtMinPoints ?? null,
      );
      basis = `${input.stateCode} hybrid: 75% preference draw + 25% random pool. Your ${input.userPoints} pts work primarily in the preference 3/4.`;
      confidence = input.drawnAtMinPoints != null && input.totalApplicants != null ? "high" : "medium";
      break;

    case "unknown":
    default:
      basis = `${input.stateCode}'s draw system isn't modeled yet — using a generic 5% lottery default. Verify with the agency.`;
      confidence = "low";
      break;
  }

  return {
    probability: Math.max(0, Math.min(1, probability)),
    system,
    basis,
    confidence,
  };
}
