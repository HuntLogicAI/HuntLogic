import { describe, it, expect } from "vitest";
import {
  hashContent,
  canonicalizeText,
  diffExtractedRules,
  classifyDiff,
  summarizeDiff,
} from "../snapshot-service";

describe("snapshot-service", () => {
  describe("hashContent", () => {
    it("produces stable SHA-256 for identical inputs", () => {
      expect(hashContent("hello")).toEqual(hashContent("hello"));
    });

    it("produces different hashes for different inputs", () => {
      expect(hashContent("a")).not.toEqual(hashContent("b"));
    });

    it("returns a 64-char hex string", () => {
      expect(hashContent("anything").length).toBe(64);
      expect(hashContent("anything")).toMatch(/^[0-9a-f]+$/);
    });
  });

  describe("canonicalizeText", () => {
    it("strips trailing whitespace", () => {
      expect(canonicalizeText("hello   \n  ")).toBe("hello");
    });

    it("normalizes CRLF to LF", () => {
      expect(canonicalizeText("a\r\nb")).toBe("a\nb");
    });

    it("collapses tabs/spaces", () => {
      expect(canonicalizeText("a\t\t b")).toBe("a b");
    });

    it("strips page headers", () => {
      expect(canonicalizeText("text\nPage 12 of 47\nmore")).toBe("text\nmore");
    });

    it("strips last-updated stamps", () => {
      expect(canonicalizeText("hello Last updated 2025-09-12 world")).toBe(
        "hello  world"
      );
    });

    it("strips printed-on stamps", () => {
      expect(canonicalizeText("foo Printed on 9/12/2025 bar")).toBe("foo  bar");
    });
  });

  describe("diffExtractedRules", () => {
    it("returns empty when objects are equal", () => {
      expect(diffExtractedRules({ a: 1 }, { a: 1 })).toEqual([]);
    });

    it("flags top-level value changes", () => {
      const diffs = diffExtractedRules({ a: 1 }, { a: 2 });
      expect(diffs).toHaveLength(1);
      expect(diffs[0]?.fieldPath).toBe("a");
      expect(diffs[0]?.oldValue).toBe(1);
      expect(diffs[0]?.newValue).toBe(2);
    });

    it("recurses into nested objects", () => {
      const diffs = diffExtractedRules(
        { quotas: { unit_12: { rifle: 100 } } },
        { quotas: { unit_12: { rifle: 70 } } }
      );
      expect(diffs).toHaveLength(1);
      expect(diffs[0]?.fieldPath).toBe("quotas.unit_12.rifle");
    });

    it("handles added and removed keys", () => {
      const diffs = diffExtractedRules({ a: 1 }, { b: 2 });
      expect(diffs).toHaveLength(2);
      const paths = diffs.map((d) => d.fieldPath).sort();
      expect(paths).toEqual(["a", "b"]);
    });

    it("treats arrays as opaque values (deep equality via JSON)", () => {
      const diffs = diffExtractedRules(
        { units: [1, 2, 3] },
        { units: [1, 2, 4] }
      );
      expect(diffs).toHaveLength(1);
      expect(diffs[0]?.fieldPath).toBe("units");
    });
  });

  describe("classifyDiff", () => {
    it("flags a 30% quota cut as critical", () => {
      const { changeType, severity } = classifyDiff(
        "quotas.unit_12.rifle",
        100,
        70
      );
      expect(changeType).toBe("quota_change");
      expect(severity).toBe("critical");
    });

    it("flags a 10% quota change as high", () => {
      const { severity } = classifyDiff("quotas.unit_5", 100, 88);
      expect(severity).toBe("high");
    });

    it("flags a small quota change as medium", () => {
      const { severity } = classifyDiff("quotas.unit_5", 100, 97);
      expect(severity).toBe("medium");
    });

    it("flags season date changes as high", () => {
      expect(classifyDiff("seasons.rifle.startDate", "2025-10-12", "2025-10-19").severity).toBe(
        "high"
      );
    });

    it("flags deadline changes as critical", () => {
      expect(classifyDiff("application_deadline", "2026-05-31", "2026-05-15").severity).toBe(
        "critical"
      );
    });

    it("flags fee changes as medium", () => {
      expect(classifyDiff("fees.nr_elk", 685, 720).severity).toBe("medium");
    });

    it("falls back to 'other' for unknown paths", () => {
      const r = classifyDiff("misc.unknown_field", 1, 2);
      expect(r.changeType).toBe("other");
      expect(r.severity).toBe("low");
    });
  });

  describe("summarizeDiff", () => {
    it("formats added values", () => {
      expect(summarizeDiff("a", undefined, 5)).toBe("a: (none) → 5");
    });

    it("formats removed values", () => {
      expect(summarizeDiff("a", 5, undefined)).toBe("a: 5 → (removed)");
    });

    it("formats changed values", () => {
      expect(summarizeDiff("quotas.u12", 100, 70)).toBe("quotas.u12: 100 → 70");
    });
  });
});
