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

describe("squaredBonusDrawProbability", () => {
  it("returns higher probability with more points (other things equal)", () => {
    const p5 = squaredBonusDrawProbability(5, 100, 5000);
    const p10 = squaredBonusDrawProbability(10, 100, 5000);
    expect(p10).toBeGreaterThan(p5);
  });

  it("returns near-zero when user is well below observed minPoints", () => {
    // Hunter at 3 points, but observed cutoff was 12 points
    const p = squaredBonusDrawProbability(3, 100, 5000, 12);
    expect(p).toBeLessThan(0.05);
  });

  it("returns reasonable probability when at observed minPoints", () => {
    const p = squaredBonusDrawProbability(12, 100, 5000, 12);
    expect(p).toBeGreaterThan(0.01);
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
    expect(result.basis).toContain("squared bonus");
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
