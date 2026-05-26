/**
 * Personalized Portfolio Engine — type definitions
 *
 * The portfolio engine takes a hunter's point holdings across all states +
 * their goals/budget, and projects when they're likely to draw which tags
 * over a multi-year horizon. It's the differentiator: nothing else on the
 * market does personalized multi-state Monte Carlo simulation.
 */

// =============================================================================
// Inputs
// =============================================================================

/**
 * The point-allocation system a state uses. Drives which math the simulator
 * applies to compute per-year draw probability.
 *
 * - `preference`: rank-ordered, highest-points-first (CO, partial WY, OR, CA)
 * - `squared_bonus`: entries = points² + 1 (UT, NV)
 * - `bonus_random`: entries = points + 1, otherwise random (AZ)
 * - `random`: pure random, no point weighting (NM, ID)
 * - `hybrid_wy`: WY-specific split — 75% preference, 25% random
 * - `unknown`: state's system isn't modeled yet
 */
export type DrawSystem =
  | "preference"
  | "squared_bonus"
  | "bonus_random"
  | "random"
  | "hybrid_wy"
  | "unknown";

/** A single point holding from the user's profile. */
export interface PointHolding {
  stateCode: string;        // 'WY', 'CO', 'UT', etc.
  speciesSlug: string;      // 'elk', 'mule_deer', etc.
  points: number;           // current point count
  pointType?: "preference" | "bonus" | "loyalty";
}

/** Hunter's high-level goals — drives optimizer ranking. */
export interface HunterGoals {
  /** "trophy" = only apply where we have a real shot at trophy-class; "balanced" = mix of trophy + fill-freezer; "annual_hunt" = prioritize drawing every year */
  priority: "trophy" | "balanced" | "annual_hunt";
  /** Years out the hunter is willing to wait */
  patienceYears: number;
  /** Annual budget in USD (covers tags + travel + lodging) */
  annualBudgetUsd?: number;
  /** Willingness to use paid bypass paths (NM outfitter pool, landowner tags, governor's tags). 0 = no, 1 = yes. */
  payToBypassToleranceUsd?: number;
}

/** Top-level request for a portfolio simulation. */
export interface SimulateRequest {
  /** User's current point holdings across states/species */
  holdings: PointHolding[];
  /** Hunter goals (drives ranking and recommendations) */
  goals: HunterGoals;
  /** How many years out to project. Default 10. */
  horizonYears?: number;
  /** Filter to specific species (slug) the user cares about. Empty = all. */
  speciesFocus?: string[];
}

// =============================================================================
// Outputs
// =============================================================================

/** Single (state × species × year) projected draw probability. */
export interface YearProjection {
  year: number;            // calendar year (e.g. 2026, 2027...)
  yearsOut: number;        // 0 = this year, 1 = next year...
  projectedPoints: number; // how many points the user will have entering this year
  drawProbabilityPct: number; // 0-100, chance of drawing if they apply for top unit
  cumulativeDrawPct: number;  // chance of having drawn at least once by this year
  basis: string;           // human-readable explanation: "based on 2024 NDOW data, +0.4 pt/yr creep"
  confidence: "high" | "medium" | "low";
}

/** Full multi-year track for a single (state × species). */
export interface PortfolioTrack {
  stateCode: string;
  speciesSlug: string;
  drawSystem: DrawSystem;
  currentPoints: number;
  projections: YearProjection[];
  /** "Year you cross 50% cumulative draw probability" — quick summary stat. */
  expectedDrawYear: number | null;
  /** Apply-or-skip recommendation for this state×species */
  recommendation: TrackRecommendation;
}

/** Recommendation for a single track. */
export interface TrackRecommendation {
  verdict: "apply_every_year" | "build_then_apply" | "skip" | "burn_points";
  reasoning: string;
  /** Specific unit(s) we recommend applying for, if we have data */
  targetUnits?: Array<{
    unitCode: string;
    unitName: string;
    drawProbabilityPct: number;
    qualityNotes?: string;
  }>;
}

/** Full simulation response. */
export interface SimulateResponse {
  /** Echo of the input goals + horizon (for client-side display) */
  goals: HunterGoals;
  horizonYears: number;
  /** Per-track projections */
  tracks: PortfolioTrack[];
  /** Holistic portfolio-level summary */
  summary: {
    /** Year by which the hunter has 80%+ probability of drawing SOMETHING */
    firstExpectedDrawYear: number | null;
    /** Number of separate tags hunter is likely to draw within horizon */
    expectedTagsWithinHorizon: number;
    /** Single sentence narrative of the portfolio */
    narrative: string;
  };
  /** Caveats and confidence statements — required for any projection */
  disclaimers: string[];
}
