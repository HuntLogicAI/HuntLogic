"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Send, Check, ExternalLink, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Connect / disconnect the Telegram concierge channel ("Grizz in your pocket").
 *
 * Flow:
 *   1. Tap "Connect Telegram" → POST /messaging/telegram/link mints a one-time
 *      token and returns a t.me deep link.
 *   2. We open the deep link (Telegram opens with /start <token>) and poll the
 *      status endpoint until the bot webhook confirms the binding.
 *
 * The link token is short-lived and single-use; we never render it through a
 * third-party QR service (that would leak the token), so connecting is done by
 * tapping the link — best on the phone where Telegram lives.
 */

type Status =
  | "loading"
  | "disabled"
  | "disconnected"
  | "connecting"
  | "connected";

export function ConnectTelegram() {
  const [status, setStatus] = useState<Status>("loading");
  const [botHandle, setBotHandle] = useState("");
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const fetchStatus = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/v1/messaging/telegram");
      if (!res.ok) {
        setStatus("disabled");
        return false;
      }
      const j = await res.json();
      setBotHandle(j.botHandle ?? "");
      if (!j.enabled) {
        setStatus("disabled");
        return false;
      }
      if (j.connected) {
        setDisplayName(j.displayName ?? null);
        setStatus("connected");
        return true;
      }
      setStatus((s) => (s === "connecting" ? "connecting" : "disconnected"));
      return false;
    } catch {
      setStatus("disabled");
      return false;
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    return () => stopPolling();
  }, [fetchStatus, stopPolling]);

  const connect = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/v1/messaging/telegram/link", {
        method: "POST",
      });
      if (!res.ok) {
        await fetchStatus();
        return;
      }
      const j = await res.json();
      setDeepLink(j.deepLink);
      setStatus("connecting");
      // Open Telegram with the start token pre-loaded.
      window.open(j.deepLink, "_blank", "noopener,noreferrer");
      // Poll for the webhook to confirm the binding (~1 min).
      stopPolling();
      let tries = 0;
      pollRef.current = setInterval(async () => {
        tries += 1;
        const done = await fetchStatus();
        if (done || tries >= 20) stopPolling();
      }, 3000);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (busy) return;
    setBusy(true);
    stopPolling();
    try {
      await fetch("/api/v1/messaging/telegram", { method: "DELETE" });
      setDeepLink(null);
      setDisplayName(null);
      setStatus("disconnected");
    } finally {
      setBusy(false);
    }
  };

  // ----- Render branches -----

  if (status === "loading") {
    return (
      <div className="h-10 w-full motion-safe:animate-pulse rounded-lg bg-brand-sage/10" />
    );
  }

  if (status === "disabled") {
    return (
      <p className="text-xs italic text-brand-sage">
        The Telegram concierge isn&apos;t enabled on this deployment yet.
      </p>
    );
  }

  if (status === "connected") {
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-brand-bark dark:text-brand-cream">
          <Check className="h-4 w-4 text-brand-forest" />
          Connected{displayName ? ` as ${displayName}` : ""}. Text {botHandle} anytime.
        </div>
        <button
          type="button"
          onClick={disconnect}
          disabled={busy}
          className={cn(
            "shrink-0 rounded-md border border-brand-sage/30 px-3 py-1.5 text-xs font-medium text-brand-sage transition-colors hover:bg-brand-sage/10",
            busy && "opacity-50",
          )}
        >
          Disconnect
        </button>
      </div>
    );
  }

  if (status === "connecting") {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-brand-bark dark:text-brand-cream">
          <Loader2 className="h-4 w-4 motion-safe:animate-spin text-brand-forest" />
          Waiting for you to tap &quot;Start&quot; in Telegram…
        </div>
        {deepLink && (
          <a
            href={deepLink}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-forest underline underline-offset-2"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open Telegram again
          </a>
        )}
      </div>
    );
  }

  // disconnected
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="text-sm text-brand-bark dark:text-brand-cream">
        Put Grizz in your pocket — deadlines, draw odds, and quick gut-checks over
        Telegram.
      </div>
      <button
        type="button"
        onClick={connect}
        disabled={busy}
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-md bg-brand-forest px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-forest/90",
          busy && "opacity-50",
        )}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" />
        ) : (
          <Send className="h-3.5 w-3.5" />
        )}
        Connect Telegram
      </button>
    </div>
  );
}
