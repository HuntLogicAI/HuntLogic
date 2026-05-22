import { relations } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  decimal,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { states, species, huntUnits } from "./hunting";
import { recommendations } from "./recommendations";
import { stateCredentials } from "./credentials";
import { huntGroups } from "./groups";

// ========================
// STATE FEE SCHEDULES (state/species/residency/year fee data)
// ========================

export const stateFeeSchedules = pgTable(
  "state_fee_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stateId: uuid("state_id")
      .notNull()
      .references(() => states.id),
    speciesId: uuid("species_id")
      .notNull()
      .references(() => species.id),
    year: integer("year").notNull(),
    residency: text("residency").notNull(), // 'resident' | 'nonresident'
    feeType: text("fee_type").notNull(), // 'license' | 'application' | 'tag' | 'preference_point' | 'habitat_stamp' | 'conservation'
    feeName: text("fee_name").notNull(),
    amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
    required: boolean("required").notNull().default(true),
    notes: text("notes"),
    sourceUrl: text("source_url"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("state_fee_schedules_unique_idx").on(
      table.stateId,
      table.speciesId,
      table.year,
      table.residency,
      table.feeType
    ),
    index("state_fee_schedules_state_id_idx").on(table.stateId),
    index("state_fee_schedules_species_id_idx").on(table.speciesId),
    index("state_fee_schedules_year_idx").on(table.year),
    index("state_fee_schedules_state_year_idx").on(table.stateId, table.year),
  ]
);

// ========================
// SERVICE FEE CONFIG (HuntLogic's per-tier service fees)
// ========================

export const serviceFeeConfig = pgTable(
  "service_fee_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tier: text("tier").notNull(), // 'scout' | 'pro' | 'elite'
    feeType: text("fee_type").notNull(), // 'per_application' | 'per_state' | 'rush' | 'group_discount'
    label: text("label").notNull(),
    amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
    isPercentage: boolean("is_percentage").notNull().default(false),
    active: boolean("active").notNull().default(true),
    effectiveFrom: timestamp("effective_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    effectiveUntil: timestamp("effective_until", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("service_fee_config_unique_idx").on(
      table.tier,
      table.feeType
    ),
    index("service_fee_config_tier_idx").on(table.tier),
    index("service_fee_config_active_idx").on(table.active),
  ]
);

// ========================
// APPLICATION ORDERS (parent order, one per checkout)
// ========================

export const applicationOrders = pgTable(
  "application_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupId: uuid("group_id").references(() => huntGroups.id, {
      onDelete: "set null",
    }),
    year: integer("year").notNull(),
    tier: text("tier").notNull(), // 'scout' | 'pro' | 'elite'
    // 'draft' | 'pending_payment' | 'paid' | 'in_progress' | 'submitted'
    // | 'completed' | 'cancelled' | 'refunded' | 'disputed'
    // (the webhook writes 'disputed' when Stripe fires charge.dispute.created;
    // ops queues should treat it as a hold state requiring manual review.)
    status: text("status").notNull().default("draft"),
    stateFeeTotal: decimal("state_fee_total", { precision: 10, scale: 2 })
      .notNull()
      .default("0"),
    serviceFeeTotal: decimal("service_fee_total", { precision: 10, scale: 2 })
      .notNull()
      .default("0"),
    grandTotal: decimal("grand_total", { precision: 10, scale: 2 })
      .notNull()
      .default("0"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    notes: text("notes"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("application_orders_user_id_idx").on(table.userId),
    index("application_orders_group_id_idx").on(table.groupId),
    index("application_orders_status_idx").on(table.status),
    index("application_orders_year_idx").on(table.year),
    index("application_orders_user_year_idx").on(table.userId, table.year),
    index("application_orders_stripe_pi_idx").on(table.stripePaymentIntentId),
  ]
);

// ========================
// APPLICATION ORDER ITEMS (individual applications within an order)
// ========================

