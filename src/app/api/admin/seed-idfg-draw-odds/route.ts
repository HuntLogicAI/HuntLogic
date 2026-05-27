/**
 * POST /api/admin/seed-idfg-draw-odds
 *
 * Ingests Idaho Department of Fish and Game controlled hunt drawing odds.
 *
 * IDFG doesn't publish a PDF or Excel — their Hunt Planner uses a clean
 * JSON API at /ifwis/huntplanner/api/1.1/odds/ with query params:
 *   yr        — year (e.g. 2024)
 *   biggame   — species ID (1=Deer, 2=Elk, 3=Pronghorn, 4=Bear, 6=Moose,
 *               7=Rocky Mountain Sheep, 8=Mountain Goat, 22=Sandhill Crane,
 *               27=Turkey, 28=California Sheep, 57=Swan)
 *   draw      — 1 (first choice) or 2 (second choice)
 *
 * Returns rows like:
 *   { Yr, CHunt, CHuntArea, AreaID, Draw, PermitAvailable, ApplChoice1,
 *     ResApp, NonResApp, ResPermit, NonResPermit, PercRes1, PercNonRes1, ... }
 *
 * One draw_odds row per (hunt × residency). hunt_unit = CHuntArea.
 *
 * Idempotent: ON CONFLICT DO NOTHING. Auto-creates hunt_units.
 *
 * Guarded by CRON_SECRET. ?species=elk|mule_deer|... to filter, ?year=2024
 * to target a specific year (default 2024 — last completed cycle).
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, sql as drizzleSql, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { states, species, huntUnits, drawOdds, dataSources } from "@/lib/db/schema";

export const runtime = "nodejs";
export const maxDuration = 120;

// IDFG biggame ID → our species slug
const IDFG_BIGGAME_TO_SLUG: Record<number, string> = {
  1: "mule_deer",         // IDFG combines mule + whitetail under "Deer"; we map to mule_deer
  2: "elk",
  3: "pronghorn",
  4: "black_bear",
  6: "moose",
  7: "bighorn_sheep",     // Rocky Mountain Sheep
  8: "mountain_goat",
  27: "turkey",
  28: "bighorn_sheep",    // California Sheep (subspecies) — bucket under bighorn_sheep
};

interface IdfgRow {
  Yr: string;
  CHunt: number;
  CHuntArea: string;
  AreaID: number;
  Draw: number;
  PermitAvailable: number;
  SuccChoice1: number;
  SuccChoice2: number;
  ApplChoice1: number;
  ApplChoice2: number;
  ResApp: number;
  NonResApp: number;
  ResPermit: number;
  NonResPermit: number;
  PermitTotal: number;
  PercChoice1: number;
  PercChoice2: number;
  PercRes1: number;
  PercNonRes1: number;
}

interface IdfgResponse {
  response: string;
  msg: string;
  total: number;
  rows: IdfgRow[];
}

interface PerSpeciesResult {
  biggameId: number;
  speciesSlug: string;
  apiUrl: string;
  httpStatus?: number;
  rowsReturned: number;
  inserted: number;
  conflictsSkipped: number;
  huntUnitsCreated: number;
  errors: string[];
}

export async function POST(request: NextRequest) {
  try {
    return await handlePost(request);
  } catch (err) {
    console.error("[admin:seed-idfg] FATAL:", err);
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
  const speciesFilter = url.searchParams.get("species");
  const year = parseInt(url.searchParams.get("year") || "2024", 10);

  // Resolve which biggame IDs to fetch based on speciesFilter (if any)
  const biggameIds: Array<{ id: number; slug: string }> = [];
  for (const [idStr, slug] of Object.entries(IDFG_BIGGAME_TO_SLUG)) {
    if (speciesFilter && slug !== speciesFilter) continue;
    biggameIds.push({ id: parseInt(idStr, 10), slug });
  }
  if (biggameIds.length === 0) {
    return NextResponse.json({ error: `No IDFG biggame ID matches species=${speciesFilter}` }, { status: 400 });
  }

  const startedAt = Date.now();

  const [idState] = await db.select({ id: states.id }).from(states).where(eq(states.code, "ID")).limit(1);
  if (!idState) return NextResponse.json({ error: "ID state row not found in DB" }, { status: 404 });

  // Pre-load species
  const allSpecies = await db.select({ id: species.id, slug: species.slug }).from(species);
  const speciesMap = new Map<string, string>();
  for (const s of allSpecies) speciesMap.set(s.slug, s.id);

  // Source row
  const sourceName = `IDFG ${year} Controlled Hunt Drawing Results`;
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
        url: "https://idfg.idaho.gov/ifwis/huntplanner/odds/",
        refreshCadence: "annual",
        status: "active",
      })
      .returning({ id: dataSources.id });
    sourceId = inserted.id;
  }

  const results: PerSpeciesResult[] = [];

  for (const { id: biggameId, slug } of biggameIds) {
    const huntSpeciesId = speciesMap.get(slug);
    const apiUrl = `https://idfg.idaho.gov/ifwis/huntplanner/api/1.1/odds/?yr=${year}&biggame=${biggameId}&draw=1`;
    const result: PerSpeciesResult = {
      biggameId,
      speciesSlug: slug,
      apiUrl,
      rowsReturned: 0,
      inserted: 0,
      conflictsSkipped: 0,
      huntUnitsCreated: 0,
      errors: [],
    };

    if (!huntSpeciesId) {
      result.errors.push(`Species '${slug}' not found in DB`);
      results.push(result);
      continue;
    }

    try {
      const fetchRes = await fetch(apiUrl, {
        headers: { "User-Agent": "Mozilla/5.0 HuntLogic/1.0", Accept: "application/json" },
      });
      result.httpStatus = fetchRes.status;
      if (!fetchRes.ok) {
        result.errors.push(`HTTP ${fetchRes.status} from IDFG API`);
        results.push(result);
        continue;
      }
      const text = await fetchRes.text();
      let data: IdfgResponse;
      try {
        data = JSON.parse(text) as IdfgResponse;
      } catch {
        result.errors.push(`Response not JSON. First 200 chars: ${text.slice(0, 200)}`);
        results.push(result);
        continue;
      }
      if (data.response !== "success") {
        result.errors.push(`IDFG response.msg: ${data.msg}`);
        results.push(result);
        continue;
      }
      result.rowsReturned = data.rows.length;

      for (const row of data.rows) {
        const unitCode = row.CHuntArea;
        if (!unitCode) continue;

        // Look up or create hunt_unit
        let huntUnitId: string | null = null;
        const [existingUnit] = await db
          .select({ id: huntUnits.id })
          .from(huntUnits)
          .where(
            and(
              eq(huntUnits.stateId, idState.id),
              eq(huntUnits.speciesId, huntSpeciesId),
              eq(huntUnits.unitCode, unitCode),
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
                stateId: idState.id,
                speciesId: huntSpeciesId,
                unitCode,
                unitName: `Hunt ${row.CHunt} — Area ${unitCode} (IDFG ${slug})`,
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
                  eq(huntUnits.stateId, idState.id),
                  eq(huntUnits.speciesId, huntSpeciesId),
                  eq(huntUnits.unitCode, unitCode),
                ),
              )
              .limit(1);
            if (reread) huntUnitId = reread.id;
          }
        }

        // Insert one draw_odds row per residency
        const residencies = [
          {
            residentType: "resident",
            totalApplicants: row.ResApp,
            totalTags: row.ResPermit,
            drawRatePct: row.PercRes1,
          },
          {
            residentType: "nonresident",
            totalApplicants: row.NonResApp,
            totalTags: row.NonResPermit,
            drawRatePct: row.PercNonRes1,
          },
        ];

        for (const r of residencies) {
          const safeInt = (n: unknown): number | null =>
            typeof n === "number" && !Number.isNaN(n) ? Math.trunc(n) : null;
          const drawRate =
            typeof r.drawRatePct === "number" && r.drawRatePct >= 0
              ? r.drawRatePct / 100
              : null;

          try {
            const insertResult = await db
              .insert(drawOdds)
              .values({
                stateId: idState.id,
                speciesId: huntSpeciesId,
                huntUnitId,
                year,
                residentType: r.residentType,
                weaponType: null, // IDFG API doesn't expose weapon per hunt code here
                choiceRank: 1,
                totalApplicants: safeInt(r.totalApplicants),
                totalTags: safeInt(r.totalTags),
                drawRate,
                sourceId,
                rawData: {
                  parser: "idfg-api-inline",
                  ...row,
                  derivedResidency: r.residentType,
                },
              })
              .onConflictDoNothing();
            const rowsAffected =
              (insertResult as unknown as { rowCount?: number }).rowCount ?? 1;
            if (rowsAffected > 0) result.inserted++;
            else result.conflictsSkipped++;
          } catch (insertErr) {
            const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
            if (msg.includes("duplicate") || msg.includes("conflict"))
              result.conflictsSkipped++;
            else result.errors.push(`Insert err on hunt ${row.CHunt}: ${msg}`);
          }
        }
      }
    } catch (err) {
      result.errors.push(
        `Top-level error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    results.push(result);
  }

  const [counts] = await db
    .select({ drawOddsCount: drizzleSql<number>`COUNT(*)::int` })
    .from(drawOdds)
    .where(eq(drawOdds.stateId, idState.id));

  return NextResponse.json({
    ok: true,
    stateCode: "ID",
    year,
    speciesFilter,
    elapsedMs: Date.now() - startedAt,
    perSpecies: results,
    totals: {
      newInsertsThisRun: results.reduce((s, r) => s + r.inserted, 0),
      conflictsSkippedThisRun: results.reduce((s, r) => s + r.conflictsSkipped, 0),
      huntUnitsCreatedThisRun: results.reduce((s, r) => s + r.huntUnitsCreated, 0),
      drawOddsRowsInDb: counts?.drawOddsCount ?? 0,
    },
  });
}

export async function GET() {
  const [idState] = await db.select({ id: states.id }).from(states).where(eq(states.code, "ID")).limit(1);
  if (!idState) return NextResponse.json({ error: "ID not seeded" }, { status: 404 });

  const [counts] = await db
    .select({ drawOddsCount: drizzleSql<number>`COUNT(*)::int` })
    .from(drawOdds)
    .where(eq(drawOdds.stateId, idState.id));

  return NextResponse.json({
    endpoint: "POST /api/admin/seed-idfg-draw-odds",
    auth: "Authorization: Bearer <CRON_SECRET>",
    query: "?year=2024 (default), ?species=elk|mule_deer|pronghorn|black_bear|moose|bighorn_sheep|mountain_goat|turkey",
    biggameMap: IDFG_BIGGAME_TO_SLUG,
    currentDb: { idDrawOddsRows: counts?.drawOddsCount ?? 0 },
  });
}
