import { relations } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  real,
  jsonb,
  date,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { states, species, huntUnits } from "./hunting";
import { dataSources } from "./data-sources";

// ========================
// DRAW ODDS (historical, per unit/species/state/year)
// ========================

export const drawOdds = pgTable(
  "draw_odds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stateId: uuid("state_id")
      .notNull()
      .references(() => states.id, { onDelete: "cascade" }),
    speciesId: uuid("species_id")
      .notNull()
      .references(() => species.id, { onDelete: "cascade" }),
    huntUnitId: uuid("hunt_unit_id").references(() => huntUnits.id, {
      onDelete: "set null",
    }),
    year: integer("year").notNull(),
    residentType: text("resident_type").notNull(), // 'resident' | 'nonresident'
    weaponType: text("weapon_type"),
    choiceRank: integer("choice_rank"), // 1st, 2nd, etc.
    totalApplicants: integer("total_applicants"),
    totalTags: integer("total_tags"),
    minPointsDrawn: integer("min_points_drawn"),
    maxPointsDrawn: integer("max_points_drawn"),
    avgPointsDrawn: real("avg_points_drawn"),
    drawRate: real("draw_rate"), // 0.0 to 1.0
    // ----- Point-system normalization (added 2026-05) -----
    // Categorizes the underlying point math so cross-state comparison is possible.
    pointSystemType: text("point_system_type"), // 'pure_preference' | 'bonus' | 'bonus_squared' | 'weighted_preference' | 'random' | 'none'
    // Normalized "effective preference-equivalent points" computed from
    // minPointsDrawn under the point_system_type math. Lets the ML forecaster
    // compare AZ bonus, NV bonus², UT 50/50, CO preference on one axis.
    effectivePoints: real("effective_points"),
    sourceId: uuid("source_id").references(() => dataSources.id, {
      onDelete: "set null",
    }),
    rawData: jsonb("raw_data").notNull().default({}), // preserve original data shape
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("draw_odds_unique_idx").on(
      table.stateId,
      table.speciesId,
      table.huntUnitId,
      table.year,
      table.residentType,
      table.weaponType,
      table.choiceRank
    ),
    index("draw_odds_state_species_idx").on(table.stateId, table.speciesId),
    index("draw_odds_year_idx").on(table.year),
    index("draw_odds_hunt_unit_idx").on(table.huntUnitId),
    index("draw_odds_source_idx").on(table.sourceId),
  ]
);

// ========================
// HARVEST STATS
// ========================

export const harvestStats = pgTable(
  "harvest_stats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stateId: uuid("state_id")
      .notNull()
      .references(() => states.id, { onDelete: "cascade" }),
    speciesId: uuid("species_id")
      .notNull()
      .references(() => species.id, { onDelete: "cascade" }),
    huntUnitId: uuid("hunt_unit_id").references(() => huntUnits.id, {
      onDelete: "set null",
    }),
    year: integer("year").notNull(),
    weaponType: text("weapon_type"),
    totalHunters: integer("total_hunters"),
    totalHarvest: integer("total_harvest"),
    successRate: real("success_rate"), // 0.0 to 1.0
    avgDaysHunted: real("avg_days_hunted"),
    trophyMetrics: jsonb("trophy_metrics"), // B&C scores, age class data, etc.
    sourceId: uuid("source_id").references(() => dataSources.id, {
      onDelete: "set null",
    }),
    rawData: jsonb("raw_data").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("harvest_stats_unique_idx").on(
      table.stateId,
      table.speciesId,
      table.huntUnitId,
      table.year,
      table.weaponType
    ),
    index("harvest_stats_state_species_idx").on(
      table.stateId,
      table.speciesId
    ),
    index("harvest_stats_year_idx").on(table.year),
    index("harvest_stats_hunt_unit_idx").on(table.huntUnitId),
  ]
);

// ========================
// SEASONS (dynamic per state/species/year)
// ========================

export const seasons = pgTable(
  "seasons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stateId: uuid("state_id")
      .notNull()
      .references(() => states.id, { onDelete: "cascade" }),
    speciesId: uuid("species_id")
      .notNull()
      .references(() => species.id, { onDelete: "cascade" }),
    huntUnitId: uuid("hunt_unit_id").references(() => huntUnits.id, {
      onDelete: "set null",
    }),
    year: integer("year").notNull(),
    seasonName: text("season_name"), // 'General Rifle', '1st Archery', etc.
    weaponType: text("weapon_type"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    tagType: text("tag_type"), // 'draw' | 'otc' | 'leftover'
    quota: integer("quota"),
    config: jsonb("config").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("seasons_state_species_idx").on(table.stateId, table.speciesId),
    index("seasons_year_idx").on(table.year),
    index("seasons_hunt_unit_idx").on(table.huntUnitId),
    index("seasons_start_date_idx").on(table.startDate),
  ]
);

// ========================
// DEADLINES (application deadlines and important dates)
// ========================

export const deadlines = pgTable(
  "deadlines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stateId: uuid("state_id")
      .notNull()
      .references(() => states.id, { onDelete: "cascade" }),
    speciesId: uuid("species_id").references(() => species.id, {
      onDelete: "set null",
    }),
    year: integer("year").notNull(),
    deadlineType: text("deadline_type").notNull(), // 'application' | 'point_purchase' | 'refund' | 'results'
    title: text("title").notNull(),
    description: text("description"),
    deadlineDate: date("deadline_date").notNull(),
    reminderDaysBefore: jsonb("reminder_days_before")
      .notNull()
      .default([30, 14, 7, 3, 1]),
    url: text("url"), // link to state agency page
    config: jsonb("config").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("deadlines_state_id_idx").on(table.stateId),
    index("deadlines_year_idx").on(table.year),
    index("deadlines_deadline_date_idx").on(table.deadlineDate),
    index("deadlines_type_idx").on(table.deadlineType),
    index("deadlines_state_year_idx").on(table.stateId, table.year),
  ]
);

// ========================
// RELATIONS
// ========================

export const drawOddsRelations = relations(drawOdds, ({ one }) => ({
  state: one(states, {
    fields: [drawOdds.stateId],
    references: [states.id],
  }),
  species: one(species, {
    fields: [drawOdds.speciesId],
    references: [species.id],
  }),
  huntUnit: one(huntUnits, {
    fields: [drawOdds.huntUnitId],
    references: [huntUnits.id],
  }),
  source: one(dataSources, {
    fields: [drawOdds.sourceId],
    references: [dataSources.id],
  }),
}));

export const harvestStatsRelations = relations(harvestStats, ({ one }) => ({
  state: one(states, {
    fields: [harvestStats.stateId],
    references: [states.id],
  }),
  species: one(species, {
    fields: [harvestStats.speciesId],
    references: [species.id],
  }),
  huntUnit: one(huntUnits, {
    fields: [harvestStats.huntUnitId],
    references: [huntUnits.id],
  }),
  source: one(dataSources, {
    fields: [harvestStats.sourceId],
    references: [dataSources.id],
  }),
}));

export const seasonsRelations = relations(seasons, ({ one }) => ({
  state: one(states, {
    fields: [seasons.stateId],
    references: [states.id],
  }),
  species: one(species, {
    fields: [seasons.speciesId],
    references: [species.id],
  }),
  huntUnit: one(huntUnits, {
    fields: [seasons.huntUnitId],
    references: [huntUnits.id],
  }),
}));

export const deadlinesRelations = relations(deadlines, ({ one }) => ({
  state: one(states, {
    fields: [deadlines.stateId],
    references: [states.id],
  }),
  species: one(species, {
    fields: [deadlines.speciesId],
    references: [species.id],
  }),
}));
