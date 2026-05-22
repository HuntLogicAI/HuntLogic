// =============================================================================
// Stripe Webhook Handler — /api/webhooks/stripe
// =============================================================================
// Receives Stripe events (checkout, payment, refund, dispute) and updates
// the corresponding applicationOrders, payments, and refunds records.
// =============================================================================

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { db } from "@/lib/db";
import {
  applicationOrders,
  applicationOrderItems,
  payments,
  refunds,
  fulfillmentLogs,
} from "@/lib/db/schema/concierge";
import { eq, and } from "drizzle-orm";
import { constructWebhookEvent } from "@/services/stripe";
import {
  shouldSkipDuplicateCheckout,
  isFullRefund as computeIsFullRefund,
} from "@/services/stripe/predicates";
import {
  notifyOrderPaid,
  notifyPaymentFailed,
  createNotification,
} from "@/services/notifications";

// -----------------------------------------------------------------------------
// POST /api/webhooks/stripe
// -----------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 }
    );
  }

  let event: Stripe.Event;

  try {
    event = constructWebhookEvent(body, signature);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[stripe-webhook] Signature verification failed:", message);
    return NextResponse.json(
      { error: `Webhook signature verification failed: ${message}` },
      { status: 400 }
    );
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutSessionCompleted(
          event.data.object as Stripe.Checkout.Session
        );
        break;

      case "payment_intent.succeeded":
        await handlePaymentIntentSucceeded(
          event.data.object as Stripe.PaymentIntent
        );
        break;

      case "payment_intent.payment_failed":
        await handlePaymentIntentFailed(
          event.data.object as Stripe.PaymentIntent
        );
        break;

      case "charge.refunded":
        await handleChargeRefunded(event.data.object as Stripe.Charge);
        break;

      case "charge.dispute.created":
        await handleDisputeCreated(event.data.object as Stripe.Dispute);
        break;

      default:
        console.log(
          `[stripe-webhook] Unhandled event type: ${event.type} (${event.id})`
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(
      `[stripe-webhook] Error handling ${event.type} (${event.id}):`,
      message
    );
    // Return 200 to prevent Stripe retries for application-level errors.
    // The error is logged for ops investigation.
    return NextResponse.json({ received: true, error: message });
  }

  return NextResponse.json({ received: true });
}

// -----------------------------------------------------------------------------
// checkout.session.completed
// Update order to 'paid', create payment record, queue fulfillment.
// -----------------------------------------------------------------------------

async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session
) {
  const orderId = session.metadata?.orderId;
  if (!orderId) {
    console.warn(
      "[stripe-webhook] checkout.session.completed missing orderId in metadata"
    );
    return;
  }

  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id;

  if (!paymentIntentId) {
    console.warn(
      "[stripe-webhook] checkout.session.completed missing payment_intent"
    );
    return;
  }

  // Look up the order
  const [order] = await db
    .select()
    .from(applicationOrders)
    .where(eq(applicationOrders.id, orderId))
    .limit(1);

  if (!order) {
    console.error(
      `[stripe-webhook] Order not found for checkout session: ${orderId}`
    );
    return;
  }

  // Idempotency: skip if already paid. The predicate lives in
  // services/stripe/predicates.ts so the unit tests in
  // app/api/webhooks/stripe/__tests__ exercise the same code.
  if (shouldSkipDuplicateCheckout(order.status)) {
    console.log(
      `[stripe-webhook] Order ${orderId} already in status '${order.status}', skipping`
    );
    return;
  }

  const now = new Date();

  // Update order status to 'paid' and store the payment intent ID
  await db
    .update(applicationOrders)
    .set({
      status: "paid",
      stripePaymentIntentId: paymentIntentId,
      metadata: {
        ...(order.metadata as Record<string, unknown>),
        stripeCheckoutSessionId: session.id,
        paidVia: "checkout",
      },
      updatedAt: now,
    })
    .where(eq(applicationOrders.id, orderId));

  // Create payment record
  const amountTotal = session.amount_total ?? 0;
  const currency = session.currency ?? "usd";

  await db.insert(payments).values({
    orderId: order.id,
    userId: order.userId,
    stripePaymentIntentId: paymentIntentId,
    amount: (amountTotal / 100).toFixed(2),
    currency,
    status: "succeeded",
    paymentMethod: "card",
    paidAt: now,
    metadata: {
      checkoutSessionId: session.id,
      orderNumber: session.metadata?.orderNumber,
    },
  });

  // Transition all order items from "pending" to "queued" so ops can start
  await db
    .update(applicationOrderItems)
    .set({
      status: "queued",
      updatedAt: now,
    })
    .where(
      and(
        eq(applicationOrderItems.orderId, orderId),
        eq(applicationOrderItems.status, "pending")
      )
    );

  // Insert fulfillment log entry for the payment transition
  await db.insert(fulfillmentLogs).values({
    orderId,
    action: "payment_received",
    fromStatus: "pending_payment",
    toStatus: "paid",
    details: `Payment received via Stripe checkout. Amount: ${currency.toUpperCase()} ${(amountTotal / 100).toFixed(2)}`,
    metadata: {
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: paymentIntentId,
      amount: (amountTotal / 100).toFixed(2),
      currency,
    },
  });

  // Queue fulfillment — push an event to the fulfillment pipeline.
  // In production this would enqueue a BullMQ job; for now we log it.
  console.log(
    `[stripe-webhook] Order ${orderId} paid — fulfillment queued. ` +
      `Amount: ${currency.toUpperCase()} ${(amountTotal / 100).toFixed(2)}`
  );

  // Notify the customer that payment was received
  const orderNumber =
    session.metadata?.orderNumber ?? orderId;
  const formattedAmount = (amountTotal / 100).toFixed(2);

  notifyOrderPaid(order.userId, orderId, orderNumber, formattedAmount).catch(
    (err) => {
      console.error(
        `[stripe-webhook] Failed to send order_paid notification for ${orderId}:`,
        err
      );
    }
  );
}

