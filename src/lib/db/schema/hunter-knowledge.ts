import { relations } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  real,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { states, species } from "./hunting";

// ========================
// HUNTER EDUCATION REQUIREMENTS — what a new hunter needs to do to be
// legal in each state. Concierge uses this for the "I'm new, where do I start"
// flow ("In Georgia you need to complete an approved hunter ed course; here are
// 3 free online options").
// ========================

export const hunterEducationRequirements = pgTable(
  "hunter_education_requirements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stateId: uuid("state_id")
      .notNull()
      .references(() => states.id, { onDelete: "cascade" })
      .unique(),
    // Who needs hunter ed: 'all_first_time' | 'born_after_year' | 'age_only' | 'none'
    requiredFor: text("required_for").notNull().default("all_first_time"),
    bornOnOrAfter: integer("born_on_or_after"), // e.g. 1969 in some states
    minimumAge: integer("minimum_age"), // youngest age allowed to take the course
    // Whether unaccompanied hunters need the course; some states allow
    // mentored/apprentice licenses to bypass temporarily.
    apprenticeAllowed: boolean("apprentice_allowed").notNull().default(false),
    apprenticeMaxYears: integer("apprentice_max_years"),
    // Accepted course providers (IHEA-USA, NRA, state-specific online, etc).
    // [{ provider, format: 'in_person' | 'online' | 'hybrid', cost, url }]
    acceptedCourses: jsonb("accepted_courses").notNull().default([]),
    onlineAllowed: boolean("online_allowed").notNull().default(true),
    fieldDayRequired: boolean("field_day_required").notNull().default(false),
    typicalCost: real("typical_cost"),
    // Reciprocity: which other state/country certifications are accepted.
    reciprocity: jsonb("reciprocity").notNull().default([]), // string[] (state codes)
    // Cert # format / how it's recorded on the license app.
    certNumberFormat: text("cert_number_format"),
    // Optional: bow-hunter and trapper ed are sometimes separate requirements.
    bowhunterEdRequired: boolean("bowhunter_ed_required")
      .notNull()
      .default(false),
    trapperEdRequired: boolean("trapper_ed_required").notNull().default(false),
    sourceUrl: text("source_url"),
    notes: text("notes"),
    lastVerified: timestamp("last_verified", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("hunter_education_state_idx").on(table.stateId),
  ]
);

// ========================
// LICENSE TYPES — every license/tag/permit a hunter might buy. Powers the
// "Georgia + shotgun → what license do I need?" answer and the
// new-hunter cost estimator.
// ========================

export const licenseTypes = pgTable(
  "license_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stateId: uuid("state_id")
      .notNull()
      .references(() => states.id, { onDelete: "cascade" }),
    // Optional: many license types are species-specific (deer tag, turkey
    // permit). For broad licenses (combo, sportsman), leave null.
    speciesId: uuid("species_id").references(() => species.id, {
      onDelete: "set null",
    }),
    // 'base_license' | 'big_game_tag' | 'small_game' | 'turkey_permit'
    // | 'waterfowl_stamp' | 'archery_stamp' | 'muzzleloader_stamp'
    // | 'sportsman_combo' | 'lifetime' | 'youth' | 'senior' | 'disabled_vet'
    // | 'apprentice' | 'landowner' | 'preference_point' | 'bonus_point'
    // | 'habitat_stamp' | 'application_fee' | 'second_tag' | 'leftover_tag'
    licenseCode: text("license_code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    // 'resident' | 'nonresident' | 'all' (e.g. apprentice in some states)
    residency: text("residency").notNull().default("all"),
    cost: real("cost"), // base price in USD
    // Optional age band (helps surface youth/senior rates).
    minAge: integer("min_age"),
    maxAge: integer("max_age"),
    validFrom: text("valid_from"), // ISO date or "calendar_year"
    validTo: text("valid_to"), // ISO date or null for lifetime
    // Prerequisites: { hunter_ed: true, prior_license_codes: [...] }
    prerequisites: jsonb("prerequisites").notNull().default({}),
    // Whether this license confers OTC tag rights vs. requires draw entry.
    isOtc: boolean("is_otc").notNull().default(false),
    isDrawEntry: boolean("is_draw_entry").notNull().default(false),
    quantityLimit: integer("quantity_limit"), // e.g. 2 turkey tags per season
    sourceUrl: text("source_url"),
    year: integer("year"), // applicable license year
    lastVerified: timestamp("last_verified", { withTimezone: true }),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("license_types_unique_idx").on(
      table.stateId,
      table.speciesId,
      table.licenseCode,
      table.residency,
      table.year
    ),
    index("license_types_state_idx").on(table.stateId),
    index("license_types_species_idx").on(table.speciesId),
    index("license_types_residency_idx").on(table.residency),
    index("license_types_year_idx").on(table.year),
  ]
);

// ========================
// WEAPON REGULATIONS — what a hunter can legally use, broken down per
// state/species/season. Powers the equipment-aware concierge: "you have a
// 12-gauge shotgun in Georgia — for deer you can hunt with slugs in zones
// X/Y/Z during these dates; for turkey here are the shotshell rules".
// ========================