export const applicationOrderItems = pgTable(
  "application_order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => applicationOrders.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    stateId: uuid("state_id")
      .notNull()
      .references(() => states.id),
    speciesId: uuid("species_id")
      .notNull()
      .references(() => species.id),
    huntUnitId: uuid("hunt_unit_id").references(() => huntUnits.id, {
      onDelete: "set null",
    }),
    recommendationId: uuid("recommendation_id").references(
      () => recommendations.id,
      { onDelete: "set null" }
    ),
    credentialId: uuid("credential_id").references(
      () => stateCredentials.id,
      { onDelete: "set null" }
    ),
    residency: text("residency").notNull(), // 'resident' | 'nonresident'
    huntType: text("hunt_type"), // 'rifle' | 'archery' | 'muzzleloader'
    choiceRank: integer("choice_rank").notNull().default(1),
    stateFee: decimal("state_fee", { precision: 10, scale: 2 })
      .notNull()
      .default("0"),
    serviceFee: decimal("service_fee", { precision: 10, scale: 2 })
      .notNull()
      .default("0"),
    status: text("status").notNull().default("pending"), // 'pending' | 'in_progress' | 'submitted' | 'confirmed' | 'drawn' | 'unsuccessful' | 'failed' | 'cancelled'
    confirmationNumber: text("confirmation_number"),
    formData: jsonb("form_data").notNull().default({}), // completed form field values
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("app_order_items_order_id_idx").on(table.orderId),
    index("app_order_items_user_id_idx").on(table.userId),
    index("app_order_items_state_species_idx").on(
      table.stateId,
      table.speciesId
    ),
    index("app_order_items_status_idx").on(table.status),
    index("app_order_items_recommendation_id_idx").on(table.recommendationId),
    index("app_order_items_credential_id_idx").on(table.credentialId),
  ]
);

// ========================
// PAYMENTS (Stripe payment records)
// ========================

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => applicationOrders.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    stripePaymentIntentId: text("stripe_payment_intent_id").notNull().unique(),
    stripeChargeId: text("stripe_charge_id"),
    amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("usd"),
    status: text("status").notNull().default("pending"), // 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled' | 'refunded' | 'partially_refunded'
    paymentMethod: text("payment_method"), // 'card' | 'us_bank_account'
    last4: text("last4"),
    receiptUrl: text("receipt_url"),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    metadata: jsonb("metadata").notNull().default({}),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("payments_order_id_idx").on(table.orderId),
    index("payments_user_id_idx").on(table.userId),
    index("payments_stripe_pi_idx").on(table.stripePaymentIntentId),
    index("payments_status_idx").on(table.status),
    index("payments_user_status_idx").on(table.userId, table.status),
  ]
);

// ========================
// REFUNDS (refund tracking)
// ========================

export const refunds = pgTable(
  "refunds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => applicationOrders.id, { onDelete: "cascade" }),
    orderItemId: uuid("order_item_id").references(
      () => applicationOrderItems.id,
      { onDelete: "set null" }
    ),
    stripeRefundId: text("stripe_refund_id").unique(),
    amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
    reason: text("reason").notNull(), // 'customer_request' | 'application_failed' | 'duplicate' | 'deadline_missed' | 'other'
    status: text("status").notNull().default("pending"), // 'pending' | 'processing' | 'succeeded' | 'failed'
    notes: text("notes"),
    initiatedBy: text("initiated_by"), // 'system' | 'ops' | 'customer'
    processedAt: timestamp("processed_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("refunds_payment_id_idx").on(table.paymentId),
    index("refunds_order_id_idx").on(table.orderId),
    index("refunds_order_item_id_idx").on(table.orderItemId),
    index("refunds_status_idx").on(table.status),
    index("refunds_stripe_refund_id_idx").on(table.stripeRefundId),
  ]
);

// ========================
// STATE FORM CONFIGS (dynamic form schemas per state)
// ========================

export const stateFormConfigs = pgTable(
  "state_form_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stateId: uuid("state_id")
      .notNull()
      .references(() => states.id),
    speciesId: uuid("species_id").references(() => species.id),
    formType: text("form_type").notNull(), // 'application' | 'license' | 'preference_point' | 'bonus_point'
    year: integer("year").notNull(),
    schema: jsonb("schema").notNull(), // JSON Schema for form fields
    fieldMapping: jsonb("field_mapping").notNull().default({}), // maps HuntLogic fields to state form fields
    validationRules: jsonb("validation_rules").notNull().default({}),
    submissionUrl: text("submission_url"),
    instructions: text("instructions"),
    active: boolean("active").notNull().default(true),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("state_form_configs_unique_idx").on(
      table.stateId,
      table.speciesId,
      table.formType,
      table.year
    ),
    index("state_form_configs_state_id_idx").on(table.stateId),
    index("state_form_configs_form_type_idx").on(table.formType),
    index("state_form_configs_year_idx").on(table.year),
    index("state_form_configs_active_idx").on(table.active),
  ]
);

// ========================
// FULFILLMENT LOGS (ops audit trail)
// ========================

