import { relations } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  uniqueIndex,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { states, species } from "./hunting";

// ========================
// STATE REGULATIONS (official regulation documents per state)
// ========================

export const stateRegulations = pgTable(
  "state_regulations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stateId: uuid("state_id")
      .notNull()
      .references(() => states.id, { onDelete: "cascade" }),
    docType: text("doc_type").notNull(), // 'big_game_application' | 'big_game_field_regs' | 'upland_game' | 'waterfowl' | 'turkey' | 'admin_rules' | 'hunt_planner' | 'general_hunting'
    title: text("title").notNull(),
    url: text("url").notNull(),
    format: text("format"), // 'pdf' | 'html' | 'interactive'
    year: integer("year"),
    description: text("description"),
    lastVerified: timestamp("last_verified", { withTimezone: true }),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("state_regulations_state_id_idx").on(table.stateId),
    index("state_regulations_doc_type_idx").on(table.docType),
    index("state_regulations_year_idx").on(table.year),
    index("state_regulations_enabled_idx").on(table.enabled),
    uniqueIndex("state_regulations_unique_idx").on(
      table.stateId,
      table.docType,
      table.year
    ),
  ]
);

// ========================
// STATE REGULATION RULES (structured, queryable rules extracted from regs)
// ========================
//
// The stateRegulations table above stores *documents* (URLs + metadata).
// This table stores *rules* — atomic, queryable facts extracted from those
// documents so Grizz can answer compliance questions ("is .22 LR legal for
// elk in Colorado?", "do I need non-toxic shot for pheasants in IA?") from
// rows instead of having to re-read a PDF every time.
//
// The `value` JSONB column carries rule-type-specific payload. See the
// docs/regulations-rule-vocabulary.md file for the canonical shapes.

export const stateRegulationRules = pgTable(
  "state_regulation_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stateId: uuid("state_id")
      .notNull()
      .references(() => states.id, { onDelete: "cascade" }),
    // Null = applies to all species (e.g. statewide non-toxic shot rule on
    // public lakes). Specific species id when the rule is species-targeted
    // (e.g. caliber min for elk).
    speciesId: uuid("species_id").references(() => species.id, {
      onDelete: "cascade",
    }),

    // Controlled vocabulary — see docs/regulations-rule-vocabulary.md
    // Examples: 'weapon_legal', 'caliber_min', 'non_toxic_shot_required',
    // 'sunday_hunting_legal', 'antler_restriction', 'baiting_legal',
    // 'hounding_legal', 'crossbow_during_archery', 'orange_minimum',
    // 'cwd_carcass_transport', 'bag_limit_daily', 'magazine_limit', etc.
    ruleType: text("rule_type").notNull(),

    // Optional further scoping — null means applies to any season/weapon.
    seasonType: text("season_type"), // 'archery' | 'firearm' | 'muzzleloader' | 'crossbow' | 'youth' | 'late_antlerless' | etc.
    weaponType: text("weapon_type"), // 'rifle' | 'shotgun' | 'handgun' | 'bow' | 'crossbow' | 'muzzleloader' | 'air_rifle' | etc.

    // Shape varies by ruleType. See vocabulary doc for canonical payloads.
    // Stored as JSONB so we can index specific keys via Postgres operators.
    value: jsonb("value").notNull(),

    // Geographic scope inside the state.
    // 'statewide' for state-wide rules; otherwise the zone/unit/county code
    // that defines where the rule applies.
    zoneScope: text("zone_scope").notNull().default("statewide"),

    // What year is this rule valid for? null expires_year = currently active.
    effectiveYear: integer("effective_year").notNull(),
    expiresYear: integer("expires_year"),

    // Provenance — where did we extract this from? Tie back to the
    // stateRegulations document when possible.
    sourceRegulationId: uuid("source_regulation_id").references(
      () => stateRegulations.id,
      { onDelete: "set null" },
    ),
    sourceUrl: text("source_url"),
    sourceQuote: text("source_quote"), // short verbatim quote for citation
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("state_regulation_rules_state_idx").on(table.stateId),
    index("state_regulation_rules_species_idx").on(table.speciesId),
    index("state_regulation_rules_rule_type_idx").on(table.ruleType),
    index("state_regulation_rules_state_rule_idx").on(
      table.stateId,
      table.ruleType,
    ),
    index("state_regulation_rules_state_species_rule_idx").on(
      table.stateId,
      table.speciesId,
      table.ruleType,
    ),
    index("state_regulation_rules_effective_year_idx").on(table.effectiveYear),
  ],
);

// ========================
// RELATIONS
// ========================

export const stateRegulationsRelations = relations(
  stateRegulations,
  ({ one, many }) => ({
    state: one(states, {
      fields: [stateRegulations.stateId],
      references: [states.id],
    }),
    rules: many(stateRegulationRules),
  }),
);

export const stateRegulationRulesRelations = relations(
  stateRegulationRules,
  ({ one }) => ({
    state: one(states, {
      fields: [stateRegulationRules.stateId],
      references: [states.id],
    }),
    species: one(species, {
      fields: [stateRegulationRules.speciesId],
      references: [species.id],
    }),
    sourceRegulation: one(stateRegulations, {
      fields: [stateRegulationRules.sourceRegulationId],
      references: [stateRegulations.id],
    }),
  }),
);
