// =============================================================================
// Admin: Telegram webhook setup — /api/admin/telegram-setup
// =============================================================================
// Registers (or inspects/removes) the Telegram webhook. Guarded by CRON_SECRET.
//
//   POST ?action=set     → setWebhook to <baseUrl>/api/webhooks/telegram
//   POST ?action=info    → getWebhookInfo (debug)
//   POST ?action=delete  → deleteWebhook
//
// `action` defaults to "set". Optional ?baseUrl= overrides config.app.url
// (handy for pointing the bot at a preview deploy).
//
//   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
//     "$APP_URL/api/admin/telegram-setup?action=set"
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import {
  setTelegramWebhook,
  getTelegramWebhookInfo,
  deleteTelegramWebhook,
  isTelegramConfigured,
} from "@/lib/messaging/telegram";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isTelegramConfigured()) {
    return NextResponse.json(
      { error: "TELEGRAM_BOT_TOKEN not configured" },
      { status: 500 },
    );
  }

  const url = new URL(request.url);
  const action = url.searchParams.get("action") ?? "set";

  try {
    if (action === "info") {
      const info = await getTelegramWebhookInfo();
      return NextResponse.json(info);
    }

    if (action === "delete") {
      const result = await deleteTelegramWebhook();
      return NextResponse.json(result);
    }

    // action === "set"
    const secret = config.messaging.telegram.webhookSecret;
    if (!secret) {
      return NextResponse.json(
        { error: "TELEGRAM_WEBHOOK_SECRET not configured" },
        { status: 500 },
      );
    }
    const base = (url.searchParams.get("baseUrl") ?? config.app.url).replace(
      /\/$/,
      "",
    );
    const webhookUrl = `${base}/api/webhooks/telegram`;
    if (!webhookUrl.startsWith("https://")) {
      return NextResponse.json(
        { error: `Webhook URL must be https. Got: ${webhookUrl}` },
        { status: 400 },
      );
    }
    const result = await setTelegramWebhook(webhookUrl, secret);
    return NextResponse.json({ ...result, webhookUrl });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
