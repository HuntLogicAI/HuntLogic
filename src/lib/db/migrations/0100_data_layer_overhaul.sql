-- =============================================================================
-- Migration 0100 — Data Layer Overhaul
-- =============================================================================
-- Phase 1-4 schema additions in one migration:
--   1) draw_odds: point-system normalization columns
--   2) regulation_snapshots + regulation_changes (delta tracking)
--   3) hunter_education_requirements (new-hunter mode)
--   4) license_types (per state/species/residency/year)
--   5) weapon_regulations (equipment-aware advice)
--   6) public_land_parcels (BLM/USFS overlay cache)
--
-- All changes are additive — no destructive ops, no data loss.
-- Safe to run on prod (idempotent via IF NOT EXISTS where supported).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. draw_odds — point-system normalization
-- -----------------------------------------------------------------------------

ALTER TABLE draw_odds
  ADD COLUMN IF NOT EXISTS point_system_type TEXT,
  ADD COLUMN IF NOT EXISTS effective_points REAL;

COMMENT ON COLUMN draw_odds.point_system_type IS
  'Categorizes the underlying point math: pure_preference | bonus | bonus_squared | weighted_preference | random | none';
COMMENT ON COLUMN draw_odds.effective_points IS
  'Normalized preference-equivalent points (computed from min_points_drawn under point_system_type math). Lets cross-state forecasting compare bonus/preference systems on one axis.';

-- -----------------------------------------------------------------------------
-- 2. regulation_snapshots — versioned, hash-keyed copies of agency rule docs
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS regulation_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_id UUID NOT NULL REFERENCES states(id) ON DELETE CASCADE,
  species_id UUID REFERENCES species(id) ON DELETE SET NULL,
  year INTEGER NOT NULL,
  doc_type TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  source_url TEXT,
  content_hash TEXT NOT NULL,
  content_length INTEGER,
  raw_text_snippet TEXT,
  extracted_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_id UUID REFERENCES data_sources(id) ON DELETE SET NULL,
  previous_snapshot_id UUID,
  status TEXT NOT NULL DEFAULT 'active',
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS regulation_snapshots_hash_idx
  ON regulation_snapshots(state_id, doc_type, year, content_hash);
CREATE INDEX IF NOT EXISTS regulation_snapshots_state_year_idx
  ON regulation_snapshots(state_id, year);
CREATE INDEX IF NOT EXISTS regulation_snapshots_doc_type_idx
  ON regulation_snapshots(doc_type);
CREATE INDEX IF NOT EXISTS regulation_snapshots_status_idx
  ON regulation_snapshots(status);
CREATE INDEX IF NOT EXISTS regulation_snapshots_snapshot_at_idx
  ON regulation_snapshots(snapshot_at);

-- -----------------------------------------------------------------------------
-- 3. regulation_changes — denormalized diff records between snapshots
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS regulation_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_snapshot_id UUID NOT NULL REFERENCES regulation_snapshots(id) ON DELETE CASCADE,
  to_snapshot_id UUID NOT NULL REFERENCES regulation_snapshots(id) ON DELETE CASCADE,
  state_id UUID NOT NULL REFERENCES states(id) ON DELETE CASCADE,
  species_id UUID REFERENCES species(id) ON DELETE SET NULL,
  change_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  field_path TEXT,
  old_value JSONB,
  new_value JSONB,
  summary TEXT NOT NULL,
  impact TEXT,
  affects_unit_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS regulation_changes_state_idx ON regulation_changes(state_id);
CREATE INDEX IF NOT EXISTS regulation_changes_species_idx ON regulation_changes(species_id);
CREATE INDEX IF NOT EXISTS regulation_changes_type_idx ON regulation_changes(change_type);
CREATE INDEX IF NOT EXISTS regulation_changes_severity_idx ON regulation_changes(severity);
CREATE INDEX IF NOT EXISTS regulation_changes_detected_idx ON regulation_changes(detected_at);
CREATE INDEX IF NOT EXISTS regulation_changes_from_snapshot_idx ON regulation_changes(from_snapshot_id);
CREATE INDEX IF NOT EXISTS regulation_changes_to_snapshot_idx ON regulation_changes(to_snapshot_id);

