-- =============================================================================
-- Migration 0103 — Messaging Channels ("Grizz in your pocket")
-- =============================================================================
-- Lets a hunter talk to the concierge over an external messaging channel
-- (Telegram first; SMS / WhatsApp / Signal later).
--
--   messaging_identities   — verified binding of (channel, channelUserId) -> user
--   messaging_link_tokens  — short-lived single-use tokens for the linking flow
--   messaging_messages     — per-identity conversation history (multi-turn memory)
--
-- Additive — no destructive ops. Safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS messaging_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'telegram' | 'sms' | 'whatsapp' | 'signal'
  channel TEXT NOT NULL,
  -- Channel-native identifier (Telegram chat id, phone number, etc.)
  channel_user_id TEXT NOT NULL,
  display_name TEXT,
  verified BOOLEAN NOT NULL DEFAULT false,
  verified_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT true,
  last_inbound_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS messaging_identities_channel_user_idx
  ON messaging_identities(channel, channel_user_id);
CREATE INDEX IF NOT EXISTS messaging_identities_user_id_idx
  ON messaging_identities(user_id);
CREATE INDEX IF NOT EXISTS messaging_identities_active_idx
  ON messaging_identities(active);

CREATE TABLE IF NOT EXISTS messaging_link_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'telegram',
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS messaging_link_tokens_token_idx
  ON messaging_link_tokens(token);
CREATE INDEX IF NOT EXISTS messaging_link_tokens_user_id_idx
  ON messaging_link_tokens(user_id);

CREATE TABLE IF NOT EXISTS messaging_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id UUID NOT NULL REFERENCES messaging_identities(id) ON DELETE CASCADE,
  -- 'user' | 'assistant'
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  -- Channel-native update/message id, for idempotency on webhook retries.
  update_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messaging_messages_identity_idx
  ON messaging_messages(identity_id);
CREATE INDEX IF NOT EXISTS messaging_messages_identity_created_idx
  ON messaging_messages(identity_id, created_at);
CREATE INDEX IF NOT EXISTS messaging_messages_update_idx
  ON messaging_messages(identity_id, update_id);
