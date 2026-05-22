// =============================================================================
// POST /api/v1/concierge/orders/[orderId]/checkout — Create Stripe checkout
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  applicationOrders,
  applicationOrderItems,
  states,
  species,
} from "@/lib/db/schema";
import {
  createOrGetCustomer,
  createCheckoutSession,
  generateOrderNumber,
} from "@/services/stripe";
import { canCheckout } from "@/services/stripe/predicates";
import { config } from "@/lib/config";

const LOG_PREFIX = "[api:concierge/orders/[orderId]/checkout]";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orderId } = await params;

  try {
    // Validate order exists, is owned by user, and is draft
    const order = await db.query.applicationOrders.findFirst({
      where: and(
        eq(applicationOrders.id, orderId),
        eq(applicationOrders.userId, session.user.id)
      ),
    });

    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    // Predicate is in services/stripe/predicates.ts so tests exercise the
    // same logic the route enforces.
    if (!canCheckout(order.status)) {
      return NextResponse.json(
        { error: "Only draft orders can be checked out" },
        { status: 400 }
      );
    }

    // Fetch items with state/species names for line item descriptions
    const items = await db
      .select({
        id: applicationOrderItems.id,
        stateId: applicationOrderItems.stateId,
        speciesId: applicationOrderItems.speciesId,
        residency: applicationOrderItems.residency,
        huntType: applicationOrderItems.huntType,
        stateFee: applicationOrderItems.stateFee,
        serviceFee: applicationOrderItems.serviceFee,
        stateCode: states.code,
        stateName: states.name,
        speciesName: species.commonName,
      })
      .from(applicationOrderItems)
      .innerJoin(states, eq(applicationOrderItems.stateId, states.id))
      .innerJoin(species, eq(applicationOrderItems.speciesId, species.id))
      .where(eq(applicationOrderItems.orderId, orderId));

    if (items.length === 0) {
      return NextResponse.json(
        { error: "Order has no items" },
        { status: 400 }
      );
    }

    // Create or retrieve Stripe customer
    const customerId = await createOrGetCustomer({
      id: session.user.id,
      email: session.user.email!,
      name: session.user.name,
    });

    // Build line items (state fees + service fees, amounts in cents)
    const lineItems = items.flatMap((item) => {
      const result: Array<{
        name: string;
        description?: string;
        amount: number;
        quantity?: number;
      }> = [];

      const stateFeeAmount = Math.round(parseFloat(item.stateFee) * 100);
      const serviceFeeAmount = Math.round(parseFloat(item.serviceFee) * 100);

      if (stateFeeAmount > 0) {
        result.push({
          name: `${item.stateName} ${item.speciesName} Application`,
          description: `${item.residency} - ${item.huntType ?? "general"} | State fees for ${item.stateCode}`,
          amount: stateFeeAmount,
        });
      }

      if (serviceFeeAmount > 0) {
        result.push({
          name: `${config.app.brandName} Service Fee — ${item.stateCode} ${item.speciesName}`,
          description: `Application concierge service fee`,
          amount: serviceFeeAmount,
        });
      }

      return result;
    });

    if (lineItems.length === 0) {
      return NextResponse.json(
        { error: "Order total is zero" },
        { status: 400 }
      );
    }

    const orderNumber = generateOrderNumber();

    // Create Stripe checkout session
    const checkoutSession = await createCheckoutSession({
      customerId,
      orderId,
      orderNumber,
      lineItems,
      successUrl: `${config.app.url}/orders/success?orderId=${orderId}&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${config.app.url}/orders/cancelled?orderId=${orderId}`,
    });

    // Update order status and save Stripe payment intent ID
    await db
      .update(applicationOrders)
      .set({
        status: "pending_payment",
        stripePaymentIntentId: checkoutSession.payment_intent as string,
        metadata: {
          ...(order.metadata as Record<string, unknown>),
          orderNumber,
          stripeSessionId: checkoutSession.id,
        },
        updatedAt: new Date(),
      })
      .where(eq(applicationOrders.id, orderId));

    console.log(
      `${LOG_PREFIX} POST: Checkout session created for order ${orderId} (session=${checkoutSession.id})`
    );

    return NextResponse.json({
      data: {
        checkoutUrl: checkoutSession.url,
      },
    });
  } catch (error) {
    console.error(`${LOG_PREFIX} POST error:`, error);
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 }
    );
  }
}
