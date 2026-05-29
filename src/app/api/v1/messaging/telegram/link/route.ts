// =============================================================================
// Telegram link-token mint — POST /api/v1/messaging/telegram/link
// =============================================================================
// Mints a short-lived, single-use token tied to the signed-in user and returns
// a one-tap deep link (t.me/<bot>?start=<token>). The user taps it, Telegram
// opens the bot with `/start <token>`, and the webhook binds the chat → user.
// =============================================================================

import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { messagingLinkTokens } from "@/lib/db/schema";
import { config } from "@/lib/config";
import {
  buildTelegramDeepLink,
  isTelegramConfigured,
} from "@/lib/messaging/telegram";

export const runtime = "nodejs";

// Linking tokens are short-lived — the user is expected to tap through right away.
const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!config.features.telegramBot || !isTelegramConfigured()) {
    return NextResponse.json(
      { error: "Telegram concierge is not enabled on this deployment." },
      { status: 404 },
    );
  }

  // URL-safe, unguessable token.
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await db.insert(messagingLinkTokens).values({
    token,
    userId: session.user.id,
    channel: "telegram",
    expiresAt,
  });

  return NextResponse.json({
    token,
    deepLink: buildTelegramDeepLink(token),
    botHandle: config.messaging.telegram.botHandle,
    expiresAt: expiresAt.toISOString(),
  });
}
