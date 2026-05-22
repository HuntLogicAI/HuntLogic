# Auto-Apply / Concierge Checkout Audit

**As of:** May 21, 2026
**Status:** Code path exists end-to-end but has **never been tested with a real Stripe charge**. Do not expose to additional surfaces until the manual test runbook below has been completed.

---

## What's built

### Database (already migrated)

- `application_orders` — parent order (one per checkout)
- `application_order_items` — individual applications within an order
- `payments` — Stripe payment records
- `refunds` — refund tracking
- `state_fee_schedules` — per-state per-species per-year fees
- `service_fee_config` — HuntLogic's service fees per tier
- `state_form_configs` — dynamic form schemas (per state/species/year)
- `fulfillment_logs` — ops audit trail
- `opsUsers` — internal ops team accounts

### API routes (already deployed)

**Customer-facing (`/api/v1/concierge/orders/*`):**
- `GET /` — list user's orders
- `POST /` — create draft order
- `GET /[orderId]` — read order detail
- `GET /[orderId]/status` — current state of order
- `POST /[orderId]/items` — add item (recommendation) to order
- `DELETE /[orderId]/items/[itemId]` — remove item
- `POST /[orderId]/checkout` — create Stripe Checkout Session
- `POST /[orderId]/link-credentials` — link state agency creds for the order

**Ops-facing (`/api/v1/ops/orders/*`):**
- `GET /` — queue view
- `GET /[orderId]` — order detail with items + logs
- `POST /[orderId]/assign` — assign to an ops user
- `PATCH /[orderId]/items/[itemId]` — update item status (queued → in_progress → submitted)
- `POST /[orderId]/items/[itemId]/log` — append fulfillment log entry
- `POST /[orderId]/items/[itemId]/refund` — initiate Stripe refund

