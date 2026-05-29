// =============================================================================
// Telegram inbound webhook — POST /api/webhooks/telegram
// =============================================================================
// Telegram POSTs every inbound message here. We:
//   1. Verify the secret-token header (fail-closed on spoofed requests).
//   2. Handle commands: /start <token> (link), /stop (unlink), /help.
//   3. For a verified hunter's plain message → run the Grizz brain and reply.
//
// The brain can take 30-90s, so we ACK with 200 immediately and do the heavy
// work in after() — this keeps Telegram from retrying (and double-replying).
// =============================================================================

import { NextRequest, NextResponse, after } from "next/server";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  messagingIdentities,
  messagingLinkTokens,
  messagingMessages,
} from "@/lib/db/schema";
import { config } from "@/lib/config";
import { assembleGrizzMessage, runGrizzText } from "@/lib/ai/grizz";
import {
  sendTelegramMessage,
  sendTelegramTyping,
  verifyTelegramWebhookSecret,
  type TelegramUpdate,
  type TelegramMessage,
} from "@/lib/messaging/telegram";

export const runtime = "nodejs";
export const maxDuration = 300;

const HISTORY_LIMIT = 10;
const aiName = () => config.app.aiAssistantName;

export async function POST(request: NextRequest) {
  // Feature flag — ACK and ignore so Telegram doesn't keep retrying.
  if (!config.features.telegramBot) {
    return NextResponse.json({ ok: true });
  }

  // Reject anything that isn't carrying Telegram's secret token.
  const secretHeader = request.headers.get("x-telegram-bot-api-secret-token");
  if (!verifyTelegramWebhookSecret(secretHeader)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ ok: true });
  }

  const message = update.message;
  const text = message?.text?.trim();
  if (!message || !text) {
    return NextResponse.json({ ok: true });
  }

  const chatId = message.chat.id;
  const updateId = String(update.update_id);

  // Commands are cheap → handle inline. Free-form messages run the brain in
  // after() so we can ACK fast.
  if (text.startsWith("/start")) {
    const token = text.slice("/start".length).trim();
    after(() => handleStart(chatId, token, message));
    return NextResponse.json({ ok: true });
  }
  if (text === "/stop" || text === "/unlink") {
    after(() => handleStop(chatId));
    return NextResponse.json({ ok: true });
  }
  if (text === "/help") {
    after(() => handleHelp(chatId));
    return NextResponse.json({ ok: true });
  }

  after(() => handleMessage(chatId, text, updateId, message));
  return NextResponse.json({ ok: true });
}

// ---------------------------------------------------------------------------
// /start <token> — bind this Telegram chat to a HuntLogic account
// ---------------------------------------------------------------------------
async function handleStart(
  chatId: number,
  token: string,
  message: TelegramMessage,
): Promise<void> {
  const appUrl = config.app.url;

  if (!token) {
    await sendTelegramMessage(
      chatId,
      `Hi — I'm ${aiName()}, your HuntLogic concierge. To link this chat to your account, open ${appUrl}/settings and tap "Connect Telegram". That gives you a one-tap link to start here.`,
    );
    return;
  }

  const now = new Date();
  const [linkToken] = await db
    .select()
    .from(messagingLinkTokens)
    .where(
      and(
        eq(messagingLinkTokens.token, token),
        eq(messagingLinkTokens.channel, "telegram"),
        isNull(messagingLinkTokens.consumedAt),
        gt(messagingLinkTokens.expiresAt, now),
      ),
    )
    .limit(1);

  if (!linkToken) {
    await sendTelegramMessage(
      chatId,
      `That link has expired or was already used. Head back to ${appUrl}/settings and tap "Connect Telegram" for a fresh one.`,
    );
    return;
  }

  const displayName =
    message.from?.username
      ? `@${message.from.username}`
      : [message.from?.first_name, message.from?.last_name]
          .filter(Boolean)
          .join(" ") || null;

  // Bind chat → user. Upsert on (channel, channel_user_id) so re-linking the
  // same chat (even to a different account) just updates the row.
  await db
    .insert(messagingIdentities)
    .values({
      userId: linkToken.userId,
      channel: "telegram",
      channelUserId: String(chatId),
      displayName,
      verified: true,
      verifiedAt: now,
      active: true,
    })
    .onConflictDoUpdate({
      target: [messagingIdentities.channel, messagingIdentities.channelUserId],
      set: {
        userId: linkToken.userId,
        displayName,
        verified: true,
        verifiedAt: now,
        active: true,
      },
    });

  // Consume the token + invalidate any other outstanding tokens for this user.
  await db
    .update(messagingLinkTokens)
    .set({ consumedAt: now })
    .where(eq(messagingLinkTokens.id, linkToken.id));

  await sendTelegramMessage(
    chatId,
    `You're linked. I'm ${aiName()} — I've got your point holdings and hunt plan. Ask me anything: where to apply, when you'll draw, deadlines, the works. Text /help anytime, or /stop to unlink.`,
  );
}

