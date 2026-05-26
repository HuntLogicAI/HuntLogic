/**
 * Multi-year projection — for a given (state × species), compute per-year
 * draw probability given the user's current points + point-creep trend +
 * applicant pool growth.
 *
 * Returns a `PortfolioTrack` (defined in types.ts).
 */

import {
  computeDrawProbability,
  getDrawSystem,
  type DrawProbabilityInput,
} from "./draw-probability";
import type {
  PortfolioTrack,
  PointHolding,
  YearProjection,
  TrackRecommendation,
  HunterGoals,
  DrawSystem,
} from "./types";

/** Agency data feed for a specific (state × species), aggregated from drawOdds. */
export interface AgencyDataForTrack {
  /** Quota for the most-likely target unit (or aggregated state-wide) */
  quota: number | null;
  /** Total applicants in the residency pool */
  totalApplicants: number | null;
  /** Min points level that drew (preference / hybrid systems) */
  drawnAtMinPoints: number | null;
  /** Year-over-year point-creep rate (e.g., 0.4 = 0.4 pts/yr increase in cutoff) */
  observedPointCreepRate: number;
  /** Source label for the basis explanation */
  sourceLabel: string;
}

const DEFAULT_AGENCY_DATA: AgencyDataForTrack = {
  quota: null,
  totalApplicants: null,
  drawnAtMinPoints: null,
  // 0.4 pts/yr is a reasonable default for moderately competitive western units.
  // Premium units run 0.6-1.0+; OTC-adjacent run 0.0-0.2.
  observedPointCreepRate: 0.4,
  sourceLabel: "generic default",
};

/**
 * For a single state × species, project draw probability per year.
 *
 * @param holding         The hunter's current points (and pointType)
 * @param agency          Agency-derived stats for the most relevant unit
 * @param horizonYears    Years to project forward (typically 10)
 * @param baseYear        Calendar year for year 0 (typically the current year)
 */
export function projectTrack(
  holding: PointHolding,
  agency: AgencyDataForTrack = DEFAULT_AGENCY_DATA,
  horizonYears: number = 10,
  baseYear: number = new Date().getFullYear(),
): PortfolioTrack {
  const drawSystem: DrawSystem = getDrawSystem(holding.stateCode);
  const projections: YearProjection[] = [];

  let pointsByYear = holding.points;
  let cumNotDrawnProb = 1; // probability of NOT having drawn yet

  for (let i = 0; i <= horizonYears; i++) {
    const year = baseYear + i;

    // Compute draw probability assuming the user applies this year
    const input: DrawProbabilityInput = {
      stateCode: holding.stateCode,
      userPoints: pointsByYear,
      quota: agency.quota,
      totalApplicants: agency.totalApplicants,
      // Project the cutoff drifting upward over time
      drawnAtMinPoints: agency.drawnAtMinPoints != null
        ? agency.drawnAtMinPoints + agency.observedPointCreepRate * i
        : null,
    };
    const result = computeDrawProbability(input);

    cumNotDrawnProb *= 1 - result.probability;
    const cumulativeDrawPct = (1 - cumNotDrawnProb) * 100;

    projections.push({
      year,
      yearsOut: i,
      projectedPoints: pointsByYear,
      drawProbabilityPct: result.probability * 100,
      cumulativeDrawPct,
      basis: i === 0
        ? result.basis
        : `${result.basis} Projected ${i} year(s) forward at +${agency.observedPointCreepRate} pts/yr point creep (${agency.sourceLabel}).`,
      confidence: result.confidence,
    });

    // Advance: if didn't draw, +1 point (preference/bonus systems).
    // For pure random systems (NM, ID), points don't accumulate this way —
    // but we still increment yearsOut. Random states' P(draw) doesn't change
    // with our local point count anyway.
    if (drawSystem !== "random") {
      pointsByYear += 1;
    }
  }

  const expectedDrawYear = findExpectedDrawYear(projections, 0.5) ?? null;
  const recommendation = buildTrackRecommendation(
    drawSystem,
    holding,
    projections,
    agency,
  );

  return {
    stateCode: holding.stateCode,
    speciesSlug: holding.speciesSlug,
    drawSystem,
    currentPoints: holding.points,
    projections,
    expectedDrawYear,
    recommendation,
  };
}

/** Find the first year where cumulative draw probability crosses `threshold`. */
function findExpectedDrawYear(
  projections: YearProjection[],
  threshold: number,
): number | null {
  for (const p of projections) {
    if (p.cumulativeDrawPct / 100 >= threshold) return p.year;
  }
  return null;
}

