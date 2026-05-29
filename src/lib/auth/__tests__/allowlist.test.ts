import { describe, it, expect } from "vitest";
import { isEmailAllowed, parseEmailList } from "../allowlist";

describe("parseEmailList", () => {
  it("normalizes, trims, lowercases, and drops blanks", () => {
    const set = parseEmailList(" A@x.com, b@x.com ,,  C@X.com ");
    expect([...set].sort()).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
  });

  it("returns an empty set for undefined/empty", () => {
    expect(parseEmailList(undefined).size).toBe(0);
    expect(parseEmailList("").size).toBe(0);
    expect(parseEmailList("   ").size).toBe(0);
  });
});

describe("isEmailAllowed", () => {
  it("allows anyone when no allowlist is configured (open beta)", () => {
    expect(isEmailAllowed("random@person.com", "", "")).toBe(true);
    expect(isEmailAllowed("random@person.com", undefined, undefined)).toBe(true);
  });

  it("allows only listed emails when allowlist is set", () => {
    const allow = "mitch@recademics.com, mitch.strobl1@gmail.com";
    expect(isEmailAllowed("mitch.strobl1@gmail.com", allow, "")).toBe(true);
    expect(isEmailAllowed("nope@stranger.com", allow, "")).toBe(false);
  });

  it("is case- and whitespace-insensitive", () => {
    const allow = "Mitch.Strobl1@Gmail.com";
    expect(isEmailAllowed("  mitch.strobl1@gmail.com ", allow, "")).toBe(true);
  });

  it("always lets admins through even if not in the allowlist", () => {
    const allow = "someone@beta.com";
    const admins = "owner@huntlogic.ai";
    expect(isEmailAllowed("owner@huntlogic.ai", allow, admins)).toBe(true);
  });
});
