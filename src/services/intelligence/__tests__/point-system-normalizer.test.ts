import { describe, it, expect } from "vitest";
import {
  getPointSystemRule,
  effectivePoints,
  computeNormalizedPointsFields,
} from "../point-system-normalizer";

describe("point-system-normalizer", () => {
  describe("getPointSystemRule", () => {
    it("maps CO to pure_preference", () => {
      expect(getPointSystemRule("CO", "elk").type).toBe("pure_preference");
    });

    it("maps NV to bonus_squared", () => {
      expect(getPointSystemRule("NV", "elk").type).toBe("bonus_squared");
    });

    it("maps AZ to bonus with loyalty cap", () => {
      const rule = getPointSystemRule("AZ", "elk");
      expect(rule.type).toBe("bonus");
      expect(rule.loyaltyBonusCap).toBe(5);
    });

    it("maps UT to weighted_preference (50/50)", () => {
      const rule = getPointSystemRule("UT", "mule_deer");
      expect(rule.type).toBe("weighted_preference");
      expect(rule.randomShare).toBe(0.5);
    });

    it("maps NM to random", () => {
      expect(getPointSystemRule("NM", "elk").type).toBe("random");
    });

    it("maps ID to random", () => {
      expect(getPointSystemRule("ID", "elk").type).toBe("random");
    });

    it("returns 'none' for unknown states", () => {
      expect(getPointSystemRule("ZZ", "elk").type).toBe("none");
    });

    it("is case-insensitive on state codes", () => {
      expect(getPointSystemRule("co", "elk").type).toBe("pure_preference");
      expect(getPointSystemRule("nv", null).type).toBe("bonus_squared");
    });
  });

  describe("effectivePoints", () => {
    it("returns null for null/undefined inputs", () => {
      expect(effectivePoints({ type: "pure_preference" }, null)).toBeNull();
      expect(effectivePoints({ type: "pure_preference" }, undefined)).toBeNull();
    });

    it("returns null for negative inputs", () => {
      expect(effectivePoints({ type: "pure_preference" }, -1)).toBeNull();
    });

    it("returns raw points for pure_preference", () => {
      expect(effectivePoints({ type: "pure_preference" }, 7)).toBe(7);
      expect(effectivePoints({ type: "pure_preference" }, 0)).toBe(0);
    });

    it("clamps bonus points to loyalty cap", () => {
      expect(effectivePoints({ type: "bonus", loyaltyBonusCap: 5 }, 3)).toBe(3);
      expect(effectivePoints({ type: "bonus", loyaltyBonusCap: 5 }, 8)).toBe(5);
    });

    it("squares for bonus_squared", () => {
      expect(effectivePoints({ type: "bonus_squared" }, 0)).toBe(0);
      expect(effectivePoints({ type: "bonus_squared" }, 6)).toBe(36);
      expect(effectivePoints({ type: "bonus_squared" }, 10)).toBe(100);
    });

    it("scales for weighted_preference", () => {
      expect(
        effectivePoints({ type: "weighted_preference", randomShare: 0.5 }, 4)
      ).toBe(2);
      expect(
        effectivePoints({ type: "weighted_preference", randomShare: 0.3 }, 10)
      ).toBe(7);
    });

    it("returns null for random/none", () => {
      expect(effectivePoints({ type: "random" }, 5)).toBeNull();
      expect(effectivePoints({ type: "none" }, 5)).toBeNull();
    });
  });

  describe("computeNormalizedPointsFields", () => {
    it("packages both fields for CO elk", () => {
      expect(computeNormalizedPointsFields("CO", "elk", 8)).toEqual({
        pointSystemType: "pure_preference",
        effectivePoints: 8,
      });
    });

    it("packages bonus_squared math for NV mule deer", () => {
      expect(computeNormalizedPointsFields("NV", "mule_deer", 6)).toEqual({
        pointSystemType: "bonus_squared",
        effectivePoints: 36,
      });
    });

    it("packages random with null effective points for ID", () => {
      expect(computeNormalizedPointsFields("ID", "elk", 0)).toEqual({
        pointSystemType: "random",
        effectivePoints: null,
      });
    });

    it("packages weighted half for UT", () => {
      expect(computeNormalizedPointsFields("UT", "elk", 4)).toEqual({
        pointSystemType: "weighted_preference",
        effectivePoints: 2,
      });
    });
  });
});
