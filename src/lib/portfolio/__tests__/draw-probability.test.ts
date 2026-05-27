import { describe, expect, it } from "vitest";
import {
  computeDrawProbability,
  getDrawSystem,
  preferenceDrawProbability,
  squaredBonusDrawProbability,
  bonusRandomDrawProbability,
  randomDrawProbability,
  hybridWyDrawProbability,
} from "../draw-probability";

describe("getDrawSystem", () => {
  it("maps known states to their systems", () => {
    expect(getDrawSystem("CO")).toBe("preference");
    expect(getDrawSystem("WY")).toBe("hybrid_wy");
    expect(getDrawSystem("UT")).toBe("squared_bonus");
    expect(getDrawSystem("NV")).toBe("squared_bonus");
    expect(getDrawSystem("AZ")).toBe("bonus_random");
    expect(getDrawSystem("NM")).toBe("random");
  });

  it("returns 'unknown' for unmapped states", () => {
    expect(getDrawSystem("FAKE")).toBe("unknown");
  });

  it("is case-insensitive", () => {
    expect(getDrawSystem("co")).toBe("preference");
    expect(getDrawSystem("nv")).toBe("squared_bonus");
  });
});

describe("preferenceDrawProbability", () => {
  it("returns ~95% when user is above the cutoff", () => {
    expect(preferenceDrawProbability(15, 12)).toBeGreaterThan(0.9);
  });

  it("returns 50% at the cutoff (tie-breaker)", () => {
    expect(preferenceDrawProbability(12, 12)).toBe(0.5);
  });

  it("decays exponentially below the cutoff", () => {
    const p1 = preferenceDrawProbability(11, 12);
    const p3 = preferenceDrawProbability(9, 12);
    const p5 = preferenceDrawProbability(7, 12);
    // Each step below cutoff should reduce probability
    expect(p1).toBeGreaterThan(p3);
    expect(p3).toBeGreaterThan(p5);
    // Far below cutoff should be ≤ 5% rather than 0%
    expect(p5).toBeGreaterThan(0);
    expect(p5).toBeLessThan(0.1);
  });

  it("returns honest 10% default when cutoff is unknown", () => {
    expect(preferenceDrawProbability(5, null)).toBe(0.1);
  });
});

describe("squaredBonusDrawProbability (NV/UT lottery)", () => {
  it("returns higher probability with more points (other things equal)", () => {
    const p5 = squaredBonusDrawProbability(5, 100, 5000);
    const p10 = squaredBonusDrawProbability(10, 100, 5000);
    expect(p10).toBeGreaterThan(p5);
  });

  it("returns NONZERO probability for 0-point hunters (lottery, not preference)", () => {
    // The key behavior: even at 0 points, hunters have a real chance because
    // they're still in the hat. observedDrawnAtMinPoints does NOT create a
    // floor — it's just history, not a cutoff.
    const p = squaredBonusDrawProbability(0, 100, 1000);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeGreaterThan(0.0005); // at least the global minimum
  });

  it("a 0-point hunter still has odds even if last year's min was 12", () => {
    // CRUCIAL: this would be a near-zero result in a preference system, but
    // in a lottery the 0-point hunter has 1 name in the hat — they CAN draw.
    const p = squaredBonusDrawProbability(0, 100, 1000, 12);
    expect(p).toBeGreaterThan(0.0005);
  });

  it("anchors to published drawRate when provided", () => {
    // Avg applicant has 17 entries (4² + 1). User at 7 has 50 entries.
    // Expected ratio: 50/17 ≈ 2.94x the avg drawRate.
    const avgDrawRate = 0.05; // 5% avg
    const p = squaredBonusDrawProbability(7, 100, 1000, null, avgDrawRate);
    // Should be roughly avgDrawRate × (50/17) ≈ 0.147 (14.7%)
    expect(p).toBeGreaterThan(0.1);
    expect(p).toBeLessThan(0.2);
  });

  it("scales linearly with entry ratio when anchored to drawRate", () => {
    const avg = 0.05;
    const p0 = squaredBonusDrawProbability(0, 100, 1000, null, avg);
    const p7 = squaredBonusDrawProbability(7, 100, 1000, null, avg);
    const p15 = squaredBonusDrawProbability(15, 100, 1000, null, avg);
    // Entries: 1, 50, 226. Ratios vs mean (17): 0.059, 2.94, 13.3
    // So p7 should be ~50x p0; p15 should be ~226x p0
    expect(p7 / p0).toBeGreaterThan(40);
    expect(p15 / p0).toBeGreaterThan(100);
  });

  it("handles zero quota gracefully", () => {
    expect(squaredBonusDrawProbability(10, 0, 1000)).toBeLessThan(0.05);
  });

  it("clamps to <= 0.95 ceiling", () => {
    const p = squaredBonusDrawProbability(50, 1000, 10);
    expect(p).toBeLessThanOrEqual(0.95);
  });
});

