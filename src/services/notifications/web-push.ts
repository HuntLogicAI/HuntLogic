// =============================================================================
// Web Push delivery — VAPID-signed push notifications to subscribed browsers
// =============================================================================
// Wraps the `web-push` library. Reads VAPID keys from env (set them once
// per environment via `npx web-push generate-vapid-keys`). Stale subscriptions
// (HTTP 404 / 410 from the push service) are pruned automatically.
// =============================================================================

import webpush from "web-push";
import { db } from "@/lib/db";
import { pushSubscriptions } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

const LOG_PREFIX = "[push]";

let vapidConfigured = false;

function ensureVapidConfigured(): boolean {
  if (vapidConfigured) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:support@huntlogic.com";
  if (!publicKey || !privateKey) {
    console.warn(
      `${LOG_PREFIX} VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY missing — push delivery is a no-op until set.`,
    );
    return false;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
  return true;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  icon?: string;
  tag?: string;
  data?: Record<string, unknown>;
}

/**
 * Send a push notification to every active subscription belonging to `userId`.
 *
 * Returns the count of successful sends. Stale subscriptions (gone from the
 * push service) are marked inactive so subsequent sends skip them.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<number> {
  if (!ensureVapidConfigured()) return 0;

  const subs = await db
    .select()
    .from(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.userId, userId),
        eq(pushSubscriptions.active, true),
      ),
    );

  if (subs.length === 0) return 0;

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url ?? "/dashboard",
    icon: payload.icon ?? "/icon-192.png",
    tag: payload.tag,
    data: payload.data ?? {},
  });

  let successCount = 0;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          body,
          {
            TTL: 60 * 60 * 24, // 24h relevance window
            urgency: "normal",
          },
        );
        successCount++;
        // Best-effort: update lastUsedAt; ignore failures.
        await db
          .update(pushSubscriptions)
          .set({ lastUsedAt: new Date() })
          .where(eq(pushSubscriptions.id, sub.id))
          .catch(() => {});
      } catch (err: unknown) {
        const status =
          err && typeof err === "object" && "statusCode" in err
            ? (err as { statusCode?: number }).statusCode
            : undefined;
        // 404 / 410 = subscription is gone from the push service. Mark
        // inactive so we don't keep trying. Anything else, just log.
        if (status === 404 || status === 410) {
          console.log(
            `${LOG_PREFIX} pruning stale subscription ${sub.id} (status ${status})`,
          );
          await db
            .update(pushSubscriptions)
            .set({ active: false })
            .where(eq(pushSubscriptions.id, sub.id))
            .catch(() => {});
        } else {
          console.warn(`${LOG_PREFIX} send failed:`, err);
        }
      }
    }),
  );

  return successCount;
}