-- -----------------------------------------------------------------------------
-- 4. hunter_education_requirements — per-state new-hunter requirements
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS hunter_education_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_id UUID NOT NULL UNIQUE REFERENCES states(id) ON DELETE CASCADE,
  required_for TEXT NOT NULL DEFAULT 'all_first_time',
  born_on_or_after INTEGER,
  minimum_age INTEGER,
  apprentice_allowed BOOLEAN NOT NULL DEFAULT false,
  apprentice_max_years INTEGER,
  accepted_courses JSONB NOT NULL DEFAULT '[]'::jsonb,
  online_allowed BOOLEAN NOT NULL DEFAULT true,
  field_day_required BOOLEAN NOT NULL DEFAULT false,
  typical_cost REAL,
  reciprocity JSONB NOT NULL DEFAULT '[]'::jsonb,
  cert_number_format TEXT,
  bowhunter_ed_required BOOLEAN NOT NULL DEFAULT false,
  trapper_ed_required BOOLEAN NOT NULL DEFAULT false,
  source_url TEXT,
  notes TEXT,
  last_verified TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hunter_education_state_idx ON hunter_education_requirements(state_id);

-- -----------------------------------------------------------------------------
-- 5. license_types — every license/tag/permit per state
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS license_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_id UUID NOT NULL REFERENCES states(id) ON DELETE CASCADE,
  species_id UUID REFERENCES species(id) ON DELETE SET NULL,
  license_code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  residency TEXT NOT NULL DEFAULT 'all',
  cost REAL,
  min_age INTEGER,
  max_age INTEGER,
  valid_from TEXT,
  valid_to TEXT,
  prerequisites JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_otc BOOLEAN NOT NULL DEFAULT false,
  is_draw_entry BOOLEAN NOT NULL DEFAULT false,
  quantity_limit INTEGER,
  source_url TEXT,
  year INTEGER,
  last_verified TIMESTAMPTZ,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS license_types_unique_idx
  ON license_types(state_id, species_id, license_code, residency, year);
CREATE INDEX IF NOT EXISTS license_types_state_idx ON license_types(state_id);
CREATE INDEX IF NOT EXISTS license_types_species_idx ON license_types(species_id);
CREATE INDEX IF NOT EXISTS license_types_residency_idx ON license_types(residency);
CREATE INDEX IF NOT EXISTS license_types_year_idx ON license_types(year);

-- -----------------------------------------------------------------------------
-- 6. weapon_regulations — equipment-aware advice
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS weapon_regulations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_id UUID NOT NULL REFERENCES states(id) ON DELETE CASCADE,
  species_id UUID NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  weapon_type TEXT NOT NULL,
  allowed BOOLEAN NOT NULL DEFAULT true,
  season_context TEXT,
  restrictions JSONB NOT NULL DEFAULT '{}'::jsonb,
  hunt_unit_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary TEXT,
  source_url TEXT,
  year INTEGER,
  last_verified TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS weapon_regulations_unique_idx
  ON weapon_regulations(state_id, species_id, weapon_type, season_context, year);
CREATE INDEX IF NOT EXISTS weapon_regulations_state_species_idx
  ON weapon_regulations(state_id, species_id);
CREATE INDEX IF NOT EXISTS weapon_regulations_weapon_idx ON weapon_regulations(weapon_type);
CREATE INDEX IF NOT EXISTS weapon_regulations_year_idx ON weapon_regulations(year);

-- -----------------------------------------------------------------------------
-- 7. public_land_parcels — denormalized BLM/USFS/state overlay cache
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public_land_parcels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_id UUID NOT NULL REFERENCES states(id) ON DELETE CASCADE,
  land_agency TEXT NOT NULL,
  name TEXT,
  parcel_code TEXT,
  acreage REAL,
  overlaps_unit_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  hunting_allowed BOOLEAN NOT NULL DEFAULT true,
  access_notes TEXT,
  source_dataset TEXT,
  source_url TEXT,
  geom_centroid JSONB,
  bounds_bbox JSONB,
  last_refreshed TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS public_land_state_idx ON public_land_parcels(state_id);
CREATE INDEX IF NOT EXISTS public_land_agency_idx ON public_land_parcels(land_agency);
CREATE INDEX IF NOT EXISTS public_land_parcel_code_idx ON public_land_parcels(parcel_code);