/** Build a sensible apply/skip recommendation for a track. */
function buildTrackRecommendation(
  drawSystem: DrawSystem,
  holding: PointHolding,
  projections: YearProjection[],
  agency: AgencyDataForTrack,
): TrackRecommendation {
  const currentYearP = projections[0]?.drawProbabilityPct ?? 0;
  const cumByYear5 = projections[Math.min(5, projections.length - 1)]?.cumulativeDrawPct ?? 0;
  const cumByYear10 = projections[Math.min(10, projections.length - 1)]?.cumulativeDrawPct ?? 0;

  // System-specific advice
  if (drawSystem === "random") {
    return {
      verdict: "apply_every_year",
      reasoning: `${holding.stateCode} uses pure random draw — odds reset every year regardless of past applications, so applying costs nothing in expected outcome. Cumulative ${cumByYear10.toFixed(0)}% chance of drawing within 10 years assuming current quota and applicant pool hold.`,
    };
  }

  if (drawSystem === "unknown") {
    return {
      verdict: "skip",
      reasoning: `${holding.stateCode}'s draw system isn't modeled yet in HuntLogic. Verify with the state agency before relying on this projection.`,
    };
  }

  // Preference / squared-bonus / bonus-random / hybrid
  if (cumByYear5 >= 75) {
    return {
      verdict: "apply_every_year",
      reasoning: `Strong position: ${cumByYear5.toFixed(0)}% cumulative draw chance in next 5 years. Apply every cycle; you'll likely draw within that window.`,
    };
  }

  if (cumByYear10 >= 50) {
    return {
      verdict: "apply_every_year",
      reasoning: `Mid-tier position: ${cumByYear10.toFixed(0)}% cumulative chance within 10 years. Keep applying; this is the patient-game play. Don't skip cycles — ${drawSystem === "squared_bonus" ? "the squared system punishes skipped years disproportionately" : "you'd lose preference position"}.`,
    };
  }

  if (currentYearP < 1 && cumByYear10 < 20) {
    return {
      verdict: "build_then_apply",
      reasoning: `At your current point level (${holding.points}), draw odds are sub-1% in any given year and you only reach ${cumByYear10.toFixed(0)}% cumulative by year 10. This is multi-decade territory. Either accept the long arc, or pivot to a state with better odds at your point level.`,
    };
  }

  return {
    verdict: "apply_every_year",
    reasoning: `Mixed position: applying remains your best path even if the wait is long. ${cumByYear10.toFixed(0)}% cumulative within 10 years. ${agency.sourceLabel ? `Based on ${agency.sourceLabel}.` : ""}`,
  };
}

/** Build a holistic narrative across all tracks given the user's goals. */
export function buildPortfolioNarrative(
  tracks: PortfolioTrack[],
  goals: HunterGoals,
): string {
  if (tracks.length === 0) {
    return "No point holdings to project. Add points to states you're applying in to get a personalized projection.";
  }

  const strongTracks = tracks.filter((t) => (t.expectedDrawYear ?? Infinity) - new Date().getFullYear() <= 5);
  const longTracks = tracks.filter((t) => (t.expectedDrawYear ?? Infinity) - new Date().getFullYear() > 5 && t.expectedDrawYear !== null);
  const stuckTracks = tracks.filter((t) => t.expectedDrawYear === null);

  const parts: string[] = [];

  if (strongTracks.length > 0) {
    const names = strongTracks.map((t) => `${t.stateCode} ${t.speciesSlug}`).join(", ");
    parts.push(`Near-term draws (≤5yr): ${names}.`);
  }
  if (longTracks.length > 0) {
    const names = longTracks.map((t) => `${t.stateCode} ${t.speciesSlug} (~${t.expectedDrawYear})`).join(", ");
    parts.push(`Long-arc (6-10yr): ${names}.`);
  }
  if (stuckTracks.length > 0) {
    const names = stuckTracks.map((t) => `${t.stateCode} ${t.speciesSlug}`).join(", ");
    parts.push(`Sub-50% within horizon: ${names}.`);
  }

  // Goal-specific tail
  if (goals.priority === "trophy") {
    parts.push("Strategy: trophy-focused, so applying for top units only and accepting long waits is correct math for your stated priority.");
  } else if (goals.priority === "annual_hunt") {
    parts.push("Strategy: you want to hunt every year — supplement the long-arc tags with OTC parallels (CO archery elk, MT NR combo, ID general).");
  } else {
    parts.push("Strategy: balanced — mix the long-arc trophy applications with annual-hunt OTC options to stay active while points build.");
  }

  return parts.join(" ");
}