**Stripe webhook (`/api/webhooks/stripe`):**
Handles 5 event types: `checkout.session.completed`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`.

### UI

- `/orders` — list page
- `/orders/cart` — cart with line items, residency picker, total, "Pay now" button (921 LOC — substantial)
- `/orders/[orderId]` — order detail with item status (464 LOC)
- `/orders/success` — Stripe success redirect target
- `/orders/cancelled` — Stripe cancel redirect target
- `Apply For Me` button on `RecommendationCard` (wired only from `/recommendations` so far)

---

## Gaps + risks identified during audit

### 🔴 Critical (block production exposure)

1. **Fulfillment never enqueues a job** — `handleCheckoutSessionCompleted` at `src/app/api/webhooks/stripe/route.ts:218` logs `"fulfillment queued"` but actually does nothing. Comment reads: *"In production this would enqueue a BullMQ job; for now we log it."* **Without an actual queue, ops users must poll `/api/v1/ops/orders` to find paid orders to work on.**

2. **End-to-end flow has never been tested with a real Stripe transaction.** The signature verification path, idempotency on retried webhooks, and the cart UI's interaction with the API have not been validated.

3. **No state fee data is seeded.** The cart total depends on `application_order_items.state_fee` and `service_fee`, which depend on the (unseeded?) `state_fee_schedules` and `service_fee_config` tables. **A zero-total cart is rejected at checkout, so the flow may fail at "Pay now" with an unhelpful error.** Confirmed by checkout route logic (`src/app/api/v1/concierge/orders/[orderId]/checkout/route.ts:119`).

4. **No "test mode" indicator on orders.** When Stripe is in test mode, orders look identical to real orders — ops could attempt to fulfill a test order. Recommend adding an `is_test_mode` field or label.

### 🟡 Medium (should fix before scaling)

5. **`disputed` status not in original schema enum.** Webhook writes `"disputed" as string` at `route.ts:529`. Schema comment updated in this PR but no DB constraint enforces it. Ops queries filtering by status need to include this value.

6. **No idempotency keys on Stripe API calls.** `stripe.checkout.sessions.create` and `stripe.refunds.create` can race-create duplicates if the client retries. Add idempotency keys derived from `orderId` + action.

7. **Webhook returns 200 on internal errors.** Intentional to prevent Stripe retries, but masks failures. Add: a `webhook_event_log` table or at minimum a Sentry/PostHog event so silent failures are visible.

8. **`stripePaymentIntentId` is stored as `null` on checkout creation** (`route.ts:143`). Stripe Checkout Sessions don't have a payment_intent until they complete; the field is updated later from the webhook. Not incorrect, but the order shows a misleading "pending" state with no PI for the user's reference.

9. **No automatic tax handling.** Stripe Checkout supports `automatic_tax: { enabled: true }`. Should add if you'll be charging sales tax on the service fee.

### 🟢 Minor (polish)

10. **`Apply For Me` only wired into `/recommendations`** — not into `/playbook` or `/profile/strategy`. **Deliberately NOT shipped in this PR** until the end-to-end flow is verified.

11. **No way for ops to see the original recommendation context.** `application_order_items.recommendation_id` is set, but ops UI doesn't expand it to show "user picked this because: [scoring factors]".

12. **No "ready to apply" preflight check.** A user could checkout for a hunt whose application window already closed. Add a per-item validation that the deadline is in the future.

13. **Refund partial-vs-full status tracking** — when a partial refund happens, payment status becomes `"partially_refunded"` but order status stays `"paid"`. May want a `partial_refund` order status.

---

## Manual test runbook

**Prereqs (set once):**

1. **Stripe test mode** keys in Vercel:
   ```
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_WEBHOOK_SECRET=whsec_...        # from Stripe Dashboard → Webhooks
   NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
   ```
2. **Stripe CLI** for local webhook forwarding (only needed for local testing):
   ```bash
   brew install stripe/stripe-cli/stripe
   stripe login
   stripe listen --forward-to https://huntlogic.vercel.app/api/webhooks/stripe
   ```
3. **Seed at least one state_fee_schedule row** so the cart total isn't zero. (Future PR: seed all states.)

**Test 1 — Happy path (test card 4242 4242 4242 4242):**

1. Sign in as a real (non-admin) test user.
2. Open `/recommendations`, click **Apply For Me** on any recommendation.
3. Land on `/orders/cart`. Verify:
   - Line items list the picked hunt with state name + species name.
   - Total > $0.
   - Residency selector defaults to `nonresident`.
4. Click **Pay now**. Verify redirect to `checkout.stripe.com`.
5. Enter test card `4242 4242 4242 4242`, any future expiry, any CVC.
6. Submit. Verify:
   - Redirect to `/orders/success?orderId=...&session_id=...`
   - Within 30 seconds, the order detail page shows status `paid`.
   - In Stripe Dashboard → Webhooks, verify the `checkout.session.completed` event was delivered with HTTP 200.
   - DB check: `application_orders.status = 'paid'`, `payments` row created, `application_order_items.status = 'queued'`, `fulfillment_logs` has a `payment_received` row.
7. **Notification check:** verify the user received an in-app + email notification ("Payment Confirmed").

**Test 2 — Cancelled checkout:**

1. From cart, click **Pay now**.
2. On Stripe Checkout, click the back arrow.
3. Verify redirect to `/orders/cancelled?orderId=...` and order status remains `pending_payment`.
4. Verify user can return to `/orders/[orderId]`, edit items, and re-checkout.

**Test 3 — Declined card (test card 4000 0000 0000 0002):**

1. From cart, click **Pay now**.
2. On Stripe Checkout, enter card `4000 0000 0000 0002` (always declined).
3. Verify error shown by Stripe.
4. Verify `payment_intent.payment_failed` event delivered to webhook.
5. Verify `application_orders.status = 'cancelled'` and a `payment_failed` notification fired.

**Test 4 — Refund (ops flow):**

1. From an `is_test_mode` paid order, call `POST /api/v1/ops/orders/[orderId]/items/[itemId]/refund` with `{ amount: <full> }`.
2. Verify Stripe Dashboard shows the refund.
3. Verify `charge.refunded` webhook fires and creates a `refunds` row.
4. Verify `payments.status = 'refunded'` and `application_orders.status = 'refunded'`.

**Test 5 — Webhook signature mismatch:**

1. `curl -X POST` to `/api/webhooks/stripe` with a body but no `stripe-signature` header.
2. Verify HTTP 400 with "Missing stripe-signature header".
3. `curl -X POST` with a bogus signature header.
4. Verify HTTP 400 with "Webhook signature verification failed: ...".

**Test 6 — Webhook idempotency:**

1. After a successful payment, manually re-fire the `checkout.session.completed` event from Stripe Dashboard → Webhooks → Event detail → Resend.
2. Verify the second invocation logs `"Order ... already in status 'paid', skipping"` and does NOT create a duplicate payment row.

---

## Recommended order of operations to go live

1. ✅ Apply this PR (audit + smoke tests + schema comment fix).
2. **Seed `state_fee_schedules` and `service_fee_config`** so carts have non-zero totals.
3. **Run the 6-step test runbook above** in Stripe test mode.
4. **Wire the actual fulfillment queue** — replace the `console.log` at `route.ts:218-223` with a BullMQ job. The job processor lives in the existing `src/services/ingestion/workers/` pattern.
5. **Add ops UI in `/admin/orders` or `/ops/orders`** — currently only API routes exist; ops users have no in-app view to work the queue.
6. **Only then** wire `Apply For Me` into `/playbook` and `/profile/strategy`.

---

## What this PR ships

- This document.
- Schema comment fix for `disputed` status.
- Unit tests for `generateOrderNumber` (format) and `buildCheckoutUrls` (URL construction).
- A `tests/auto-apply-state-machine.test.ts` that exercises the webhook idempotency check logic in isolation (no Stripe API calls).

**What this PR explicitly does NOT do:**

- No new activation surfaces (Playbook, Annual Strategy).
- No live Stripe integration tests.
- No fulfillment queue implementation.
- No ops UI.
