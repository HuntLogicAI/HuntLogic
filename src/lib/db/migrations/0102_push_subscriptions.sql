-- =============================================================================
-- Migration 0102 — Web Push Subscriptions
-- =============================================================================
-- Holds the VAPID-keyed PushSubscription objects browsers hand us when a
-- user opts into notifications. One row per (user, browser endpoint).
--
-- Additive — no destructive ops. Safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The browser's push service endpoint URL.
  endpoint TEXT NOT NULL,
  -- VAPID auth + p256dh keys from the subscription.
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  -- Optional metadata to help ops understand who's subscribed (UA, OS, etc).
  user_agent TEXT,
  -- When the user last opted in / re-subscribed (browser endpoints can churn).
  subscribed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- When we last successfully sent a push to this subscription (used to
  -- prune dead subscriptions on 410 Gone from the push service).
  last_used_at TIMESTAMPTZ,
  -- Subscriptions can be marked inactive without deletion so we keep audit.
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_idx
  ON push_subscriptions(endpoint);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx
  ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS push_subscriptions_active_idx
  ON push_subscriptions(active);
