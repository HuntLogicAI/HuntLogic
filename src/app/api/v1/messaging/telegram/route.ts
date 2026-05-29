// =============================================================================
// Telegram link status + unlink — /api/v1/messaging/telegram
// =============================================================================
//   GET    — is this user's Telegram connected? (+ availability flags)
//   DELETE — unlink: removes the identity (and its conversation history)
// =============================================================================

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { messagingIdentities } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { config } from "@/lib/config";
import { isTelegramConfigured } from "@/lib/messaging/telegram";

export const runtime = "nodejs";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [identity] = await db
    .select({
      displayName: messagingIdentities.displayName,
      verified: messagingIdentities.verified,
      verifiedAt: messagingIdentities.verifiedAt,
    })
    .from(messagingIdentities)
    .where(
      and(
        eq(messagingIdentities.userId, session.user.id),
        eq(messagingIdentities.channel, "telegram"),
        eq(messagingIdentities.active, true),
      ),
    )
    .limit(1);

  return NextResponse.json({
    // Feature availability so the UI can render the right empty state.
    enabled: config.features.telegramBot && isTelegramConfigured(),
    botHandle: config.messaging.telegram.botHandle,
    connected: Boolean(identity?.verified),
    displayName: identity?.displayName ?? null,
    connectedAt: identity?.verifiedAt ?? null,
  });
}

export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Hard delete the identity — cascades to messaging_messages, so the
  // conversation history is cleared on unlink (privacy-preserving).
  await db
    .delete(messagingIdentities)
    .where(
      and(
        eq(messagingIdentities.userId, session.user.id),
        eq(messagingIdentities.channel, "telegram"),
      ),
    );

  return NextResponse.json({ success: true });
}