// -----------------------------------------------------------------------------
// payment_intent.succeeded
// Confirm payment status on the payment record.
// -----------------------------------------------------------------------------

async function handlePaymentIntentSucceeded(
  paymentIntent: Stripe.PaymentIntent
) {
  const orderId = paymentIntent.metadata?.orderId;

  // Update existing payment record if one exists
  const [existingPayment] = await db
    .select()
    .from(payments)
    .where(eq(payments.stripePaymentIntentId, paymentIntent.id))
    .limit(1);

  if (existingPayment) {
    // Payment already recorded (likely from checkout.session.completed), just confirm
    if (existingPayment.status !== "succeeded") {
      await db
        .update(payments)
        .set({
          status: "succeeded",
          paidAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(payments.id, existingPayment.id));
    }
    return;
  }

  // If no payment record exists yet and we have an orderId, create one
  if (orderId) {
    const [order] = await db
      .select()
      .from(applicationOrders)
      .where(eq(applicationOrders.id, orderId))
      .limit(1);

    if (order) {
      const now = new Date();
      await db.insert(payments).values({
        orderId: order.id,
        userId: order.userId,
        stripePaymentIntentId: paymentIntent.id,
        amount: (paymentIntent.amount / 100).toFixed(2),
        currency: paymentIntent.currency,
        status: "succeeded",
        paymentMethod: "card",
        paidAt: now,
        metadata: {
          source: "payment_intent.succeeded",
        },
      });

      // Ensure order is marked paid
      if (
        order.status !== "paid" &&
        order.status !== "in_progress" &&
        order.status !== "submitted" &&
        order.status !== "completed"
      ) {
        await db
          .update(applicationOrders)
          .set({
            status: "paid",
            stripePaymentIntentId: paymentIntent.id,
            updatedAt: now,
          })
          .where(eq(applicationOrders.id, orderId));
      }
    }
  }

  console.log(
    `[stripe-webhook] payment_intent.succeeded: ${paymentIntent.id}`
  );
}

// -----------------------------------------------------------------------------
// payment_intent.payment_failed
// Mark order failed, notify customer.
// -----------------------------------------------------------------------------

async function handlePaymentIntentFailed(paymentIntent: Stripe.PaymentIntent) {
  const orderId = paymentIntent.metadata?.orderId;

  // Update payment record if exists
  const [existingPayment] = await db
    .select()
    .from(payments)
    .where(eq(payments.stripePaymentIntentId, paymentIntent.id))
    .limit(1);

  const lastError = paymentIntent.last_payment_error;
  const failureCode = lastError?.code ?? null;
  const failureMessage = lastError?.message ?? null;

  if (existingPayment) {
    await db
      .update(payments)
      .set({
        status: "failed",
        failureCode,
        failureMessage,
        updatedAt: new Date(),
      })
      .where(eq(payments.id, existingPayment.id));
  }

  // Mark the order as failed
  if (orderId) {
    const [order] = await db
      .select()
      .from(applicationOrders)
      .where(eq(applicationOrders.id, orderId))
      .limit(1);

    if (order && order.status !== "paid" && order.status !== "completed") {
      await db
        .update(applicationOrders)
        .set({
          status: "cancelled",
          metadata: {
            ...(order.metadata as Record<string, unknown>),
            paymentFailure: {
              code: failureCode,
              message: failureMessage,
              at: new Date().toISOString(),
            },
          },
          updatedAt: new Date(),
        })
        .where(eq(applicationOrders.id, orderId));
    }

    // Notify customer about the payment failure
    if (order) {
      const reason = failureMessage ?? "Payment could not be processed";
      notifyPaymentFailed(order.userId, orderId, reason).catch((err) => {
        console.error(
          `[stripe-webhook] Failed to send payment_failed notification for ${orderId}:`,
          err
        );
      });
    }

    console.warn(
      `[stripe-webhook] Payment failed for order ${orderId}: ` +
        `${failureCode ?? "unknown"} — ${failureMessage ?? "no details"}`
    );
  }
}

// -----------------------------------------------------------------------------
// charge.refunded
// Create refund record, update order status.
// -----------------------------------------------------------------------------

async function handleChargeRefunded(charge: Stripe.Charge) {
  const paymentIntentId =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent?.id;

  if (!paymentIntentId) {
    console.warn("[stripe-webhook] charge.refunded missing payment_intent");
    return;
  }

  // Find the payment record
  const [paymentRecord] = await db
    .select()
    .from(payments)
    .where(eq(payments.stripePaymentIntentId, paymentIntentId))
    .limit(1);

  if (!paymentRecord) {
    console.warn(
      `[stripe-webhook] No payment record found for PI ${paymentIntentId}`
    );
    return;
  }

  // Process each refund from the charge
  const stripeRefunds = charge.refunds?.data ?? [];
  for (const stripeRefund of stripeRefunds) {
    // Idempotency: check if refund already recorded
    const [existing] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.stripeRefundId, stripeRefund.id))
      .limit(1);

    if (existing) continue;

    await db.insert(refunds).values({
      paymentId: paymentRecord.id,
      orderId: paymentRecord.orderId,
      stripeRefundId: stripeRefund.id,
      amount: ((stripeRefund.amount ?? 0) / 100).toFixed(2),
      reason: (stripeRefund.reason as string) ?? "customer_request",
      status: stripeRefund.status === "succeeded" ? "succeeded" : "pending",
      initiatedBy: "system",
      processedAt:
        stripeRefund.status === "succeeded" ? new Date() : undefined,
      metadata: {
        chargeId: charge.id,
        source: "charge.refunded",
      },
    });
  }

  // Determine if full or partial refund (predicate is in
  // services/stripe/predicates.ts so tests exercise the same logic).
  const isFullRefund = computeIsFullRefund({
    refunded: charge.refunded ?? false,
    amountRefunded: charge.amount_refunded,
    amount: charge.amount,
  });

  // Update payment status
  await db
    .update(payments)
    .set({
      status: isFullRefund ? "refunded" : "partially_refunded",
      updatedAt: new Date(),
    })
    .where(eq(payments.id, paymentRecord.id));

  // Update order status if fully refunded
  if (isFullRefund) {
    await db
      .update(applicationOrders)
      .set({
        status: "refunded",
        updatedAt: new Date(),
      })
      .where(eq(applicationOrders.id, paymentRecord.orderId));
  }

  console.log(
    `[stripe-webhook] Refund processed for PI ${paymentIntentId}: ` +
      `${isFullRefund ? "full" : "partial"} refund`
  );
}

