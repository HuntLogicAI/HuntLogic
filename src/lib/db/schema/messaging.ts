import { relations } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./users";

// =============================================================================
// MESSAGING CHANNELS — "Grizz in your pocket"
// =============================================================================
// Lets a hunter talk to the concierge over an external messaging channel
// (Telegram first; SMS / WhatsApp / Signal later). The web app stays the place
// you BUILD; the messaging channel is where the relationship LIVES.
//
// Three tables:
//   messaging_identities   — verified binding of (channel, channelUserId) → user
//   messaging_link_tokens  — short-lived single-use tokens for the linking flow
//   messaging_messages     — per-identity conversation history (multi-turn memory)
// =============================================================================

/**
 * A verified link between a HuntLogic user and one external messaging account.
 * `channelUserId` is the channel's own identifier — for Telegram this is the
 * numeric chat ID (stored as text); for SMS/WhatsApp it would be the E.164
 * phone number. Globally unique per (channel, channelUserId) so a given
 * Telegram chat maps to exactly one HuntLogic account.
 */
export const messagingIdentities = pgTable(
  "messaging_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // 'telegram' | 'sms' | 'whatsapp' | 'signal'
    channel: text("channel").notNull(),
    // Channel-native identifier (Telegram chat id, phone number, etc.)
    channelUserId: text("channel_user_id").notNull(),
    // Best-effort human label for the UI ("@mitch" / "Mitch S.")
    displayName: text("display_name"),
    verified: boolean("verified").notNull().default(false),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("messaging_identities_channel_user_idx").on(
      table.channel,
      table.channelUserId,
    ),
    index("messaging_identities_user_id_idx").on(table.userId),
    index("messaging_identities_active_idx").on(table.active),
  ],
);

/**
 * Short-lived, single-use token used to bind a messaging account to a user.
 * Flow: web app mints a token tied to userId → user opens
 * t.me/<bot>?start=<token> → bot webhook receives `/start <token>` → we verify
 * the token (unconsumed + unexpired), create the identity, and consume it.
 */
export const messagingLinkTokens = pgTable(
  "messaging_link_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    token: text("token").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channel: text("channel").notNull().default("telegram"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("messaging_link_tokens_token_idx").on(table.token),
    index("messaging_link_tokens_user_id_idx").on(table.userId),
  ],
);

/**
 * Per-identity conversation log. Powers multi-turn memory (so "what about
 * Wyoming?" works) and gives us an audit/observability trail for the channel.
 * `updateId` stores the channel's message/update id so we can dedupe retried
 * webhook deliveries.
 */
export const messagingMessages = pgTable(
  "messaging_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => messagingIdentities.id, { onDelete: "cascade" }),
    // 'user' | 'assistant'
    role: text("role").notNull(),
    content: text("content").notNull(),
    // Channel-native update/message id, for idempotency on webhook retries.
    updateId: text("update_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("messaging_messages_identity_idx").on(table.identityId),
    index("messaging_messages_identity_created_idx").on(
      table.identityId,
      table.createdAt,
    ),
    index("messaging_messages_update_idx").on(table.identityId, table.updateId),
  ],
);

// ========================
// RELATIONS
// ========================

export const messagingIdentitiesRelations = relations(
  messagingIdentities,
  ({ one, many }) => ({
    user: one(users, {
      fields: [messagingIdentities.userId],
      references: [users.id],
    }),
    messages: many(messagingMessages),
  }),
);

export const messagingLinkTokensRelations = relations(
  messagingLinkTokens,
  ({ one }) => ({
    user: one(users, {
      fields: [messagingLinkTokens.userId],
      references: [users.id],
    }),
  }),
);

export const messagingMessagesRelations = relations(
  messagingMessages,
  ({ one }) => ({
    identity: one(messagingIdentities, {
      fields: [messagingMessages.identityId],
      references: [messagingIdentities.id],
    }),
  }),
);
