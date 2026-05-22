"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

type Status =
  | "unknown"
  | "unsupported"
  | "not-configured"
  | "denied"
  | "subscribed"
  | "unsubscribed";

/**
 * Opt-in control for browser push notifications.
 *
 * Lifecycle:
 *   1. Detect browser capability (PushManager, Notification, ServiceWorker)
 *   2. Fetch the server's VAPID public key
 *   3. Read the current SW registration's existing subscription, if any
 *   4. On user click → request Notification permission → subscribe via
 *      pushManager.subscribe → POST the subscription to our API.
 *
 * This is intentionally a UI-only opt-in surface. The actual notification
 * preferences (deadlineReminders / drawResults / etc.) live elsewhere on
 * Settings and gate which events fire pushes server-side.
 */

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf;
}

export function PushNotificationToggle() {
  const [status, setStatus] = useState<Status>("unknown");
  const [busy, setBusy] = useState(false);
  const [vapidKey, setVapidKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      if (
        typeof window === "undefined" ||
        !("serviceWorker" in navigator) ||
        !("PushManager" in window) ||
        !("Notification" in window)
      ) {
        if (!cancelled) setStatus("unsupported");
        return;
      }

      // Fetch VAPID public key from server
      try {
        const res = await fetch("/api/v1/notifications/push/subscribe");
        if (!res.ok) {
          if (!cancelled) setStatus("not-configured");
          return;
        }
        const json = await res.json();
        if (!json.configured || !json.publicKey) {
          if (!cancelled) setStatus("not-configured");
          return;
        }
        if (!cancelled) setVapidKey(json.publicKey);
      } catch {
        if (!cancelled) setStatus("not-configured");
        return;
      }

      // Check current state
      if (Notification.permission === "denied") {
        if (!cancelled) setStatus("denied");
        return;
      }

      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!cancelled) setStatus(sub ? "subscribed" : "unsubscribed");
      } catch (err) {
        console.warn("[push:toggle] SW ready failed:", err);
        if (!cancelled) setStatus("unsubscribed");
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, []);

  const subscribe = async () => {
    if (!vapidKey || busy) return;
    setBusy(true);
    try {
      // Make sure the SW is registered
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      // Request permission
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setStatus(perm === "denied" ? "denied" : "unsubscribed");
        return;
      }

      // TS/lib types for PushSubscriptionOptionsInit are strict about the
      // ArrayBufferLike narrowing; the Uint8Array we produce is correct at
      // runtime, just not provably non-SharedArrayBuffer-backed.
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey:
          urlBase64ToUint8Array(vapidKey) as unknown as BufferSource,
      });

      const json = sub.toJSON();
      // Persist the subscription server-side. The browser-side subscription
      // already exists at this point — if the server rejects (auth, validation,
      // VAPID misconfig), we MUST unwind the browser subscription too,
      // otherwise the browser holds a push subscription the server never
      // stored and the user sees "subscribed" while push delivery is dead.
      let serverPersisted = false;
      try {
        const res = await fetch("/api/v1/notifications/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: json.endpoint,
            keys: json.keys,
            userAgent: navigator.userAgent,
          }),
        });
        serverPersisted = res.ok;
        if (!res.ok) {
          console.warn(
            "[push:toggle] server rejected subscription:",
            res.status,
            await res.text().catch(() => ""),
          );
        }
      } catch (err) {
        console.error("[push:toggle] server POST failed:", err);
      }

      if (!serverPersisted) {
        // Unwind the browser subscription so state matches reality.
        try {
          await sub.unsubscribe();
        } catch (err) {
          console.warn("[push:toggle] unwind unsubscribe failed:", err);
        }
        setStatus("unsubscribed");
        return;
      }

      setStatus("subscribed");
    } catch (err) {
      console.error("[push:toggle] subscribe failed:", err);
      setStatus("unsubscribed");
    } finally {
      setBusy(false);
    }
  };

  const unsubscribe = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        await fetch("/api/v1/notifications/push/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint }),
        });
      }
      setStatus("unsubscribed");
    } catch (err) {
      console.error("[push:toggle] unsubscribe failed:", err);
    } finally {
      setBusy(false);
    }
  };

  // ----- Render branches -----

  if (status === "unknown") {
    return (
      <div className="h-10 w-full motion-safe:animate-pulse rounded-lg bg-brand-sage/10" />
    );
  }

  if (status === "unsupported") {
    return (
      <p className="text-xs italic text-brand-sage">
        Browser push not supported on this device or browser.
      </p>
    );
  }

  if (status === "not-configured") {
    return (
      <p className="text-xs italic text-brand-sage">
        Browser push not configured on the server yet (admin: set
        VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).
      </p>
    );
  }

  if (status === "denied") {
    return (
      <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-400">
        Notifications are blocked for this site. Re-enable them in your
        browser&apos;s site settings, then refresh.
      </div>
    );
  }

  if (status === "subscribed") {
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-brand-bark dark:text-brand-cream">
          <Check className="h-4 w-4 text-brand-forest" />
          Browser push is on for this device.
        </div>
        <button
          type="button"
          onClick={unsubscribe}
          disabled={busy}
          className={cn(
            "flex items-center gap-1.5 rounded-md border border-brand-sage/30 px-3 py-1.5 text-xs font-medium text-brand-sage transition-colors hover:bg-brand-sage/10",
            busy && "opacity-50",
          )}
        >
          <BellOff className="h-3.5 w-3.5" />
          Turn off
        </button>
      </div>
    );
  }

  // unsubscribed
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="text-sm text-brand-bark dark:text-brand-cream">
        Get deadline + draw-result reminders on this device.
      </div>
      <button
        type="button"
        onClick={subscribe}
        disabled={busy}
        className={cn(
          "flex items-center gap-1.5 rounded-md bg-brand-forest px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-forest/90",
          busy && "opacity-50",
        )}
      >
        {busy ? (
          <X className="h-3.5 w-3.5 motion-safe:animate-pulse" />
        ) : (
          <Bell className="h-3.5 w-3.5" />
        )}
        Enable
      </button>
    </div>
  );
}