// -----------------------------------------------------------------------------
// charge.dispute.created
// Flag order, notify ops team.
// -----------------------------------------------------------------------------

async function handleDisputeCreated(dispute: Stripe.Dispute) {
  const chargeId =
    typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;

  const paymentIntentId =
    typeof dispute.payment_intent === "string"
      ? dispute.payment_intent
      : dispute.payment_intent?.id;

  if (!paymentIntentId) {
    console.error(
      `[stripe-webhook] Dispute ${dispute.id} missing payment_intent`
    );
    return;
  }

  // Find the payment and order
  const [paymentRecord] = await db
    .select()
    .from(payments)
    .where(eq(payments.stripePaymentIntentId, paymentIntentId))
    .limit(1);

  if (!paymentRecord) {
    console.error(
      `[stripe-webhook] Dispute ${dispute.id}: no payment found for PI ${paymentIntentId}`
    );
    return;
  }

  // Flag the order as disputed
  const [order] = await db
    .select()
    .from(applicationOrders)
    .where(eq(applicationOrders.id, paymentRecord.orderId))
    .limit(1);

  if (order) {
    await db
      .update(applicationOrders)
      .set({
        status: "disputed" as string,
        metadata: {
          ...(order.metadata as Record<string, unknown>),
          dispute: {
            id: dispute.id,
            chargeId,
            reason: dispute.reason,
            amount: dispute.amount,
            currency: dispute.currency,
            createdAt: new Date().toISOString(),
          },
        },
        updatedAt: new Date(),
      })
      .where(eq(applicationOrders.id, paymentRecord.orderId));

    // Notify the user about the dispute
    const disputeAmount = (dispute.amount / 100).toFixed(2);
    createNotification({
      userId: order.userId,
      type: "system",
      title: "Payment Dispute Opened",
      body: `A dispute for $${disputeAmount} ${dispute.currency.toUpperCase()} has been opened on your order. Our team is reviewing this and will be in touch.`,
      actionUrl: `/orders/${paymentRecord.orderId}`,
      metadata: {
        disputeId: dispute.id,
        orderId: paymentRecord.orderId,
        reason: dispute.reason,
        amount: disputeAmount,
        currency: dispute.currency,
      },
    }).catch((err) => {
      console.error(
        `[stripe-webhook] Failed to send dispute notification for order ${paymentRecord.orderId}:`,
        err
      );
    });
  }

  // Notify ops — in production, this would send an email/Slack/notification
  console.error(
    `[stripe-webhook] DISPUTE CREATED: ${dispute.id} ` +
      `| Order: ${paymentRecord.orderId} ` +
      `| Reason: ${dispute.reason} ` +
      `| Amount: ${dispute.currency.toUpperCase()} ${(dispute.amount / 100).toFixed(2)} ` +
      `| ACTION REQUIRED`
  );
}
