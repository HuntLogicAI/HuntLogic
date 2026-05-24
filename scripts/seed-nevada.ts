// =============================================================================
// Nevada NDOW 2025 Hunt Data Importer
// Source: https://www.ndow.org/wp-content/uploads/2026/03/2025-Nevada-Big-Game-Hunt-Data.xlsx
// =============================================================================

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import * as fs from "node:fs";

const EXCEL_URL = "https://www.ndow.org/wp-content/uploads/2026/03/2025-Nevada-Big-Game-Hunt-Data.xlsx";
const EXCEL_PATH = "/tmp/nv-hunt-stats-2025.xlsx";

async function ensureExcel(): Promise<void> {
  if (fs.existsSync(EXCEL_PATH)) return;
  console.log(`Downloading NV hunt data from ${EXCEL_URL}...`);
  const res = await fetch(EXCEL_URL);
  if (!res.ok) throw new Error(`Failed to download NV hunt data: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  fs.writeFileSync(EXCEL_PATH, Buffer.from(buf));
  console.log(`Saved ${buf.byteLength} bytes to ${EXCEL_PATH}`);
}

const SPECIES_MAP: Record<string, string> = {
  Antelope: "pronghorn",
  "Black Bear": "black_bear",
  "California Bighorn Sheep": "bighorn_sheep",
  "Desert Bighorn Sheep": "bighorn_sheep",
  "Rocky Bighorn Sheep": "bighorn_sheep",
  Elk: "elk",
  Moose: "moose",
  "Mountain Goat": "mountain_goat",
  "Mule Deer": "mule_deer",
};

interface Row {
  season: number;
  unitGroup: string;
  hunt: string;
  residency: string;
  species: string;
  weapon: string;
  pointsOrGreater: number | null;
  drawRate: number | null;
  successfulHunters: number | null;
  surveyRate: number | null;
  huntDays: number | null;
  huntersAfield: number | null;
}

function parseNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(String(v));
  return isNaN(n) ? null : n;
}

async function main() {
  await ensureExcel();
  // ── Load Excel ──────────────────────────────────────────────────────────────
  console.log("Parsing Excel...");
  const wb = XLSX.readFile(EXCEL_PATH);
  const sheet = wb.Sheets[wb.SheetNames[0]!]!;
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: null }) as Record<string, unknown>[];
  console.log(`${raw.length} rows found`);

  // Helper: find column key case-insensitively, normalizing \r\n whitespace in headers
  const keys = raw[0] ? Object.keys(raw[0]) : [];
  const normalizeKey = (k: string) => k.replace(/[\r\n]+/g, " ").toLowerCase();
  const findKey = (...candidates: string[]) =>
    keys.find((k) => candidates.some((c) => normalizeKey(k).includes(c.toLowerCase()))) ?? "";

  const COL_SEASON = findKey("season", "year");
  const COL_UNIT = findKey("unit group", "unit_group", "unitgroup");
  const COL_HUNT = findKey("hunt");
  const COL_RES = findKey("residency", "resident");
  const COL_SPECIES = findKey("species");
  const COL_WEAPON = findKey("weapon", "description");
  const COL_POINTS = findKey("points or");
  const COL_DRAW = findKey("draw\nrate", "draw rate");
  const COL_SUCCESS = findKey("successful");
  const COL_SURVEY = findKey("survey");
  const COL_HUNTDAYS = findKey("hunt\ndays", "hunt days");
  const COL_AFIELD = findKey("hunters\nafield", "afield");

  console.log("Column mapping:", { COL_SEASON, COL_UNIT, COL_SPECIES, COL_RES, COL_WEAPON, COL_DRAW, COL_POINTS });

  const rows: Row[] = raw
    .map((r) => ({
      season: parseNum(r[COL_SEASON]) ?? 0,
      unitGroup: String(r[COL_UNIT] ?? "").trim(),
      hunt: String(r[COL_HUNT] ?? "").trim(),
      residency: String(r[COL_RES] ?? "").trim() === "NR" ? "nonresident" : "resident",
      species: String(r[COL_SPECIES] ?? "").trim(),
      weapon: String(r[COL_WEAPON] ?? "").trim(),
      pointsOrGreater: parseNum(r[COL_POINTS]),
      drawRate: parseNum(r[COL_DRAW]),
      successfulHunters: parseNum(r[COL_SUCCESS]),
      surveyRate: parseNum(r[COL_SURVEY]),
      huntDays: parseNum(r[COL_HUNTDAYS]),
      huntersAfield: parseNum(r[COL_AFIELD]),
    }))
    .filter((r) => r.season > 0 && r.species && SPECIES_MAP[r.species]);

  console.log(`${rows.length} valid rows after filtering`);

  // ── Fetch NV state id ────────────────────────────────────────────────────────
  const nvRows = await db.execute(sql`SELECT id FROM states WHERE code = 'NV' LIMIT 1`);
  const stateId = ((nvRows as Array<{ id: string }>)[0])?.id;
  if (!stateId) throw new Error("NV state not found in DB");
  console.log("NV state id:", stateId);

  // ── Fetch species ids ────────────────────────────────────────────────────────
  const speciesRows = await db.execute(sql`SELECT id, slug FROM species`);
  const speciesIdBySlug: Record<string, string> = {};
  for (const r of speciesRows as Array<{ id: string; slug: string }>) {
    speciesIdBySlug[r.slug] = r.id;
  }

  // ── Upsert hunt units ────────────────────────────────────────────────────────
  console.log("Upserting hunt units...");
  const unitSet = new Set<string>();
  for (const r of rows) {
    const slug = SPECIES_MAP[r.species]!;
    const speciesId = speciesIdBySlug[slug];
    if (speciesId) unitSet.add(`${r.unitGroup}::${speciesId}`);
  }

  const unitIdCache: Record<string, string> = {};
  // Batch in groups of 50
  const unitEntries = [...unitSet];
  for (let i = 0; i < unitEntries.length; i += 50) {
    const batch = unitEntries.slice(i, i + 50);
    for (const key of batch) {
      const [unitGroup, speciesId] = key.split("::");
      if (!unitGroup || !speciesId) continue;
      const res = await db.execute(sql`
        INSERT INTO hunt_units (state_id, species_id, unit_code, unit_name)
        VALUES (${stateId}, ${speciesId}, ${unitGroup}, ${unitGroup})
        ON CONFLICT (state_id, species_id, unit_code) DO UPDATE
          SET unit_name = EXCLUDED.unit_name
        RETURNING id
      `);
      const row = (res as Array<{ id: string }>)[0];
      if (row) unitIdCache[key] = row.id;
    }
  }
  console.log(`Upserted ${unitEntries.length} hunt units`);

  // ── Aggregate and batch-insert draw_odds ─────────────────────────────────────
  type AggKey = string;
  interface DrawAgg {
    speciesId: string; unitGroup: string; weapon: string;
    year: number; residency: string;
    apps: number; tags: number; minPoints: number | null;
  }
  interface HarvestAgg {
    speciesId: string; unitGroup: string; weapon: string; year: number;
    totalHunters: number; totalHarvest: number;
    huntDaysSum: number; huntDaysCount: number;
  }

  const drawMap = new Map<AggKey, DrawAgg>();
  const harvestMap = new Map<AggKey, HarvestAgg>();

  for (const r of rows) {
    const slug = SPECIES_MAP[r.species]!;
    const speciesId = speciesIdBySlug[slug];
    if (!speciesId) continue;

    const dk: AggKey = `${speciesId}::${r.unitGroup}::${r.weapon}::${r.season}::${r.residency}`;
    const existing = drawMap.get(dk);
    
    // Approximate applicants from draw rate + tags
    let apps = 0, tags = 0;
    if (r.drawRate !== null && r.drawRate > 0 && r.successfulHunters !== null) {
      tags = r.successfulHunters;
      apps = Math.round(r.successfulHunters / (r.drawRate / 100));
    }

    if (!existing) {
      drawMap.set(dk, {
        speciesId, unitGroup: r.unitGroup, weapon: r.weapon,
        year: r.season, residency: r.residency,
        apps, tags,
        minPoints: r.pointsOrGreater !== null ? Math.round(r.pointsOrGreater) : null,
      });
    } else {
      existing.apps += apps;
      existing.tags += tags;
      if (r.pointsOrGreater !== null) {
        existing.minPoints = existing.minPoints === null
          ? Math.round(r.pointsOrGreater)
          : Math.min(existing.minPoints, Math.round(r.pointsOrGreater));
      }
    }

    const hk: AggKey = `${speciesId}::${r.unitGroup}::${r.weapon}::${r.season}`;
    const hexisting = harvestMap.get(hk);
    if (!hexisting) {
      harvestMap.set(hk, {
        speciesId, unitGroup: r.unitGroup, weapon: r.weapon, year: r.season,
        totalHunters: r.huntersAfield ?? 0,
        totalHarvest: r.successfulHunters ?? 0,
        huntDaysSum: r.huntDays ?? 0,
        huntDaysCount: r.huntDays !== null ? 1 : 0,
      });
    } else {
      hexisting.totalHunters += r.huntersAfield ?? 0;
      hexisting.totalHarvest += r.successfulHunters ?? 0;
      if (r.huntDays !== null) {
        hexisting.huntDaysSum += r.huntDays;
        hexisting.huntDaysCount++;
      }
    }
  }

  // ── Insert draw_odds in batches of 20 ────────────────────────────────────────
  console.log(`Inserting ${drawMap.size} draw_odds records...`);
  let drawInserted = 0;
  const drawEntries = [...drawMap.values()];

  for (let i = 0; i < drawEntries.length; i += 20) {
    const batch = drawEntries.slice(i, i + 20);
    for (const agg of batch) {
      const unitKey = `${agg.unitGroup}::${agg.speciesId}`;
      const huntUnitId = unitIdCache[unitKey] ?? null;
      const drawRate = agg.apps > 0 ? agg.tags / agg.apps : null;

      await db.execute(sql`
        INSERT INTO draw_odds (
          state_id, species_id, hunt_unit_id, year, resident_type,
          weapon_type, total_applicants, total_tags, min_points_drawn,
          draw_rate, raw_data
        ) VALUES (
          ${stateId}, ${agg.speciesId}, ${huntUnitId}, ${agg.year},
          ${agg.residency}, ${agg.weapon},
          ${agg.apps > 0 ? agg.apps : null},
          ${agg.tags > 0 ? agg.tags : null},
          ${agg.minPoints},
          ${drawRate},
          ${"{}"}::jsonb
        )
        ON CONFLICT (state_id, species_id, hunt_unit_id, year, resident_type, weapon_type, choice_rank)
        DO UPDATE SET
          total_applicants = EXCLUDED.total_applicants,
          total_tags = EXCLUDED.total_tags,
          min_points_drawn = EXCLUDED.min_points_drawn,
          draw_rate = EXCLUDED.draw_rate
      `);
      drawInserted++;
    }
    process.stdout.write(`  ${drawInserted}/${drawEntries.length}\r`);
  }
  console.log(`\nInserted ${drawInserted} draw_odds records`);

  // ── Insert harvest_stats in batches of 20 ───────────────────────────────────
  console.log(`Inserting ${harvestMap.size} harvest_stats records...`);
  let harvestInserted = 0;
  const harvestEntries = [...harvestMap.values()];

  for (let i = 0; i < harvestEntries.length; i += 20) {
    const batch = harvestEntries.slice(i, i + 20);
    for (const agg of batch) {
      const unitKey = `${agg.unitGroup}::${agg.speciesId}`;
      const huntUnitId = unitIdCache[unitKey] ?? null;
      const successRate = agg.totalHunters > 0 ? agg.totalHarvest / agg.totalHunters : null;
      const avgDays = agg.huntDaysCount > 0 ? agg.huntDaysSum / agg.huntDaysCount : null;

      await db.execute(sql`
        INSERT INTO harvest_stats (
          state_id, species_id, hunt_unit_id, year, weapon_type,
          total_hunters, total_harvest, success_rate, avg_days_hunted, raw_data
        ) VALUES (
          ${stateId}, ${agg.speciesId}, ${huntUnitId}, ${agg.year},
          ${agg.weapon},
          ${agg.totalHunters > 0 ? agg.totalHunters : null},
          ${agg.totalHarvest > 0 ? agg.totalHarvest : null},
          ${successRate},
          ${avgDays},
          ${"{}"}::jsonb
        )
        ON CONFLICT DO NOTHING
      `);
      harvestInserted++;
    }
    process.stdout.write(`  ${harvestInserted}/${harvestEntries.length}\r`);
  }
  console.log(`\nInserted ${harvestInserted} harvest_stats records`);

  console.log("\n✅ Nevada NDOW 2025 import complete");
  console.log(`   draw_odds: ${drawInserted}`);
  console.log(`   harvest_stats: ${harvestInserted}`);
  console.log(`   hunt_units: ${unitEntries.length}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("❌", e.message);
  console.error(e.stack);
  process.exit(1);
});
