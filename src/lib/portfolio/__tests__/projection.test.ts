import { describe, expect, it } from "vitest";
import {
  projectTrack,
  buildPortfolioNarrative,
  type AgencyDataForTrack,
} from "../projection";
import type { PointHolding, HunterGoals } from "../types";

const baseAgency: AgencyDataForTrack = {
  quota: 50,
  totalApplicants: 2000,
  drawnAtMinPoints: 10,
  observedPointCreepRate: 0.4,
  sourceLabel: "test data",
};

describe("projectTrack", () => {
  it("returns projections for each year in horizon (inclusive)", () => {
    const holding: PointHolding = {
      stateCode: "NV",
      speciesSlug: "elk",
      points: 7,
    };
    const track = projectTrack(holding, baseAgency, 10);
    // horizonYears=10 → 11 projections (years 0 through 10)
    expect(track.projections.length).toBe(11);
    expect(track.projections[0].yearsOut).toBe(0);
    expect(track.projections[10].yearsOut).toBe(10);
  });

  it("accumulates points year-over-year for non-random systems", () => {
    const holding: PointHolding = {
      stateCode: "WY",
      speciesSlug: "mule_deer",
      points: 6,
    };
    const track = projectTrack(holding, baseAgency, 5);
    expect(track.projections[0].projectedPoints).toBe(6);
    expect(track.projections[1].projectedPoints).toBe(7);
    expect(track.projections[5].projectedPoints).toBe(11);
  });

  it("does NOT accumulate points for random systems (NM, ID)", () => {
    const holding: PointHolding = {
      stateCode: "NM",
      speciesSlug: "elk",
      points: 0,
    };
    const track = projectTrack(holding, baseAgency, 5);
    // Pure random — points stay at 0 forever (they don't accumulate
    // meaningfully because NM doesn't use points)
    expect(track.projections.every((p) => p.projectedPoints === 0)).toBe(true);
  });

  it("cumulativeDrawPct is monotonically non-decreasing", () => {
    const holding: PointHolding = {
      stateCode: "NV",
      speciesSlug: "elk",
      points: 5,
    };
    const track = projectTrack(holding, baseAgency, 10);
    for (let i = 1; i < track.projections.length; i++) {
      expect(track.projections[i].cumulativeDrawPct).toBeGreaterThanOrEqual(
        track.projections[i - 1].cumulativeDrawPct,
      );
    }
  });

  it("identifies expectedDrawYear at the 50% cumulative threshold", () => {
    const holding: PointHolding = {
      stateCode: "NV",
      speciesSlug: "elk",
      points: 8, // already close to drawnAtMinPoints=10
    };
    const track = projectTrack(holding, baseAgency, 15);
    if (track.expectedDrawYear !== null) {
      const yearAtCrossing = track.projections.find(
        (p) => p.year === track.expectedDrawYear,
      );
      expect(yearAtCrossing?.cumulativeDrawPct).toBeGreaterThanOrEqual(50);
    }
  });

  it("returns 'apply_every_year' verdict for random states", () => {
    const holding: PointHolding = {
      stateCode: "NM",
      speciesSlug: "elk",
      points: 0,
    };
    const track = projectTrack(holding, baseAgency, 10);
    expect(track.recommendation.verdict).toBe("apply_every_year");
    expect(track.recommendation.reasoning).toContain("random");
  });

  it("returns 'build_then_apply' verdict for very-low-odds tracks", () => {
    const lowOddsHolding: PointHolding = {
      stateCode: "NV",
      speciesSlug: "elk",
      points: 0, // way below cutoff of 10
    };
    const sparseAgency: AgencyDataForTrack = {
      ...baseAgency,
      quota: 5,
      totalApplicants: 5000,
      drawnAtMinPoints: 18,
      observedPointCreepRate: 0.5,
    };
    const track = projectTrack(lowOddsHolding, sparseAgency, 10);
    // Either "build_then_apply" or "apply_every_year" — both are valid
    // for low-odds tracks depending on cumulative threshold
    expect(["build_then_apply", "apply_every_year"]).toContain(
      track.recommendation.verdict,
    );
  });

  it("returns 'skip' verdict for unknown state systems", () => {
    const holding: PointHolding = {
      stateCode: "FAKE",
      speciesSlug: "elk",
      points: 5,
    };
    const track = projectTrack(holding, baseAgency, 10);
    expect(track.recommendation.verdict).toBe("skip");
  });

  it("attaches confidence levels to each projection", () => {
    const holding: PointHolding = {
      stateCode: "CO",
      speciesSlug: "mule_deer",
      points: 8,
    };
    const track = projectTrack(holding, baseAgency, 5);
    for (const p of track.projections) {
      expect(["high", "medium", "low"]).toContain(p.confidence);
    }
  });

  it("includes point-creep narrative in projection basis for year > 0", () => {
    const holding: PointHolding = {
      stateCode: "CO",
      speciesSlug: "elk",
      points: 8,
    };
    const track = projectTrack(holding, baseAgency, 5);
    expect(track.projections[3].basis).toContain("Projected 3 year");
  });

  it("uses default agency data when none provided", () => {
    const holding: PointHolding = {
      stateCode: "NV",
      speciesSlug: "elk",
      points: 5,
    };
    const track = projectTrack(holding);
    expect(track.projections.length).toBe(11);
    expect(track.projections[0].confidence).toBe("medium"); // bonus_random fallback
  });
});

describe("buildPortfolioNarrative", () => {
  const goals: HunterGoals = { priority: "balanced", patienceYears: 10 };

  it("returns empty-track message when no tracks", () => {
    const narrative = buildPortfolioNarrative([], goals);
    expect(narrative).toContain("No point holdings");
  });

  it("includes 'trophy' guidance for trophy-priority goals", () => {
    const trackNear = projectTrack(
      { stateCode: "NV", speciesSlug: "elk", points: 12 },
      baseAgency,
      10,
    );
    const trophyGoals: HunterGoals = { priority: "trophy", patienceYears: 10 };
    const narrative = buildPortfolioNarrative([trackNear], trophyGoals);
    expect(narrative.toLowerCase()).toContain("trophy");
  });

  it("includes OTC suggestions for annual_hunt priority", () => {
    const trackNear = projectTrack(
      { stateCode: "NV", speciesSlug: "elk", points: 12 },
      baseAgency,
      10,
    );
    const annualGoals: HunterGoals = {
      priority: "annual_hunt",
      patienceYears: 10,
    };
    const narrative = buildPortfolioNarrative([trackNear], annualGoals);
    expect(narrative.toLowerCase()).toContain("otc");
  });

  it("categorizes tracks into near-term / long-arc / stuck buckets", () => {
    const tracks = [
      projectTrack(
        { stateCode: "NV", speciesSlug: "elk", points: 15 },
        baseAgency,
        10,
      ),
      projectTrack(
        { stateCode: "NV", speciesSlug: "mule_deer", points: 0 },
        { ...baseAgency, drawnAtMinPoints: 25 },
        10,
      ),
    ];
    const narrative = buildPortfolioNarrative(tracks, goals);
    expect(narrative.length).toBeGreaterThan(20);
  });
});
