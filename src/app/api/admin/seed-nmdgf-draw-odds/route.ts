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

    // Known column layout (discovered from debug=1):
    //   Col 0 (first key)       = Hunt Code (e.g. "ANT-1-101") OR section header
    //                             (e.g. "PRONGHORN" — sets current species)
    //   __EMPTY                  = Unit/Description text
    //   __EMPTY_1                = Bag type (ES, MB, ML, etc.)
    //   __EMPTY_2                = Licenses (quota / total tags)
    //   __EMPTY_3..6             = Hunt Total applicants: 1st, 2nd, 3rd, T
    //   __EMPTY_7..10            = Resident applicants: 1st, 2nd, 3rd, T
    //   __EMPTY_11..14           = Non-Resident applicants: 1st, 2nd, 3rd, T
    //   __EMPTY_15..18           = Outfitter applicants: 1st, 2nd, 3rd, T
    //   __EMPTY_20               = Hunt Code (repeated on right half — distribution)
    //   __EMPTY_22               = Licenses
    //   __EMPTY_23               = Resident drawn count
    //   __EMPTY_24               = Non-Resident drawn count
    //   __EMPTY_25               = Outfitter drawn count
    //   __EMPTY_26               = Total drawn
    //
    // Hunt code prefix tells us the species directly. Map:
    const HUNT_PREFIX_TO_SPECIES: Record<string, string> = {
      ANT: "pronghorn",
      DEE: "mule_deer",
      DER: "mule_deer",
      DRC: "mule_deer", // deer central
      DRN: "mule_deer",
      DRS: "mule_deer",
      ELK: "elk",
      EHC: "elk",
      EHA: "elk",
      EHM: "elk",
      EHN: "elk",
      EHB: "elk",
      IBE: "ibex",
      ORY: "oryx",
      BBS: "barbary_sheep",
      BIG: "bighorn_sheep",
      BHS: "bighorn_sheep",
      MTG: "mountain_goat",
      JAV: "javelina",
      TUR: "turkey",
      BEA: "black_bear",
      BLB: "black_bear",
      BSN: "bison",
      BIS: "bison",
    };

    const FIRST_COL_KEY = "2024-25 Big-Game Drawing Odds Summary";
    let currentSpeciesSlug: string | null = null;

    function toNum(v: unknown): number | null {
      if (typeof v === "number" && !Number.isNaN(v)) return v;
      if (typeof v === "string") {
        const n = parseFloat(v);
        return Number.isNaN(n) ? null : n;
      }
      return null;
    }
    const safeInt = (n: number | null): number | null =>
      n == null || Number.isNaN(n) ? null : Math.trunc(n);

    for (const row of allRows) {
      const firstCol = String((row as Record<string, unknown>)[FIRST_COL_KEY] ?? "").trim();
      if (!firstCol) continue;

      // Section header rows (e.g. "PRONGHORN") update currentSpeciesSlug
      // and have no data.
      const sectionSpecies = detectSpecies(firstCol);
      if (sectionSpecies && !firstCol.includes("-")) {
        currentSpeciesSlug = sectionSpecies;
        continue;
      }

      // Hunt code rows look like "ANT-1-101"
      const huntCodeMatch = firstCol.match(/^([A-Z]{3,4})-(\d+)-(\d+)$/);
      if (!huntCodeMatch) continue;

      const prefix = huntCodeMatch[1];
      const speciesSlug =
        HUNT_PREFIX_TO_SPECIES[prefix] ?? currentSpeciesSlug;
      if (!speciesSlug) continue;
      const huntSpeciesId = speciesMap.get(speciesSlug);
      if (!huntSpeciesId) continue;

      const description = String((row as Record<string, unknown>).__EMPTY ?? "").trim();
      const bagType = String((row as Record<string, unknown>).__EMPTY_1 ?? "").trim();
      const totalTags = safeInt(toNum((row as Record<string, unknown>).__EMPTY_2));
      const resApplicants = safeInt(toNum((row as Record<string, unknown>).__EMPTY_7)); // 1st choice res
      const nrApplicants = safeInt(toNum((row as Record<string, unknown>).__EMPTY_11)); // 1st choice NR
      const resDrawn = safeInt(toNum((row as Record<string, unknown>).__EMPTY_23));
      const nrDrawn = safeInt(toNum((row as Record<string, unknown>).__EMPTY_24));

      const unitCode = firstCol; // hunt code as unit code
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
              unitName: `${unitCode} — ${description.slice(0, 100)} [${bagType}]`,
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

      // Insert one row per residency
      const residencies = [
        { residentType: "resident", apps: resApplicants, tags: resDrawn },
        { residentType: "nonresident", apps: nrApplicants, tags: nrDrawn },
      ];
      for (const r of residencies) {
        const drawRate =
          r.apps != null && r.apps > 0 && r.tags != null ? r.tags / r.apps : null;
        try {
          const insertResult = await db
            .insert(drawOdds)
            .values({
              stateId: nmState.id,
              speciesId: huntSpeciesId,
              huntUnitId,
              year: TARGET_YEAR,
              residentType: r.residentType,
              weaponType: null,
              choiceRank: 1,
              totalApplicants: r.apps,
              totalTags: r.tags,
              drawRate,
              sourceId,
              rawData: {
                parser: "nmdgf-xlsx-inline",
                huntCode: unitCode,
                description,
                bagType,
                totalTagsQuota: totalTags,
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
          else result.errors.push(`Insert err on ${unitCode}: ${msg}`);
        }
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
