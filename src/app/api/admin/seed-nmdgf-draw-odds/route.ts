/**
 * POST /api/admin/seed-nmdgf-draw-odds
 *
 * Ingests New Mexico Department of Game and Fish 2024 Drawing Odds
 * Summary (Excel .xlsx). Populates draw_odds + auto-creates hunt_units.
 *
 * NM publishes a single comprehensive Excel for all big game species, so
 * the parser detects species per row from a column. Easier than the PDF
 * scrape used for WGFD/CPW/UT.
 *
 * Guarded by CRON_SECRET. ?debug=1 to dump first 80 rows of parsed data.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, sql as drizzleSql, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { states, species, huntUnits, drawOdds, dataSources } from "@/lib/db/schema";

export const runtime = "nodejs";
export const maxDuration = 300;

const NM_XLSX_URL =
  "https://wildlife.dgf.nm.gov/download/2024-drawing-odds-summary-report/?wpdmdl=48996&ind=1722886916814&refresh=e3b7b9e7&filename=1722886916wpdm_2024OddsSummary.xlsx";

const TARGET_YEAR = 2024;

interface PerRunResult {
  url: string;
  httpStatus?: number;
  bytes?: number;
  sheetsFound?: string[];
  parsedRows?: number;
  inserted: number;
  conflictsSkipped: number;
  huntUnitsCreated: number;
  errors: string[];
  sampleRows?: unknown[];
}

export async function POST(request: NextRequest) {
  try {
    return await handlePost(request);
  } catch (err) {
    console.error("[admin:seed-nmdgf] FATAL:", err);
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

  const [nmState] = await db.select({ id: states.id }).from(states).where(eq(states.code, "NM")).limit(1);
  if (!nmState) return NextResponse.json({ error: "NM state row not found in DB" }, { status: 404 });

  const sourceName = `NMDGF ${TARGET_YEAR} Drawing Odds Summary`;
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
        url: "https://wildlife.dgf.nm.gov/hunting/applications-and-draw-information/",
        refreshCadence: "annual",
        status: "active",
      })
      .returning({ id: dataSources.id });
    sourceId = inserted.id;
  }

  const result: PerRunResult = {
    url: NM_XLSX_URL,
    inserted: 0,
    conflictsSkipped: 0,
    huntUnitsCreated: 0,
    errors: [],
  };

  // Pre-load all species into a slug → id map
  const allSpecies = await db.select({ id: species.id, slug: species.slug }).from(species);
  const speciesMap = new Map<string, string>();
  for (const s of allSpecies) speciesMap.set(s.slug, s.id);

  function detectSpecies(text: string): string | null {
    const t = (text || "").toLowerCase();
    if (t.includes("elk")) return "elk";
    if (t.includes("antelope") || t.includes("pronghorn")) return "pronghorn";
    if (t.includes("oryx")) return "oryx";
    if (t.includes("ibex")) return "ibex";
    if (t.includes("barbary")) return "barbary_sheep";
    if (t.includes("javelina")) return "javelina";
    if (t.includes("moose")) return "moose";
    if (t.includes("sheep") || t.includes("bighorn")) return "bighorn_sheep";
    if (t.includes("goat")) return "mountain_goat";
    if (t.includes("turkey")) return "turkey";
    if (t.includes("bison") || t.includes("buffalo")) return "bison";
    if (t.includes("deer")) return "mule_deer";
    if (t.includes("bear")) return "black_bear";
    return null;
  }

  try {
    const fetchRes = await fetch(NM_XLSX_URL, {
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

    type SheetRow = Record<string, unknown>;
    const allRows: SheetRow[] = [];
    for (const sheetName of wb.SheetNames) {
      const sheet = wb.Sheets[sheetName];
      if (!sheet) continue;
      const sheetRows = XLSX.utils.sheet_to_json<SheetRow>(sheet, { defval: null });
      for (const row of sheetRows) {
        (row as { _sheet?: string })._sheet = sheetName;
        allRows.push(row);
      }
    }
    result.parsedRows = allRows.length;

    if (debug) {
      result.sampleRows = allRows.slice(0, 12);
      return NextResponse.json({ ok: true, perRun: result, elapsedMs: Date.now() - startedAt });
    }

    // Heuristic column resolver — NMDGF column names vary by sheet
    function pickCol(row: SheetRow, candidates: string[]): unknown {
      for (const candidate of candidates) {
        for (const key of Object.keys(row)) {
          if (key.toLowerCase().includes(candidate.toLowerCase())) return row[key];
        }
      }
      return null;
    }

    for (const row of allRows) {
      const description =
        (pickCol(row, ["hunt", "description", "name"]) as string) ||
        ((row as { _sheet?: string })._sheet ?? "");
      const speciesSlug = detectSpecies(description);
      if (!speciesSlug) continue;
      const huntSpeciesId = speciesMap.get(speciesSlug);
      if (!huntSpeciesId) continue;

      const unitCode = String(pickCol(row, ["gmu", "unit", "area"]) ?? "").trim();
      if (!unitCode || unitCode.length > 50) continue;

      const totalApplicantsRaw = pickCol(row, ["applicant", "applicants"]);
      const totalTagsRaw = pickCol(row, ["permits", "tags", "licenses", "drawn"]);
      const totalApplicants = typeof totalApplicantsRaw === "number"
        ? totalApplicantsRaw
        : parseInt(String(totalApplicantsRaw ?? ""), 10) || null;
      const totalTags = typeof totalTagsRaw === "number"
        ? totalTagsRaw
        : parseInt(String(totalTagsRaw ?? ""), 10) || null;

      let huntUnitId: string | null = null;
      const [existingUnit] = await db
        .select({ id: huntUnits.id })
        .from(huntUnits)
        .where(
          and(
            eq(huntUnits.stateId, nmState.id),
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
              stateId: nmState.id,
              speciesId: huntSpeciesId,
              unitCode,
              unitName: `GMU ${unitCode} — ${description.slice(0, 100)}`,
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
                eq(huntUnits.stateId, nmState.id),
                eq(huntUnits.speciesId, huntSpeciesId),
                eq(huntUnits.unitCode, unitCode),
              ),
            )
            .limit(1);
          if (reread) huntUnitId = reread.id;
        }
      }

      const safeInt = (n: unknown): number | null =>
        typeof n === "number" && !Number.isNaN(n) ? Math.trunc(n) : null;
      const apps = safeInt(totalApplicants);
      const tags = safeInt(totalTags);
      const drawRate = apps != null && apps > 0 && tags != null ? tags / apps : null;

      try {
        const insertResult = await db
          .insert(drawOdds)
          .values({
            stateId: nmState.id,
            speciesId: huntSpeciesId,
            huntUnitId,
            year: TARGET_YEAR,
            residentType: "nonresident",
            weaponType: null,
            choiceRank: 1,
            totalApplicants: apps,
            totalTags: tags,
            drawRate,
            sourceId,
            rawData: { parser: "nmdgf-xlsx-inline", description, unitCode, row },
          })
          .onConflictDoNothing();
        const rowsAffected = (insertResult as unknown as { rowCount?: number }).rowCount ?? 1;
        if (rowsAffected > 0) result.inserted++;
        else result.conflictsSkipped++;
      } catch (insertErr) {
        const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
        if (msg.includes("duplicate") || msg.includes("conflict")) result.conflictsSkipped++;
        else result.errors.push(`Insert err on ${unitCode}: ${msg}`);
      }
    }
  } catch (err) {
    result.errors.push(`Top-level error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const [counts] = await db
    .select({ drawOddsCount: drizzleSql<number>`COUNT(*)::int` })
    .from(drawOdds)
    .where(eq(drawOdds.stateId, nmState.id));

  return NextResponse.json({
    ok: true,
    stateCode: "NM",
    year: TARGET_YEAR,
    elapsedMs: Date.now() - startedAt,
    perRun: result,
    drawOddsRowsInDb: counts?.drawOddsCount ?? 0,
  });
}

export async function GET() {
  const [nmState] = await db.select({ id: states.id }).from(states).where(eq(states.code, "NM")).limit(1);
  if (!nmState) return NextResponse.json({ error: "NM not seeded" }, { status: 404 });

  const [counts] = await db
    .select({ drawOddsCount: drizzleSql<number>`COUNT(*)::int` })
    .from(drawOdds)
    .where(eq(drawOdds.stateId, nmState.id));

  return NextResponse.json({
    endpoint: "POST /api/admin/seed-nmdgf-draw-odds",
    auth: "Authorization: Bearer <CRON_SECRET>",
    query: "?debug=1 (returns first 12 parsed rows)",
    xlsxUrl: NM_XLSX_URL,
    currentDb: { nmDrawOddsRows: counts?.drawOddsCount ?? 0 },
  });
}
