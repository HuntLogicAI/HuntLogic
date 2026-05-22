// =============================================================================
// POST /api/v1/notifications/push/subscribe
// DELETE /api/v1/notifications/push/subscribe
// GET    /api/v1/notifications/push/subscribe — returns the public VAPID key
// =============================================================================
// Manages the user's browser PushSubscription. The browser hands us an
// endpoint + p256dh + auth tuple after `pushManager.subscribe()`; we store
// it so the deadline cron can deliver pushes to it later.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { pushSubscriptions } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

export async function GET() {
  // Expose the public VAPID key so the client can call
  // pushManager.subscribe({ applicationServerKey, userVisibleOnly: true }).
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? process.env.VAPID_PUBLIC_KEY ?? null;
  if (!publicKey) {
    return NextResponse.json(
      { error: "Push not configured", configured: false },
      { status: 503 },
    );
  }
  return NextResponse.json({ publicKey, configured: true });
}

interface SubscribeBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: SubscribeBody;
  try {
    body = (await request.json()) as SubscribeBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    !body?.endpoint ||
    !body.keys?.p256dh ||
    !body.keys?.auth ||
    typeof body.endpoint !== "string"
  ) {
    return NextResponse.json(
      { error: "endpoint, keys.p256dh, and keys.auth are required" },
      { status: 400 },
    );
  }

  // Endpoints are globally unique. If this endpoint already exists, update
  // it (re-bind to current user, refresh keys, mark active).
  const existing = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, body.endpoint))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(pushSubscriptions)
      .set({
        userId: session.user.id,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        userAgent: body.userAgent ?? null,
        active: true,
        subscribedAt: new Date(),
      })
      .where(eq(pushSubscriptions.id, existing[0]!.id));
    return NextResponse.json({ updated: true });
  }

  await db.insert(pushSubscriptions).values({
    userId: session.user.id,
    endpoint: body.endpoint,
    p256dh: body.keys.p256dh,
    auth: body.keys.auth,
    userAgent: body.userAgent ?? null,
  });
  return NextResponse.json({ created: true });
}

interface UnsubscribeBody {
  endpoint?: string;
}

export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: UnsubscribeBody = {};
  try {
    body = (await request.json()) as UnsubscribeBody;
  } catch {
    // Body is optional — without an endpoint we unsubscribe all of the
    // user's subscriptions (e.g. "turn off browser push everywhere").
  }

  if (body.endpoint) {
    await db
      .update(pushSubscriptions)
      .set({ active: false })
      .where(
        and(
          eq(pushSubscriptions.userId, session.user.id),
          eq(pushSubscriptions.endpoint, body.endpoint),
        ),
      );
  } else {
    await db
      .update(pushSubscriptions)
      .set({ active: false })
      .where(eq(pushSubscriptions.userId, session.user.id));
  }

  return NextResponse.json({ deactivated: true });
}
