/**
 * POST /api/admin/seed-ndow-draw-odds
 *
 * Ingests the Nevada Department of Wildlife (NDOW) 2025 Big Game Hunt Data
 * Excel — a single comprehensive XLSX covering all big game species. The
 * file contains BOTH draw odds (applicants/quota/draw rate) AND harvest stats
 * (hunters afield, successful hunters, hunter success, hunt days) in one row
 * per hunt/unit/residency, so this seed populates both draw_odds AND
 * harvest_stats in one pass.
 *
 * Guarded by CRON_SECRET. ?debug=1 returns the first 12 parsed rows w/o insert.
 *
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     "$APP_URL/api/admin/seed-ndow-draw-odds"
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, sql as drizzleSql, and } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  states,
  species,
  huntUnits,
  drawOdds,
  harvestStats,
  dataSources,
} from "@/lib/db/schema";

export const runtime = "nodejs";
export const maxDuration = 300;

const NDOW_XLSX_URL =
  "https://www.ndow.org/wp-content/uploads/2026/03/2025-Nevada-Big-Game-Hunt-Data.xlsx";

const TARGET_YEAR = 2025;

interface PerRunResult {
  url: string;
  httpStatus?: number;
  bytes?: number;
  sheetsFound?: string[];
  parsedRows?: number;
  drawOddsInserted: number;
  harvestStatsInserted: number;
  conflictsSkipped: number;
  huntUnitsCreated: number;
  speciesMisses: number;
  errors: string[];
  sampleRows?: unknown[];
}

// Map NDOW species labels to our canonical species slugs.
function ndowSpeciesToSlug(label: string): string | null {
  const t = label.toLowerCase().trim();
  if (t === "antelope" || t.includes("pronghorn")) return "pronghorn";
  if (t === "elk") return "elk";
  if (t === "mule deer" || t === "deer") return "mule_deer";
  if (t === "black bear" || t === "bear") return "black_bear";
  if (t === "moose") return "moose";
  if (t === "mountain goat" || t === "goat") return "mountain_goat";
  // NV lists three bighorn subspecies separately. We collapse to the single
  // "bighorn_sheep" slug; the subspecies survives in raw_data + unit_name.
  if (t.includes("bighorn") || t.includes("sheep")) return "bighorn_sheep";
  return null;
}

// Slugify the Hunt description for use inside our synthesized unit code.
function slugifyHunt(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function residencyToCanonical(raw: string | null | undefined): string | null {
  const r = (raw ?? "").trim().toUpperCase();
  if (r === "R") return "resident";
  if (r === "NR") return "nonresident";
  return null; // blank = mixed; we skip those for unique-index safety
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed === "") return null;
    const n = parseFloat(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
const safeInt = (n: number | null): number | null =>
  n == null || !Number.isFinite(n) ? null : Math.trunc(n);

// NDOW puts \r\n inside header strings ("Unique\r\nApps"), so the column
// keys in sheet_to_json look like "Unique\r\nApps". This helper looks up by
// the suffix after the line break to be tolerant of trivial header tweaks.
function pick(row: Record<string, unknown>, ...candidates: string[]): unknown {
  for (const c of candidates) {
    if (c in row) return row[c];
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    return await handlePost(request);
  } catch (err) {
    console.error("[admin:seed-ndow] FATAL:", err);
    return NextResponse.json(
      {
        ok: false,
        fatalError: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.split("\n").slice(0, 8) : undefined,
      },
      { status: 500 },
    );
  }
}

async function handlePost(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  if (authHeader !== `Bearer ${cronSecret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const debug = url.searchParams.get("debug") === "1";
  const startedAt = Date.now();

  const [nvState] = await db.select({ id: states.id }).from(states).where(eq(states.code, "NV")).limit(1);
  if (!nvState) return NextResponse.json({ error: "NV state row not found in DB" }, { status: 404 });

  // Track the agency source once for citation provenance.
  const sourceName = `NDOW ${TARGET_YEAR} Big Game Hunt Data`;
  const [existingSource] = await db
    .select({ id: dataSources.id })
    .from(dataSources)
    .where(eq(dataSources.name, sourceName))
    .limit(1);
  let sourceId: string;
  if (existingSource) {
    sourceId = existingSource.id;
  } else {
    const [inserted] = await db
      .insert(dataSources)
      .values({
        name: sourceName,
        sourceType: "draw_report",
        authorityTier: 1,
        url: "https://www.ndow.org/blog/hunt-statistics/",
        refreshCadence: "annual",
        status: "active",
      })
      .returning({ id: dataSources.id });
    sourceId = inserted.id;
  }

  // Cache species slug → id
  const allSpecies = await db.select({ id: species.id, slug: species.slug }).from(species);
  const speciesMap = new Map<string, string>();
  for (const s of allSpecies) speciesMap.set(s.slug, s.id);

  const result: PerRunResult = {
    url: NDOW_XLSX_URL,
    drawOddsInserted: 0,
    harvestStatsInserted: 0,
    conflictsSkipped: 0,
    huntUnitsCreated: 0,
    speciesMisses: 0,
    errors: [],
  };

  try {
    const fetchRes = await fetch(NDOW_XLSX_URL, {
      headers: { "User-Agent": "Mozilla/5.0 HuntLogic/1.0" },
      redirect: "follow",
    });
    result.httpStatus = fetchRes.status;
    if (!fetchRes.ok) {
      result.errors.push(`HTTP ${fetchRes.status} fetching XLSX`);
      return NextResponse.json({ ok: false, perRun: result });
    }
    const buf = await fetchRes.arrayBuffer();
    result.bytes = buf.byteLength;

    const XLSX = await import("xlsx");
    const wb = XLSX.read(Buffer.from(buf), { type: "buffer" });
    result.sheetsFound = wb.SheetNames;

    // The data lives in "2025 Hunt Summary" — but be tolerant of NDOW
    // renaming it next year.
    const dataSheetName =
      wb.SheetNames.find((n) => /hunt\s*summary/i.test(n)) ?? wb.SheetNames[0];
    const sheet = wb.Sheets[dataSheetName];
    if (!sheet) {
      result.errors.push(`No usable sheet (looked for /hunt summary/i in ${wb.SheetNames.join(", ")})`);
      return NextResponse.json({ ok: false, perRun: result });
    }
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
    result.parsedRows = rows.length;

    if (debug) {
      result.sampleRows = rows.slice(0, 12);
      return NextResponse.json({ ok: true, perRun: result, elapsedMs: Date.now() - startedAt });
    }

    for (const row of rows) {
      const speciesLabel = String(row.Species ?? "").trim();
      if (!speciesLabel) continue;
      const speciesSlug = ndowSpeciesToSlug(speciesLabel);
      if (!speciesSlug) {
        result.speciesMisses++;
        continue;
      }
      const speciesId = speciesMap.get(speciesSlug);
      if (!speciesId) {
        result.speciesMisses++;
        continue;
      }

      const residentType = residencyToCanonical(row.Residency as string | null);
      if (!residentType) continue; // blank Residency = mixed → skip

      const huntLabel = String(row.Hunt ?? "").trim();
      const unitGroup = String(row["Unit Group"] ?? "").trim();
      const weapon = String(row.Weapon ?? "").trim() || null;

      // Synthesize a unit_code that is unique per (hunt, unit-group, weapon)
      // so the draw_odds unique index on
      //   (state, species, hunt_unit, year, resident, weapon, choiceRank)
      // doesn't collapse e.g. antelope-buck and antelope-doe drawn in the
      // same Unit Group with the same weapon into one row.
      const huntSlug = slugifyHunt(huntLabel);
      const weaponSlug = (weapon ?? "any").toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const synthesizedUnitCode = `${unitGroup || "any"}|${huntSlug}|${weaponSlug}`;
      const unitName = `Area ${unitGroup || "—"} — ${huntLabel}${weapon ? ` (${weapon})` : ""}`;

      // Upsert hunt_unit
      let huntUnitId: string | null = null;
      const [existingUnit] = await db
        .select({ id: huntUnits.id })
        .from(huntUnits)
        .where(
          and(
            eq(huntUnits.stateId, nvState.id),
            eq(huntUnits.speciesId, speciesId),
            eq(huntUnits.unitCode, synthesizedUnitCode),
          ),
        )
        .limit(1);
      if (existingUnit) {
        huntUnitId = existingUnit.id;
      } else {
        try {
          const [created] = await db
            .insert(huntUnits)
            .values({
              stateId: nvState.id,
              speciesId: speciesId,
              unitCode: synthesizedUnitCode,
              unitName: unitName.slice(0, 200),
            })
            .returning({ id: huntUnits.id });
          huntUnitId = created.id;
          result.huntUnitsCreated++;
        } catch {
          const [reread] = await db
            .select({ id: huntUnits.id })
            .from(huntUnits)
            .where(
              and(
                eq(huntUnits.stateId, nvState.id),
                eq(huntUnits.speciesId, speciesId),
                eq(huntUnits.unitCode, synthesizedUnitCode),
              ),
            )
            .limit(1);
          if (reread) huntUnitId = reread.id;
        }
      }

      // --- DRAW ODDS ---
      const uniqueApps = safeInt(toNum(pick(row, "Unique\r\nApps", "Unique Apps", "UniqueApps")));
      const quota = safeInt(toNum(pick(row, "2025\r\nQuota", "Quota", "2025 Quota")));
      const tagsIssued = safeInt(toNum(pick(row, "Tags\r\nIssued", "Tags Issued")));
      const drawRate = toNum(pick(row, "Draw\r\nRate", "Draw Rate"));
      const pointsOrGreater = safeInt(
        toNum(pick(row, "Points or\r\nGreater", "Points or Greater")),
      );

      try {
        const insertResult = await db
          .insert(drawOdds)
          .values({
            stateId: nvState.id,
            speciesId,
            huntUnitId,
            year: TARGET_YEAR,
            residentType,
            weaponType: weapon,
            choiceRank: 1,
            totalApplicants: uniqueApps,
            // We prefer tagsIssued where present (what was actually given out);
            // fall back to quota.
            totalTags: tagsIssued ?? quota,
            minPointsDrawn: pointsOrGreater,
            drawRate: drawRate != null && Number.isFinite(drawRate) ? drawRate : null,
            sourceId,
            rawData: {
              parser: "ndow-xlsx-inline",
              hunt: huntLabel,
              unitGroup,
              weapon,
              residency: row.Residency,
              quota,
              tagsIssued,
              demand: safeInt(toNum(row.Demand)),
              ndowSpeciesLabel: speciesLabel,
              season: row.Season ?? null,
            },
          })
          .onConflictDoNothing();
        const rowsAffected =
          (insertResult as unknown as { rowCount?: number }).rowCount ?? 1;
        if (rowsAffected > 0) result.drawOddsInserted++;
        else result.conflictsSkipped++;
      } catch (insertErr) {
        const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
        if (msg.includes("duplicate") || msg.includes("conflict")) {
          result.conflictsSkipped++;
        } else {
          result.errors.push(`draw_odds err on ${synthesizedUnitCode}/${residentType}: ${msg}`);
        }
      }

      // --- HARVEST STATS ---
      // Only one row per hunt_unit/year/weapon — both residencies share the
      // same hunters-afield population, so we only write harvest stats on
      // the resident row to avoid a unique-index conflict on (state, species,
      // hunt_unit, year, weapon). (Same hunters either way.)
      if (residentType === "resident") {
        const huntersAfield = safeInt(toNum(pick(row, "Hunters\r\nAfield", "Hunters Afield")));
        const successfulHunters = safeInt(
          toNum(pick(row, "Successful\r\nHunters", "Successful Hunters")),
        );
        const hunterSuccess = toNum(pick(row, "Hunter\r\nSuccess", "Hunter Success"));
        const huntDays = toNum(pick(row, "Hunt\r\nDays", "Hunt Days"));
        const lengthOrGreater = toNum(pick(row, "Length or\r\nGreater", "Length or Greater"));
        const hunterSatisfaction = toNum(
          pick(row, "Hunter\r\nSatisfaction", "Hunter Satisfaction"),
        );

        // Skip writing harvest_stats when there's literally no hunter data.
        if (huntersAfield != null || successfulHunters != null) {
          try {
            const hsResult = await db
              .insert(harvestStats)
              .values({
                stateId: nvState.id,
                speciesId,
                huntUnitId,
                year: TARGET_YEAR,
                weaponType: weapon,
                totalHunters: huntersAfield,
                totalHarvest: successfulHunters,
                successRate:
                  hunterSuccess != null && Number.isFinite(hunterSuccess)
                    ? hunterSuccess
                    : null,
                avgDaysHunted:
                  huntDays != null && Number.isFinite(huntDays) ? huntDays : null,
                trophyMetrics: {
                  lengthOrGreater,
                  hunterSatisfaction,
                  surveyRate: pick(row, "Survey\r\nRate", "Survey Rate"),
                },
                sourceId,
                rawData: {
                  parser: "ndow-xlsx-inline",
                  hunt: huntLabel,
                  unitGroup,
                  ndowSpeciesLabel: speciesLabel,
                  effortDays: pick(row, "Effort\r\nDays", "Effort Days"),
                },
              })
              .onConflictDoNothing();
            const hsAffected =
              (hsResult as unknown as { rowCount?: number }).rowCount ?? 1;
            if (hsAffected > 0) result.harvestStatsInserted++;
          } catch (insertErr) {
            const msg =
              insertErr instanceof Error ? insertErr.message : String(insertErr);
            if (!msg.includes("duplicate") && !msg.includes("conflict")) {
              result.errors.push(
                `harvest_stats err on ${synthesizedUnitCode}: ${msg}`,
              );
            }
          }
        }
      }
    }
  } catch (err) {
    result.errors.push(
      `Top-level error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const [drawCounts] = await db
    .select({ c: drizzleSql<number>`COUNT(*)::int` })
    .from(drawOdds)
    .where(eq(drawOdds.stateId, nvState.id));
  const [harvCounts] = await db
    .select({ c: drizzleSql<number>`COUNT(*)::int` })
    .from(harvestStats)
    .where(eq(harvestStats.stateId, nvState.id));

  return NextResponse.json({
    ok: true,
    stateCode: "NV",
    year: TARGET_YEAR,
    elapsedMs: Date.now() - startedAt,
    perRun: result,
    drawOddsRowsInDb: drawCounts?.c ?? 0,
    harvestStatsRowsInDb: harvCounts?.c ?? 0,
  });
}

export async function GET() {
  const [nvState] = await db
    .select({ id: states.id })
    .from(states)
    .where(eq(states.code, "NV"))
    .limit(1);
  if (!nvState) return NextResponse.json({ error: "NV not seeded" }, { status: 404 });

  const [drawCounts] = await db
    .select({ c: drizzleSql<number>`COUNT(*)::int` })
    .from(drawOdds)
    .where(eq(drawOdds.stateId, nvState.id));
  const [harvCounts] = await db
    .select({ c: drizzleSql<number>`COUNT(*)::int` })
    .from(harvestStats)
    .where(eq(harvestStats.stateId, nvState.id));

  return NextResponse.json({
    endpoint: "POST /api/admin/seed-ndow-draw-odds",
    auth: "Authorization: Bearer <CRON_SECRET>",
    query: "?debug=1 (returns first 12 parsed rows)",
    xlsxUrl: NDOW_XLSX_URL,
    currentDb: {
      nvDrawOddsRows: drawCounts?.c ?? 0,
      nvHarvestStatsRows: harvCounts?.c ?? 0,
    },
  });
}
