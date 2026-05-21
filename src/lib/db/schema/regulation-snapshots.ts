import { relations } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { states, species } from "./hunting";
import { dataSources } from "./data-sources";

// ========================
// REGULATION SNAPSHOTS — versioned, hash-keyed copies of agency rule docs.
// Lets us answer "what changed between 2026 and 2027 regs for CO elk?" by
// diffing the structured payload, and lets the concierge cite a specific
// snapshot rather than a moving target.
// ========================

export const regulationSnapshots = pgTable(
  "regulation_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stateId: uuid("state_id")
      .notNull()
      .references(() => states.id, { onDelete: "cascade" }),
    speciesId: uuid("species_id").references(() => species.id, {
      onDelete: "set null",
    }),
    year: integer("year").notNull(),
    // 'big_game_regs' | 'small_game_regs' | 'turkey_regs' | 'waterfowl_regs'
    // | 'application_brochure' | 'hunt_planner' | 'admin_rules' | 'season_summary'
    docType: text("doc_type").notNull(),
    title: text("title").notNull(),
    url: text("url"),
    sourceUrl: text("source_url"), // canonical agency URL (may differ from `url` if mirrored)
    contentHash: text("content_hash").notNull(), // SHA-256 of canonicalized content
    contentLength: integer("content_length"),
    rawTextSnippet: text("raw_text_snippet"), // first ~10KB for grounding citations
    // Parsed/extracted structured rules: { seasons: [...], quotas: {...},
    // weapon_restrictions: [...], fees: [...], application_window: {...},
    // nonresident_caps: {...}, point_system_changes: [...], ... }
    extractedRules: jsonb("extracted_rules").notNull().default({}),
    sourceId: uuid("source_id").references(() => dataSources.id, {
      onDelete: "set null",
    }),
    // Link to the snapshot this version replaces — supports change tracking.
    previousSnapshotId: uuid("previous_snapshot_id"),
    // 'active' | 'archived' | 'superseded'
    status: text("status").notNull().default("active"),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("regulation_snapshots_hash_idx").on(
      table.stateId,
      table.docType,
      table.year,
      table.contentHash
    ),
    index("regulation_snapshots_state_year_idx").on(table.stateId, table.year),
    index("regulation_snapshots_doc_type_idx").on(table.docType),
    index("regulation_snapshots_status_idx").on(table.status),
    index("regulation_snapshots_snapshot_at_idx").on(table.snapshotAt),
  ]
);

// ========================
// REGULATION CHANGES — denormalized diff records, one row per detected change
// between two snapshots. Lets the concierge surface "CO cut Unit 12 elk
// quota by 30%" or "WY moved nonresident deadline from May 31 → May 15".
// ========================

export const regulationChanges = pgTable(
  "regulation_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromSnapshotId: uuid("from_snapshot_id")
      .notNull()
      .references(() => regulationSnapshots.id, { onDelete: "cascade" }),
    toSnapshotId: uuid("to_snapshot_id")
      .notNull()
      .references(() => regulationSnapshots.id, { onDelete: "cascade" }),
    stateId: uuid("state_id")
      .notNull()
      .references(() => states.id, { onDelete: "cascade" }),
    speciesId: uuid("species_id").references(() => species.id, {
      onDelete: "set null",
    }),
    // 'quota_change' | 'season_dates' | 'fee_change' | 'weapon_rule'
    // | 'deadline_change' | 'point_system' | 'unit_boundary' | 'eligibility'
    // | 'new_opportunity' | 'closure' | 'other'
    changeType: text("change_type").notNull(),
    // 'critical' | 'high' | 'medium' | 'low' — drives whether we proactively
    // notify users vs. surface only on next playbook regen.
    severity: text("severity").notNull().default("medium"),
    fieldPath: text("field_path"), // JSON path into extracted_rules (e.g. "quotas.unit_12.rifle")
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value"),
    summary: text("summary").notNull(), // human-readable one-liner
    impact: text("impact"), // longer impact narrative
    affectsUnitCodes: jsonb("affects_unit_codes").notNull().default([]), // string[]
    detectedAt: timestamp("detected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("regulation_changes_state_idx").on(table.stateId),
    index("regulation_changes_species_idx").on(table.speciesId),
    index("regulation_changes_type_idx").on(table.changeType),
    index("regulation_changes_severity_idx").on(table.severity),
    index("regulation_changes_detected_idx").on(table.detectedAt),
    index("regulation_changes_from_snapshot_idx").on(table.fromSnapshotId),
    index("regulation_changes_to_snapshot_idx").on(table.toSnapshotId),
  ]
);

// ========================
// RELATIONS
// ========================

export const regulationSnapshotsRelations = relations(
  regulationSnapshots,
  ({ one, many }) => ({
    state: one(states, {
      fields: [regulationSnapshots.stateId],
      references: [states.id],
    }),
    species: one(species, {
      fields: [regulationSnapshots.speciesId],
      references: [species.id],
    }),
    source: one(dataSources, {
      fields: [regulationSnapshots.sourceId],
      references: [dataSources.id],
    }),
    changesFrom: many(regulationChanges, { relationName: "from_snapshot" }),
    changesTo: many(regulationChanges, { relationName: "to_snapshot" }),
  })
);

export const regulationChangesRelations = relations(
  regulationChanges,
  ({ one }) => ({
    fromSnapshot: one(regulationSnapshots, {
      fields: [regulationChanges.fromSnapshotId],
      references: [regulationSnapshots.id],
      relationName: "from_snapshot",
    }),
    toSnapshot: one(regulationSnapshots, {
      fields: [regulationChanges.toSnapshotId],
      references: [regulationSnapshots.id],
      relationName: "to_snapshot",
    }),
    state: one(states, {
      fields: [regulationChanges.stateId],
      references: [states.id],
    }),
    species: one(species, {
      fields: [regulationChanges.speciesId],
      references: [species.id],
    }),
  })
);
