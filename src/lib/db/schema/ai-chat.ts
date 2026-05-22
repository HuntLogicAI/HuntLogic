import { relations } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  index,
} from "drizzle-orm/pg-core";

// ========================
// AI CHAT SESSIONS
// ========================

export const aiChatSessions = pgTable(
  "ai_chat_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    unitId: text("unit_id"),
    // Short summary so the admin transcript browser can render a list
    // without re-querying messages. Derived from the first user message.
    title: text("title"),
    messageCount: integer("message_count").notNull().default(0),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("ai_chat_sessions_user_id_idx").on(table.userId),
    index("ai_chat_sessions_last_message_at_idx").on(table.lastMessageAt),
  ]
);

// ========================
// AI CHAT MESSAGES
// ========================

export const aiChatMessages = pgTable(
  "ai_chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => aiChatSessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // 'user' | 'assistant'
    content: text("content").notNull(),
    citations: jsonb("citations"),
    // ── Observability columns (added 2026-05) ───────────────────────────────
    feedbackRating: text("feedback_rating"), // 'up' | 'down' | null
    feedbackReason: text("feedback_reason"),
    feedbackAt: timestamp("feedback_at", { withTimezone: true }),
    flagged: boolean("flagged").notNull().default(false),
    flaggedReason: text("flagged_reason"),
    model: text("model"), // 'claude-sonnet-4', 'gemini-1.5', etc.
    latencyMs: integer("latency_ms"),
    tokenCount: integer("token_count"),
    promptVersion: text("prompt_version"), // A/B testing harness hook
    contextSummary: text("context_summary"), // short blurb of grounding context
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("ai_chat_messages_session_id_idx").on(table.sessionId),
    index("ai_chat_messages_feedback_rating_idx").on(table.feedbackRating),
    index("ai_chat_messages_flagged_idx").on(table.flagged),
    index("ai_chat_messages_model_idx").on(table.model),
    index("ai_chat_messages_created_at_idx").on(table.createdAt),
  ]
);

// ========================
// RELATIONS
// ========================

export const aiChatSessionsRelations = relations(
  aiChatSessions,
  ({ many }) => ({
    messages: many(aiChatMessages),
  })
);

export const aiChatMessagesRelations = relations(
  aiChatMessages,
  ({ one }) => ({
    session: one(aiChatSessions, {
      fields: [aiChatMessages.sessionId],
      references: [aiChatSessions.id],
    }),
  })
);