// ---------------------------------------------------------------------------
// /stop — unlink this chat
// ---------------------------------------------------------------------------
async function handleStop(chatId: number): Promise<void> {
  await db
    .delete(messagingIdentities)
    .where(
      and(
        eq(messagingIdentities.channel, "telegram"),
        eq(messagingIdentities.channelUserId, String(chatId)),
      ),
    );
  await sendTelegramMessage(
    chatId,
    `Unlinked. I won't message this chat anymore and your conversation history here is cleared. Re-connect anytime from ${config.app.url}/settings.`,
  );
}

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------
async function handleHelp(chatId: number): Promise<void> {
  await sendTelegramMessage(
    chatId,
    `I'm ${aiName()}, your HuntLogic concierge. Just text me like a buddy who knows every Western draw:\n\n• "Where should I apply with 7 NV elk points?"\n• "When will I draw CO sheep?"\n• "What's the WY deadline?"\n\nCommands: /help · /stop (unlink).`,
  );
}

// ---------------------------------------------------------------------------
// Free-form message — run the brain for a verified hunter
// ---------------------------------------------------------------------------
async function handleMessage(
  chatId: number,
  text: string,
  updateId: string,
  message: TelegramMessage,
): Promise<void> {
  const [identity] = await db
    .select()
    .from(messagingIdentities)
    .where(
      and(
        eq(messagingIdentities.channel, "telegram"),
        eq(messagingIdentities.channelUserId, String(chatId)),
        eq(messagingIdentities.active, true),
        eq(messagingIdentities.verified, true),
      ),
    )
    .limit(1);

  if (!identity) {
    await sendTelegramMessage(
      chatId,
      `Link your HuntLogic account first so I can give you personalized advice. Open ${config.app.url}/settings → "Connect Telegram" for a one-tap link.`,
    );
    return;
  }

  // Idempotency: Telegram can redeliver an update. Skip if we already logged it.
  const dupe = await db
    .select({ id: messagingMessages.id })
    .from(messagingMessages)
    .where(
      and(
        eq(messagingMessages.identityId, identity.id),
        eq(messagingMessages.updateId, updateId),
      ),
    )
    .limit(1);
  if (dupe.length > 0) return;

  await sendTelegramTyping(chatId);

  // Pull recent history (chronological) for multi-turn memory.
  const recent = await db
    .select({
      role: messagingMessages.role,
      content: messagingMessages.content,
    })
    .from(messagingMessages)
    .where(eq(messagingMessages.identityId, identity.id))
    .orderBy(desc(messagingMessages.createdAt))
    .limit(HISTORY_LIMIT);
  const history = recent.reverse();

  let answer: string;
  try {
    const { fullMessage } = await assembleGrizzMessage(
      identity.userId,
      text,
      history,
    );
    answer = await runGrizzText(fullMessage);
  } catch (err) {
    console.error("[telegram:webhook] brain error:", err);
    answer = `I hit a snag pulling that together — try me again in a moment.`;
  }

  if (!answer || answer.trim().length === 0) {
    answer = `I didn't catch a clear answer there — mind rephrasing?`;
  }

  // Persist the turn (user + assistant) and stamp lastInboundAt.
  await db.insert(messagingMessages).values([
    { identityId: identity.id, role: "user", content: text, updateId },
    { identityId: identity.id, role: "assistant", content: answer },
  ]);
  await db
    .update(messagingIdentities)
    .set({
      lastInboundAt: new Date(),
      // Keep the friendliest display name we've seen.
      displayName:
        identity.displayName ??
        (message.from?.username ? `@${message.from.username}` : null),
    })
    .where(eq(messagingIdentities.id, identity.id));

  await sendTelegramMessage(chatId, answer);
}