export const fulfillmentLogs = pgTable(
  "fulfillment_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => applicationOrders.id, { onDelete: "cascade" }),
    orderItemId: uuid("order_item_id").references(
      () => applicationOrderItems.id,
      { onDelete: "set null" }
    ),
    opsUserId: uuid("ops_user_id").references(() => opsUsers.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(), // 'assigned' | 'started' | 'form_filled' | 'submitted' | 'confirmed' | 'failed' | 'retried' | 'escalated' | 'note_added'
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    details: text("details"),
    screenshotUrl: text("screenshot_url"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("fulfillment_logs_order_id_idx").on(table.orderId),
    index("fulfillment_logs_order_item_id_idx").on(table.orderItemId),
    index("fulfillment_logs_ops_user_id_idx").on(table.opsUserId),
    index("fulfillment_logs_action_idx").on(table.action),
    index("fulfillment_logs_created_at_idx").on(table.createdAt),
  ]
);

// ========================
// OPS USERS (internal operations team)
// ========================

export const opsUsers = pgTable(
  "ops_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash"),
    role: text("role").notNull().default("agent"), // 'admin' | 'supervisor' | 'agent'
    active: boolean("active").notNull().default(true),
    assignedStates: jsonb("assigned_states").notNull().default([]), // state codes this agent handles
    maxConcurrent: integer("max_concurrent").notNull().default(10),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("ops_users_email_idx").on(table.email),
    index("ops_users_role_idx").on(table.role),
    index("ops_users_active_idx").on(table.active),
  ]
);

// ========================
// RELATIONS
// ========================

export const stateFeeSchedulesRelations = relations(
  stateFeeSchedules,
  ({ one }) => ({
    state: one(states, {
      fields: [stateFeeSchedules.stateId],
      references: [states.id],
    }),
    species: one(species, {
      fields: [stateFeeSchedules.speciesId],
      references: [species.id],
    }),
  })
);

export const applicationOrdersRelations = relations(
  applicationOrders,
  ({ one, many }) => ({
    user: one(users, {
      fields: [applicationOrders.userId],
      references: [users.id],
    }),
    group: one(huntGroups, {
      fields: [applicationOrders.groupId],
      references: [huntGroups.id],
    }),
    items: many(applicationOrderItems),
    payments: many(payments),
    refunds: many(refunds),
    fulfillmentLogs: many(fulfillmentLogs),
  })
);

export const applicationOrderItemsRelations = relations(
  applicationOrderItems,
  ({ one }) => ({
    order: one(applicationOrders, {
      fields: [applicationOrderItems.orderId],
      references: [applicationOrders.id],
    }),
    user: one(users, {
      fields: [applicationOrderItems.userId],
      references: [users.id],
    }),
    state: one(states, {
      fields: [applicationOrderItems.stateId],
      references: [states.id],
    }),
    species: one(species, {
      fields: [applicationOrderItems.speciesId],
      references: [species.id],
    }),
    huntUnit: one(huntUnits, {
      fields: [applicationOrderItems.huntUnitId],
      references: [huntUnits.id],
    }),
    recommendation: one(recommendations, {
      fields: [applicationOrderItems.recommendationId],
      references: [recommendations.id],
    }),
    credential: one(stateCredentials, {
      fields: [applicationOrderItems.credentialId],
      references: [stateCredentials.id],
    }),
  })
);

export const paymentsRelations = relations(payments, ({ one, many }) => ({
  order: one(applicationOrders, {
    fields: [payments.orderId],
    references: [applicationOrders.id],
  }),
  user: one(users, {
    fields: [payments.userId],
    references: [users.id],
  }),
  refunds: many(refunds),
}));

export const refundsRelations = relations(refunds, ({ one }) => ({
  payment: one(payments, {
    fields: [refunds.paymentId],
    references: [payments.id],
  }),
  order: one(applicationOrders, {
    fields: [refunds.orderId],
    references: [applicationOrders.id],
  }),
  orderItem: one(applicationOrderItems, {
    fields: [refunds.orderItemId],
    references: [applicationOrderItems.id],
  }),
}));

export const stateFormConfigsRelations = relations(
  stateFormConfigs,
  ({ one }) => ({
    state: one(states, {
      fields: [stateFormConfigs.stateId],
      references: [states.id],
    }),
    species: one(species, {
      fields: [stateFormConfigs.speciesId],
      references: [species.id],
    }),
  })
);

export const fulfillmentLogsRelations = relations(
  fulfillmentLogs,
  ({ one }) => ({
    order: one(applicationOrders, {
      fields: [fulfillmentLogs.orderId],
      references: [applicationOrders.id],
    }),
    orderItem: one(applicationOrderItems, {
      fields: [fulfillmentLogs.orderItemId],
      references: [applicationOrderItems.id],
    }),
    opsUser: one(opsUsers, {
      fields: [fulfillmentLogs.opsUserId],
      references: [opsUsers.id],
    }),
  })
);

export const opsUsersRelations = relations(opsUsers, ({ many }) => ({
  fulfillmentLogs: many(fulfillmentLogs),
}));