export const weaponRegulations = pgTable(
  "weapon_regulations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stateId: uuid("state_id")
      .notNull()
      .references(() => states.id, { onDelete: "cascade" }),
    speciesId: uuid("species_id")
      .notNull()
      .references(() => species.id, { onDelete: "cascade" }),
    // Canonical weapon class: 'rifle' | 'shotgun' | 'shotgun_slug' | 'archery'
    // | 'crossbow' | 'muzzleloader' | 'handgun' | 'air_rifle' | 'falconry'
    // | 'trapping' | 'dogs' (where allowed)
    weaponType: text("weapon_type").notNull(),
    allowed: boolean("allowed").notNull().default(true),
    // 'general_season' | 'archery_only' | 'muzzleloader_only' | 'rifle_only'
    // | 'youth_season' | 'late_season' | 'urban_archery' | 'damage_control'
    seasonContext: text("season_context"),
    // Granular rules vary wildly: { min_caliber, min_bullet_grain, min_draw_weight,
    // broadhead_type, mech_or_fixed, magazine_capacity, electronic_optic,
    // tracer_allowed, suppressor_allowed, range_limit_yards, ... }
    restrictions: jsonb("restrictions").notNull().default({}),
    // Specific hunt unit / zone overrides (e.g. "shotgun-only counties in IL"):
    // { allow_unit_codes: [...], deny_unit_codes: [...] }
    huntUnitOverrides: jsonb("hunt_unit_overrides").notNull().default({}),
    // Human-readable rule text for citation/grounding in concierge answers.
    summary: text("summary"),
    sourceUrl: text("source_url"),
    year: integer("year"),
    lastVerified: timestamp("last_verified", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("weapon_regulations_unique_idx").on(
      table.stateId,
      table.speciesId,
      table.weaponType,
      table.seasonContext,
      table.year
    ),
    index("weapon_regulations_state_species_idx").on(
      table.stateId,
      table.speciesId
    ),
    index("weapon_regulations_weapon_idx").on(table.weaponType),
    index("weapon_regulations_year_idx").on(table.year),
  ]
);

// ========================
// PUBLIC LAND PARCELS — denormalized BLM/USFS/state public-land overlays
// pre-computed into hunt-unit-keyed records. Powers "how much public land is
// in this unit" and "where can I actually walk in".
// ========================

export const publicLandParcels = pgTable(
  "public_land_parcels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stateId: uuid("state_id")
      .notNull()
      .references(() => states.id, { onDelete: "cascade" }),
    // 'BLM' | 'USFS' | 'NPS' | 'USFWS' | 'state_wma' | 'state_park'
    // | 'state_forest' | 'state_trust' | 'tribal' | 'open_lands_program'
    landAgency: text("land_agency").notNull(),
    name: text("name"),
    // National Forest / WMA / unit name (e.g. "Pike-San Isabel NF").
    parcelCode: text("parcel_code"),
    acreage: real("acreage"),
    // OPS-friendly: which hunt units (unit_code strings) this parcel overlaps.
    // The actual spatial join is too heavy to keep live in PG without PostGIS
    // tuning; we cache the result here per refresh.
    overlapsUnitCodes: jsonb("overlaps_unit_codes").notNull().default([]),
    // Hunting-specific flags from the source dataset.
    huntingAllowed: boolean("hunting_allowed").notNull().default(true),
    accessNotes: text("access_notes"),
    sourceDataset: text("source_dataset"), // e.g. "BLM Surface Management Agency 2025"
    sourceUrl: text("source_url"),
    geomCentroid: jsonb("geom_centroid"), // { lat, lon } for quick mapping
    boundsBbox: jsonb("bounds_bbox"), // [minLon, minLat, maxLon, maxLat]
    lastRefreshed: timestamp("last_refreshed", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("public_land_state_idx").on(table.stateId),
    index("public_land_agency_idx").on(table.landAgency),
    index("public_land_parcel_code_idx").on(table.parcelCode),
  ]
);

// ========================
// RELATIONS
// ========================

export const hunterEducationRequirementsRelations = relations(
  hunterEducationRequirements,
  ({ one }) => ({
    state: one(states, {
      fields: [hunterEducationRequirements.stateId],
      references: [states.id],
    }),
  })
);

export const licenseTypesRelations = relations(licenseTypes, ({ one }) => ({
  state: one(states, {
    fields: [licenseTypes.stateId],
    references: [states.id],
  }),
  species: one(species, {
    fields: [licenseTypes.speciesId],
    references: [species.id],
  }),
}));

export const weaponRegulationsRelations = relations(
  weaponRegulations,
  ({ one }) => ({
    state: one(states, {
      fields: [weaponRegulations.stateId],
      references: [states.id],
    }),
    species: one(species, {
      fields: [weaponRegulations.speciesId],
      references: [species.id],
    }),
  })
);

export const publicLandParcelsRelations = relations(
  publicLandParcels,
  ({ one }) => ({
    state: one(states, {
      fields: [publicLandParcels.stateId],
      references: [states.id],
    }),
  })
);
