// Webhook idempotency smoke test.
//
// Stripe retries webhooks aggressively on non-2xx, and even on 2xx can
// re-fire the same event (delivery attempt 2, 3, ...). The webhook
// handler must be safe to invoke twice with the same event.
//
// This test models the small piece of decision logic that lives inside
// handleCheckoutSessionCompleted: "if order status is already 'paid' or
// 'in_progress', skip." It's deliberately a unit test on the predicate
// rather than a full integration test — the latter requires Drizzle +
// Stripe SDK mocking, which is out of scope for this PR. See
// docs/AUTO_APPLY_AUDIT.md "Test 6" for the end-to-end variant.

import { describe, it, expect } from "vitest";

/**
 * Mirror of the in-handler idempotency check at:
 *   src/app/api/webhooks/stripe/route.ts:146
 *
 * Exposed as a pure function here so we can lock it down with tests
 * without spinning up the full webhook handler.
 */
function shouldSkipDuplicateCheckout(orderStatus: string): boolean {
  return orderStatus === "paid" || orderStatus === "in_progress";
}

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

/**
 * Mirror of the partial-vs-full refund predicate at:
 *   src/app/api/webhooks/stripe/route.ts:455
 */
function isFullRefund(args: {
  refunded: boolean;
  amountRefunded: number;
  amount: number;
}): boolean {
  return args.refunded && args.amountRefunded === args.amount;
}

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

/**
 * Mirror of the checkout precondition at:
 *   src/app/api/v1/concierge/orders/[orderId]/checkout/route.ts:48
 *
 * Only draft orders can be checked out — protects against double-charging
 * the same order after a successful payment.
 */
function canCheckout(orderStatus: string): boolean {
  return orderStatus === "draft";
}

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
