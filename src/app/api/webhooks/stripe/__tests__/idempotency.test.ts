// Webhook + checkout decision-point regression tests.
//
// Stripe retries webhooks aggressively on non-2xx, and even on 2xx can
// re-fire the same event (delivery attempt 2, 3, ...). The handler must
// be safe to invoke twice with the same event.
//
// Review feedback on PR #22: an earlier version of this file
// reimplemented `shouldSkipDuplicateCheckout`, `isFullRefund`, and
// `canCheckout` *inside the test file*, which meant the tests could
// stay green while the production code drifted. Fixed by extracting
// those predicates into `services/stripe/predicates.ts` and importing
// them here — the webhook (`route.ts`) and checkout route
// (`concierge/orders/[orderId]/checkout/route.ts`) both call the same
// exported functions, so any drift in behavior is caught by this suite.

import { describe, it, expect } from "vitest";
import {
  shouldSkipDuplicateCheckout,
  isFullRefund,
  canCheckout,
} from "@/services/stripe/predicates";

describe("checkout.session.completed idempotency", () => {
  it("skips when order is already paid", () => {
    expect(shouldSkipDuplicateCheckout("paid")).toBe(true);
  });

  it("skips when order is in_progress (ops has started)", () => {
    expect(shouldSkipDuplicateCheckout("in_progress")).toBe(true);
  });

  it("processes when order is pending_payment (first delivery)", () => {
    expect(shouldSkipDuplicateCheckout("pending_payment")).toBe(false);
  });

  it("processes when order is draft (degenerate but possible)", () => {
    expect(shouldSkipDuplicateCheckout("draft")).toBe(false);
  });

  it("processes when order is cancelled (rescue path: re-paying a cancelled order)", () => {
    // If a user managed to re-checkout a cancelled order, the webhook
    // should still process. The handler then moves it back to 'paid'.
    expect(shouldSkipDuplicateCheckout("cancelled")).toBe(false);
  });

  it("processes when order has the new 'disputed' status", () => {
    // 'disputed' is set by charge.dispute.created. A retried checkout
    // event after a dispute is unusual but shouldn't be silently dropped.
    expect(shouldSkipDuplicateCheckout("disputed")).toBe(false);
  });
});

describe("charge.refunded full-vs-partial", () => {
  it("flags as full when refunded=true AND amounts equal", () => {
    expect(isFullRefund({ refunded: true, amountRefunded: 10000, amount: 10000 })).toBe(true);
  });

  it("flags as partial when refunded=true but amount_refunded < amount", () => {
    expect(isFullRefund({ refunded: true, amountRefunded: 5000, amount: 10000 })).toBe(false);
  });

  it("flags as partial when refunded=false even with matching amounts", () => {
    // Edge case: defensive — if Stripe says refunded=false we treat as partial.
    expect(isFullRefund({ refunded: false, amountRefunded: 10000, amount: 10000 })).toBe(false);
  });
});

describe("checkout precondition", () => {
  it("allows draft orders", () => {
    expect(canCheckout("draft")).toBe(true);
  });
  it.each([
    "pending_payment",
    "paid",
    "in_progress",
    "submitted",
    "completed",
    "cancelled",
    "refunded",
    "disputed",
  ])("rejects status=%s", (status) => {
    expect(canCheckout(status)).toBe(false);
  });
});
