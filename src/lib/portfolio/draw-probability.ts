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
 * Squared-bonus "names in a hat" lottery (NV, UT).
 *
 * IMPORTANT: this is NOT a preference system. It's a true lottery where each
 * point gives you an additional "name" in the hat:
 *   - 0 points → 1 entry  (you're still in the draw)
 *   - 1 point  → 2 entries
 *   - 7 points → 50 entries
 *   - 15 points → 226 entries
 *
 * Tags are drawn at random from the full pool. A 0-point hunter has nonzero
 * odds — they DO draw occasionally in NV. There is no "minimum points to
 * draw" floor in the way a preference system has it; minPointsDrawn from the
 * agency data tells us what happened to win one year, not a hard cutoff.
 *
 * Math:
 *   user_entries = points² + 1
 *   total_pool_entries = sum of (apps_at_point_n × (n² + 1)) across all n
 *   P(user wins one tag) = user_entries / total_pool_entries
 *   P(user wins at least one of `quota` tags) ≈ 1 - (1 - p)^quota
 *     for small p this collapses to ≈ p × quota
 *
 * Because we don't currently store the per-point applicant distribution, we
 * approximate the total pool entries from observed totalApplicants and an
 * assumed mean-entries-per-applicant. The assumed mean is the calibration
 * knob — currently set to match observed published draw rates against the
 * average applicant.
 *
 * If a published drawRate is provided, we anchor to it directly: drawRate is
 * the average applicant's chance of drawing, so the user's chance scales as
 * (user_entries / mean_entries).
 *
 * UT note: UT layers a 50% max-point-pool on top of the squared lottery
 * (top point holders get first crack at half the tags). That's not modeled
 * separately here — UT projections will slightly under-state odds for
 * top-point holders and slightly over-state odds for mid-tier holders.
 */
const ASSUMED_MEAN_APPLICANT_POINTS = 4;
const ASSUMED_MEAN_ENTRIES = ASSUMED_MEAN_APPLICANT_POINTS * ASSUMED_MEAN_APPLICANT_POINTS + 1; // 17

export function squaredBonusDrawProbability(
  userPoints: number,
  quota: number | null,
  observedTotalApplicants: number | null,
  _observedDrawnAtMinPoints: number | null = null,
  observedDrawRate: number | null = null,
): number {
  if (quota == null || quota <= 0) return 0.001;

  const userEntries = userPoints * userPoints + 1;

  // Best path: published drawRate anchors us to the realized average.
  // user's P(draw) ≈ drawRate × (user_entries / mean_entries)
  if (observedDrawRate != null && observedDrawRate > 0) {
    const scaled = observedDrawRate * (userEntries / ASSUMED_MEAN_ENTRIES);
    return Math.max(0.001, Math.min(0.95, scaled));
  }

  // Next-best: total applicants. Build the pool from observed apps × mean.
  if (observedTotalApplicants != null && observedTotalApplicants > 0) {
    const totalPoolEntries = observedTotalApplicants * ASSUMED_MEAN_ENTRIES;
    const pPerTag = userEntries / totalPoolEntries;
    // P(at least one of quota tags) ≈ 1 - (1-p)^quota
    const pAtLeastOne = 1 - Math.pow(1 - pPerTag, quota);
    return Math.max(0.001, Math.min(0.95, pAtLeastOne));
  }

  // Fallback with no observed data: synthetic 50-apps-per-tag pool.
  const syntheticApplicants = quota * 50;
  const syntheticPool = syntheticApplicants * ASSUMED_MEAN_ENTRIES;
  const pPerTag = userEntries / syntheticPool;
  const pAtLeastOne = 1 - Math.pow(1 - pPerTag, quota);
  return Math.max(0.001, Math.min(0.95, pAtLeastOne));
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
  /** Published average draw rate (0.0 to 1.0) — best anchor for squared-bonus */
  drawRate?: number | null;
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

    case "squared_bonus": {
      probability = squaredBonusDrawProbability(
        input.userPoints,
        input.quota ?? null,
        input.totalApplicants ?? null,
        input.drawnAtMinPoints ?? null,
        input.drawRate ?? null,
      );
      const entries = input.userPoints * input.userPoints + 1;
      basis = `${input.stateCode} squared-bonus lottery ("names in the hat"): you have ${input.userPoints}² + 1 = ${entries} entries in the random draw. ${input.drawRate != null ? `Anchored to published draw rate ${(input.drawRate * 100).toFixed(1)}%.` : input.totalApplicants != null ? `Pool size: ${input.totalApplicants} applicants.` : "No applicant data — using synthetic pool."}`;
      confidence = input.drawRate != null ? "high" : input.totalApplicants != null ? "medium" : "low";
      break;
    }

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
