// Pure-function smoke tests for the Stripe service helpers. These do NOT
// hit the Stripe API — they exist to catch regressions on the
// non-network-dependent parts of the checkout path.

import { describe, it, expect } from "vitest";

// We have to import the helpers individually so the module's eager
// Stripe client init (which reads STRIPE_SECRET_KEY from env) doesn't
// fire during test collection.
import {
  generateOrderNumber,
  buildCheckoutUrls,
} from "../index";

describe("generateOrderNumber", () => {
  it("matches the HL-YYYY-NNNNN format", () => {
    const n = generateOrderNumber();
    expect(n).toMatch(/^HL-\d{4}-\d{5}$/);
  });

  it("embeds the current year", () => {
    const n = generateOrderNumber();
    const year = new Date().getFullYear().toString();
    expect(n.startsWith(`HL-${year}-`)).toBe(true);
  });

  it("produces distinct numbers across multiple calls (collision-rare)", () => {
    // 100 random 5-digit numbers should not all be the same. This is a
    // sanity check on the random generation; collisions are still possible
    // and the caller is responsible for handling them at write time.
    const numbers = new Set<string>();
    for (let i = 0; i < 100; i++) {
      numbers.add(generateOrderNumber());
    }
    // We expect at least 90 distinct values out of 100 (margin for chance).
    expect(numbers.size).toBeGreaterThan(90);
  });
});

describe("buildCheckoutUrls", () => {
  it("builds success + cancel URLs from app.url config", () => {
    const urls = buildCheckoutUrls("order-abc-123");
    expect(urls.successUrl).toMatch(/\/orders\/success\?orderId=order-abc-123$/);
    expect(urls.cancelUrl).toMatch(/\/orders\/cancelled\?orderId=order-abc-123$/);
  });

  it("URL-encodes nothing surprising in a UUID-shaped order id", () => {
    const urls = buildCheckoutUrls(
      "ad8c8e6e-1a2b-4c5d-9e0f-aabbccddeeff",
    );
    expect(urls.successUrl).toContain(
      "orderId=ad8c8e6e-1a2b-4c5d-9e0f-aabbccddeeff",
    );
  });
});
