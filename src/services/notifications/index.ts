// =============================================================================
// Notification Service — Create and send notifications
// =============================================================================

import { db } from "@/lib/db";
import { notifications, notificationPreferences } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NotificationType =
  | "deadline_reminder"
  | "draw_result"
  | "point_creep"
  | "strategy_update"
  | "welcome"
  | "system"
  | "order_paid"
  | "application_submitted"
  | "payment_failed";

interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  actionUrl?: string;
  channel?: "in_app" | "email" | "push";
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Preference-gated notification types.
// Transactional types (order_paid, payment_failed, application_submitted)
// are always sent regardless of preference toggles.
// ---------------------------------------------------------------------------

const PREFERENCE_GATED: Partial<
  Record<NotificationType, keyof typeof PREF_KEY_MAP>
> = {
  deadline_reminder: "deadlineReminders",
  draw_result: "drawResults",
  strategy_update: "strategyUpdates",
  point_creep: "pointCreepAlerts",
};

const PREF_KEY_MAP = {
  deadlineReminders: "deadlineReminders",
  drawResults: "drawResults",
  strategyUpdates: "strategyUpdates",
  pointCreepAlerts: "pointCreepAlerts",
} as const;

// ---------------------------------------------------------------------------
// Core: createNotification
// ---------------------------------------------------------------------------

export async function createNotification(
  input: CreateNotificationInput
): Promise<void> {
  const prefKey = PREFERENCE_GATED[input.type];

  // Check user preferences — only for gated types
  if (prefKey) {
    const prefs = await db.query.notificationPreferences.findFirst({
      where: eq(notificationPreferences.userId, input.userId),
    });

    if (prefs && !prefs[prefKey]) {
      console.log(
        `[notifications] Skipped ${input.type} for user ${input.userId} — preference disabled`
      );
      return;
    }
  }

  // Insert the in-app notification
  await db.insert(notifications).values({
    userId: input.userId,
    type: input.type,
    channel: input.channel ?? "in_app",
    title: input.title,
    body: input.body,
    actionUrl: input.actionUrl,
    metadata: input.metadata ?? {},
  });

  console.log(
    `[notifications] Created ${input.type} notification for user ${input.userId}`
  );

  // Send email if enabled (non-blocking)
  const prefs = await db.query.notificationPreferences.findFirst({
    where: eq(notificationPreferences.userId, input.userId),
  });

  if (!prefs || prefs.emailEnabled) {
    sendEmailNotification(input).catch((err) => {
      console.warn("[notifications] Email send failed:", err);
    });
  }

  // Browser push (non-blocking). Gated by pushEnabled pref + having an
  // active subscription. The web-push service no-ops silently when VAPID
  // env vars aren't set, so this is safe to call unconditionally.
  if (!prefs || prefs.pushEnabled) {
    (async () => {
      try {
        const { sendPushToUser } = await import("./web-push");
        await sendPushToUser(input.userId, {
          title: input.title,
          body: input.body,
          url: input.actionUrl,
          tag: input.type,
          data: { ...(input.metadata ?? {}), type: input.type },
        });
      } catch (err) {
        console.warn("[notifications] Push send failed:", err);
      }
    })();
  }
}

// ---------------------------------------------------------------------------
// Convenience: notifyOrderPaid
// Transactional — always sent.
// ---------------------------------------------------------------------------

export async function notifyOrderPaid(
  userId: string,
  orderId: string,
  orderNumber: string,
  amount: string
): Promise<void> {
  await createNotification({
    userId,
    type: "order_paid",
    title: "Payment Confirmed",
    body: `Your order ${orderNumber} for $${amount} has been received. Our team will begin processing your applications shortly.`,
    actionUrl: `/orders/${orderId}`,
    metadata: { orderId, orderNumber, amount },
  });
}

// ---------------------------------------------------------------------------
// Convenience: notifyApplicationSubmitted
// Transactional — always sent.
// ---------------------------------------------------------------------------