describe("bonusRandomDrawProbability", () => {
  it("returns higher probability with more bonus points", () => {
    const p1 = bonusRandomDrawProbability(1, 50, 500);
    const p5 = bonusRandomDrawProbability(5, 50, 500);
    expect(p5).toBeGreaterThan(p1);
  });

  it("respects quota size", () => {
    const lowQuota = bonusRandomDrawProbability(5, 10, 500);
    const highQuota = bonusRandomDrawProbability(5, 100, 500);
    expect(highQuota).toBeGreaterThan(lowQuota);
  });
});

describe("randomDrawProbability", () => {
  it("is point-independent: same result regardless of user points", () => {
    // randomDrawProbability doesn't take userPoints — by design
    const p1 = randomDrawProbability(50, 1000);
    const p2 = randomDrawProbability(50, 1000);
    expect(p1).toBe(p2);
  });

  it("returns quota/applicants ratio", () => {
    expect(randomDrawProbability(100, 1000)).toBeCloseTo(0.1, 2);
    expect(randomDrawProbability(50, 500)).toBeCloseTo(0.1, 2);
  });

  it("returns 5% default for unknown applicants", () => {
    expect(randomDrawProbability(100, null)).toBe(0.05);
  });
});

describe("hybridWyDrawProbability", () => {
  it("blends 75% preference + 25% random", () => {
    // User above pref cutoff → high pref component
    // Random portion adds a bit on top
    const p = hybridWyDrawProbability(15, 100, 1000, 12);
    const prefOnly = preferenceDrawProbability(15, 12);
    const randomOnly = randomDrawProbability(100, 1000);
    const blended = 0.75 * prefOnly + 0.25 * randomOnly;
    expect(p).toBeCloseTo(blended, 5);
  });
});

describe("computeDrawProbability", () => {
  it("returns NV squared-bonus result for NV input", () => {
    const result = computeDrawProbability({
      stateCode: "NV",
      userPoints: 7,
      quota: 50,
      totalApplicants: 2000,
    });
    expect(result.system).toBe("squared_bonus");
    expect(result.probability).toBeGreaterThan(0);
    expect(result.basis).toContain("squared-bonus");
    expect(result.basis).toContain("names in the hat");
  });

  it("returns NM random result point-independent", () => {
    const r5 = computeDrawProbability({
      stateCode: "NM",
      userPoints: 0,
      quota: 10,
      totalApplicants: 100,
    });
    const r10 = computeDrawProbability({
      stateCode: "NM",
      userPoints: 20,
      quota: 10,
      totalApplicants: 100,
    });
    // Random system — same probability regardless of points
    expect(r5.probability).toBe(r10.probability);
    expect(r5.basis).toContain("pure random");
  });

  it("attaches confidence level appropriately", () => {
    const high = computeDrawProbability({
      stateCode: "CO",
      userPoints: 8,
      drawnAtMinPoints: 7,
    });
    expect(high.confidence).toBe("high");

    const low = computeDrawProbability({
      stateCode: "CO",
      userPoints: 8,
      // No drawnAtMinPoints data
    });
    expect(low.confidence).toBe("low");
  });

  it("clamps probability to [0, 1]", () => {
    const result = computeDrawProbability({
      stateCode: "NV",
      userPoints: 100,
      quota: 1000,
      totalApplicants: 10,
    });
    expect(result.probability).toBeGreaterThanOrEqual(0);
    expect(result.probability).toBeLessThanOrEqual(1);
  });
});
