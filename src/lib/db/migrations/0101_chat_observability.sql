-- =============================================================================
-- Migration 0101 — Chat Observability
-- =============================================================================
-- Adds feedback + telemetry columns to ai_chat_messages so the admin
-- observability dashboard has something to score.
--
-- All additive. Existing rows get NULL for the new fields, which the
-- application treats as "no feedback recorded yet."
-- =============================================================================

ALTER TABLE ai_chat_messages
  ADD COLUMN IF NOT EXISTS feedback_rating TEXT,         -- 'up' | 'down' | NULL
  ADD COLUMN IF NOT EXISTS feedback_reason TEXT,          -- free-text from user
  ADD COLUMN IF NOT EXISTS feedback_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS flagged BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS flagged_reason TEXT,           -- ops note / auto-flag heuristic
  ADD COLUMN IF NOT EXISTS model TEXT,                    -- 'claude-sonnet-4', 'gemini-1.5', etc.
  ADD COLUMN IF NOT EXISTS latency_ms INTEGER,            -- generation latency
  ADD COLUMN IF NOT EXISTS token_count INTEGER,           -- approx output tokens
  ADD COLUMN IF NOT EXISTS prompt_version TEXT,           -- A/B testing harness hook
  ADD COLUMN IF NOT EXISTS context_summary TEXT;          -- short blurb of what RAG/grounding loaded

CREATE INDEX IF NOT EXISTS ai_chat_messages_feedback_rating_idx
  ON ai_chat_messages(feedback_rating);
CREATE INDEX IF NOT EXISTS ai_chat_messages_flagged_idx
  ON ai_chat_messages(flagged);
CREATE INDEX IF NOT EXISTS ai_chat_messages_model_idx
  ON ai_chat_messages(model);
CREATE INDEX IF NOT EXISTS ai_chat_messages_created_at_idx
  ON ai_chat_messages(created_at);

-- Session-level title cache so the admin transcript browser can render a
-- short summary (first user message snippet) without re-querying messages.
ALTER TABLE ai_chat_sessions
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS message_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ai_chat_sessions_last_message_at_idx
  ON ai_chat_sessions(last_message_at);
