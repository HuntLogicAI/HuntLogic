// =============================================================================
// Telegram Bot client
// =============================================================================
// Thin wrapper over the Telegram Bot HTTP API. Used by:
//   - the inbound webhook (/api/webhooks/telegram) to reply to hunters
//   - the linking endpoints to build deep links
//   - the admin setup endpoint to register the webhook
//
// We deliberately send PLAIN TEXT (no parse_mode) so Grizz's markdown-ish
// output — bullets, [1] citations, asterisks — renders literally instead of
// tripping Telegram's strict MarkdownV2 escaping rules.
// =============================================================================

import { config } from "@/lib/config";

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/** True when a bot token is configured (required for any outbound call). */
export function isTelegramConfigured(): boolean {
  return Boolean(config.messaging.telegram.botToken);
}

/** Bot handle without the leading "@", for building t.me deep links. */
export function telegramBotUsername(): string {
  return config.messaging.telegram.botHandle.replace(/^@/, "");
}

/** Build the one-tap linking deep link: t.me/<bot>?start=<token>. */
export function buildTelegramDeepLink(startToken: string): string {
  return `https://t.me/${telegramBotUsername()}?start=${encodeURIComponent(startToken)}`;
}

/**
 * Verify the secret token Telegram echoes back on every inbound update.
 * Returns false if no secret is configured (fail-closed) or if it mismatches.
 */
export function verifyTelegramWebhookSecret(headerValue: string | null): boolean {
  const expected = config.messaging.telegram.webhookSecret;
  if (!expected) return false;
  return headerValue === expected;
}

function apiBase(): string {
  return `https://api.telegram.org/bot${config.messaging.telegram.botToken}`;
}

/** Low-level Bot API call. Returns parsed JSON; throws on network failure. */
async function telegramApi<T = unknown>(
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; result?: T; description?: string }> {
  const res = await fetch(`${apiBase()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: boolean; result?: T; description?: string };
}

/** Split text into Telegram-sized chunks, preferring paragraph/line breaks. */
export function chunkTelegramText(
  text: string,
  size = TELEGRAM_MAX_MESSAGE_LENGTH,
): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > size) {
    // Prefer to break on the last double-newline, then newline, then space.
    let cut = remaining.lastIndexOf("\n\n", size);
    if (cut < size * 0.5) cut = remaining.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = remaining.lastIndexOf(" ", size);
    if (cut <= 0) cut = size;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Send a message to a chat, splitting long answers into multiple messages.
 * Best-effort: logs and swallows API errors so the webhook still returns 200.
 */
export async function sendTelegramMessage(
  chatId: string | number,
  text: string,
): Promise<void> {
  if (!isTelegramConfigured()) {
    console.warn("[telegram] sendTelegramMessage skipped — no bot token");
    return;
  }
  const chunks = chunkTelegramText(text);
  for (const chunk of chunks) {
    try {
      const json = await telegramApi("sendMessage", {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
      });
      if (!json.ok) {
        console.error("[telegram] sendMessage failed:", json.description);
      }
    } catch (err) {
      console.error("[telegram] sendMessage error:", err);
    }
  }
}

/** Show the "typing…" indicator while Grizz thinks. Best-effort. */
export async function sendTelegramTyping(chatId: string | number): Promise<void> {
  if (!isTelegramConfigured()) return;
  try {
    await telegramApi("sendChatAction", { chat_id: chatId, action: "typing" });
  } catch (err) {
    console.warn("[telegram] sendChatAction error:", err);
  }
}

// ---------------------------------------------------------------------------
// Webhook administration (used by /api/admin/telegram-setup)
// ---------------------------------------------------------------------------

export async function setTelegramWebhook(
  url: string,
  secretToken: string,
): Promise<{ ok: boolean; description?: string }> {
  return telegramApi("setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["message"],
    drop_pending_updates: true,
  });
}

export async function getTelegramWebhookInfo(): Promise<{
  ok: boolean;
  result?: unknown;
  description?: string;
}> {
  return telegramApi("getWebhookInfo", {});
}

export async function deleteTelegramWebhook(): Promise<{
  ok: boolean;
  description?: string;
}> {
  return telegramApi("deleteWebhook", { drop_pending_updates: false });
}

// ---------------------------------------------------------------------------
// Inbound update types (minimal — we only consume `message`)
// ---------------------------------------------------------------------------

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from?: {
    id: number;
    is_bot: boolean;
    first_name?: string;
    last_name?: string;
    username?: string;
  };
  chat: {
    id: number;
    type: string;
    first_name?: string;
    username?: string;
  };
  text?: string;
}
