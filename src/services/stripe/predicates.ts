// =============================================================================
// Webhook + checkout decision predicates
// =============================================================================
// These pure-function predicates are the decision points the Stripe webhook
// and checkout route use to decide whether to act on an event. They live
// here (rather than inline in the route files) so that unit tests can
// exercise the same code the production handlers run — review feedback on
// PR #22 flagged that the previous tests reimplemented these predicates
// inside the test file, which meant the tests could stay green while the
// production code drifted.
//
// Keep this file pure: no DB, no Stripe API, no auth — just decisions
// derived from already-fetched state.
// =============================================================================

/**
 * Should this `checkout.session.completed` webhook delivery be skipped
 * because the order has already advanced past the payment-received state?
 *
 * Stripe retries webhooks aggressively. The handler MUST be safe to invoke
 * twice with the same event. We treat 'paid' and 'in_progress' as terminal-
 * for-this-purpose: don't re-record payment, don't re-queue fulfillment.
 *
 * Used in: src/app/api/webhooks/stripe/route.ts (handleCheckoutSessionCompleted)
 */
export function shouldSkipDuplicateCheckout(orderStatus: string): boolean {
  return orderStatus === "paid" || orderStatus === "in_progress";
}

/**
 * Given a `charge.refunded` payload, is this a full or partial refund?
 *
 * Defensive: requires BOTH the `refunded` boolean from Stripe AND the
 * amounts to match. If Stripe says refunded=false we treat it as partial
 * regardless of the amounts (this protects against transient state where
 * the refund flag hasn't caught up yet).
 *
 * Used in: src/app/api/webhooks/stripe/route.ts (handleChargeRefunded)
 */
export function isFullRefund(args: {
  refunded: boolean;
  amountRefunded: number;
  amount: number;
}): boolean {
  return args.refunded && args.amountRefunded === args.amount;
}

/**
 * Can this order start a Stripe Checkout session right now?
 *
 * Only 'draft' orders are eligible. Any other status means the order is
 * already mid-flight (pending_payment, paid, in_progress, ...) or
 * terminal (cancelled, refunded, disputed). Re-checking out a non-draft
 * order would double-charge the user.
 *
 * Used in: src/app/api/v1/concierge/orders/[orderId]/checkout/route.ts
 */
export function canCheckout(orderStatus: string): boolean {
  return orderStatus === "draft";
}