export async function notifyApplicationSubmitted(
  userId: string,
  orderId: string,
  stateName: string,
  speciesName: string
): Promise<void> {
  await createNotification({
    userId,
    type: "application_submitted",
    title: "Application Submitted",
    body: `Your ${speciesName} application for ${stateName} has been submitted successfully.`,
    actionUrl: `/orders/${orderId}`,
    metadata: { orderId, stateName, speciesName },
  });
}

// ---------------------------------------------------------------------------
// Convenience: notifyDrawResult
// Gated by drawResults preference.
// ---------------------------------------------------------------------------

export async function notifyDrawResult(
  userId: string,
  orderId: string,
  stateName: string,
  speciesName: string,
  result: "drawn" | "unsuccessful"
): Promise<void> {
  const isDrawn = result === "drawn";
  await createNotification({
    userId,
    type: "draw_result",
    title: isDrawn ? "Congratulations — Tag Drawn!" : "Draw Result — Unsuccessful",
    body: isDrawn
      ? `Great news! You were drawn for ${speciesName} in ${stateName}. Check your order for next steps.`
      : `Unfortunately, your ${speciesName} application for ${stateName} was unsuccessful this year. Your preference points have been updated.`,
    actionUrl: `/orders/${orderId}`,
    metadata: { orderId, stateName, speciesName, result },
  });
}

// ---------------------------------------------------------------------------
// Convenience: notifyPaymentFailed
// Transactional — always sent.
// ---------------------------------------------------------------------------

export async function notifyPaymentFailed(
  userId: string,
  orderId: string,
  reason: string
): Promise<void> {
  await createNotification({
    userId,
    type: "payment_failed",
    title: "Payment Failed",
    body: `Your payment could not be processed: ${reason}. Please update your payment method to avoid missing application deadlines.`,
    actionUrl: `/orders/${orderId}`,
    metadata: { orderId, reason },
  });
}

// ---------------------------------------------------------------------------
// Bulk notification helper
// ---------------------------------------------------------------------------

export async function createBulkNotifications(
  userIds: string[],
  notification: Omit<CreateNotificationInput, "userId">
): Promise<void> {
  for (const userId of userIds) {
    await createNotification({ ...notification, userId });
  }
}

// ---------------------------------------------------------------------------
// Internal: email delivery via Resend
// ---------------------------------------------------------------------------

async function sendEmailNotification(
  input: CreateNotificationInput
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;

  const fromEmail =
    process.env.EMAIL_FROM ?? "HuntLogic <noreply@huntlogic.com>";

  // Get user email
  const user = await db.query.users.findFirst({
    where: eq((await import("@/lib/db/schema")).users.id, input.userId),
    columns: { email: true, displayName: true },
  });

  if (!user?.email) return;

  const { Resend } = await import("resend");
  const resend = new Resend(apiKey);

  await resend.emails.send({
    from: fromEmail,
    to: user.email,
    subject: input.title,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #1A3C2A, #2A5C40); padding: 24px; border-radius: 12px 12px 0 0;">
          <h2 style="color: #F5F5F0; margin: 0; font-size: 18px;">HuntLogic</h2>
        </div>
        <div style="background: #ffffff; padding: 24px; border: 1px solid #E0DDD5; border-top: none; border-radius: 0 0 12px 12px;">
          <h3 style="color: #2D1F0E; margin: 0 0 12px 0;">${input.title}</h3>
          <p style="color: #6B7B6E; line-height: 1.6; margin: 0 0 20px 0;">${input.body}</p>
          ${input.actionUrl ? `<a href="https://huntlogic.vercel.app${input.actionUrl}" style="display: inline-block; background: linear-gradient(135deg, #C4651A, #D4A03C); color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">View Details</a>` : ""}
        </div>
        <p style="color: #9CA89E; font-size: 12px; text-align: center; margin-top: 16px;">
          You're receiving this because you have notifications enabled in HuntLogic.
          <a href="https://huntlogic.vercel.app/settings" style="color: #6B7B6E;">Manage preferences</a>
        </p>
      </div>
    `,
  });
}
