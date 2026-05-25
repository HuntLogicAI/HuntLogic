/**
 * POST /api/admin/seed-utdwr-draw-odds
 *
 * Ingests Utah Division of Wildlife Resources draw odds PDFs:
 *   - 25_bg-odds.pdf: Limited-entry permits for elk, deer, pronghorn,
 *     moose, sheep, goat (one comprehensive doc).
 *   - 25_deer_odds.pdf: General-season deer.
 *
 * Same pattern as WGFD / CPW endpoints. Parser is a first cut — debug=1
 * to inspect actual format and iterate.
 *
 * Guarded by CRON_SECRET. ?species=elk|mule_deer|... to filter, ?debug=1
 * to dump a 20KB sample of extracted PDF text.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, sql as drizzleSql, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { states, species, huntUnits, drawOdds, dataSources } from "@/lib/db/schema";

const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.DOMMatrix === "undefined") g.DOMMatrix = class DOMMatrix {};
if (typeof g.Path2D === "undefined") g.Path2D = class Path2D {};
if (typeof g.ImageData === "undefined") g.ImageData = class ImageData {};

export const runtime = "nodejs";
export const maxDuration = 300;

interface UtPdfTarget {
  url: string;
  // For comprehensive PDFs, we leave speciesSlug null and let the parser
  // detect species per row. For species-specific PDFs, this filters.
  speciesSlug: string | null;
  label: string;
}

const UT_PDFS: UtPdfTarget[] = [
  // Comprehensive limited-entry — covers elk, deer, pronghorn, moose,
  // sheep, goat. Parser must detect species per row.
  { url: "https://wildlife.utah.gov/pdf/bg/2025/25_bg-odds.pdf", speciesSlug: null, label: "UT 2025 Limited Entry Draw Odds (all species)" },
  // General-season deer
  { url: "https://wildlife.utah.gov/pdf/bg/2025/25_deer_odds.pdf", speciesSlug: "mule_deer", label: "UT 2025 General Season Deer" },
];

const TARGET_YEAR = 2025;

interface PerPdfResult {
  label: string;
  url: string;
  httpStatus?: number;
  bytes?: number;
  parsedRecords?: number;
  qualityScore?: number;
  inserted: number;
  conflictsSkipped: number;
  huntUnitsCreated: number;
  errors: string[];
  textSample?: string;
  textLength?: number;
}

export async function POST(request: NextRequest) {
  try {
    return await handlePost(request);
  } catch (err) {
    console.error("[admin:seed-utdwr] FATAL:", err);
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
  const debug = url.searchParams.get("debug") === "1";
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);
  const which = url.searchParams.get("which"); // "bg-odds" or "deer-odds" to filter PDFs

  const targets = which
    ? UT_PDFS.filter((p) => p.url.includes(which))
    : UT_PDFS;

  if (targets.length === 0) {
    return NextResponse.json({ error: `No PDF target matches which=${which}` }, { status: 400 });
  }

  const startedAt = Date.now();

  const [utState] = await db.select({ id: states.id }).from(states).where(eq(states.code, "UT")).limit(1);
  if (!utState) return NextResponse.json({ error: "UT state row not found in DB" }, { status: 404 });

  const sourceName = `UTDWR ${TARGET_YEAR} Draw Odds Reports`;
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
        url: "https://wildlife.utah.gov/biggame/odds",
        refreshCadence: "annual",
        status: "active",
      })
      .returning({ id: dataSources.id });
    sourceId = inserted.id;
  }

  const { extractText, getDocumentProxy } = await import("unpdf");

  // Build a slug → id map for all species so we can detect species per row
  const allSpecies = await db.select({ id: species.id, slug: species.slug }).from(species);
  const speciesMap = new Map<string, string>();
  for (const s of allSpecies) speciesMap.set(s.slug, s.id);

  const results: PerPdfResult[] = [];

  for (const target of targets) {
    const result: PerPdfResult = {
      label: target.label,
      url: target.url,
      inserted: 0,
      conflictsSkipped: 0,
      huntUnitsCreated: 0,
      errors: [],
    };

    try {
      const fetchRes = await fetch(target.url, {
        headers: { "User-Agent": "Mozilla/5.0 HuntLogic/1.0" },
        redirect: "follow",
      });
      result.httpStatus = fetchRes.status;
      if (!fetchRes.ok) {
        result.errors.push(`HTTP ${fetchRes.status} fetching PDF`);
        results.push(result);
        continue;
      }

      const buf = await fetchRes.arrayBuffer();
      result.bytes = buf.byteLength;

      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { text } = await extractText(pdf, { mergePages: true });
      const fullText = Array.isArray(text) ? text.join("\n") : (text as string);

      if (debug) {
        result.textSample = fullText.slice(offset, offset + 20000);
        result.textLength = fullText.length;
      }

      // UTDWR per-hunt parser.
      //
      // Each hunt block starts with "Hunt: HUNTCODE description". HUNTCODE
      // is 2 letters + 4 digits (DB1000, EB1234, etc.). Description names
      // the species explicitly (Buck Deer, Bull Elk, Antelope, etc.) plus
      // the hunt area.
      //
      // Within each block, point-level rows are side-by-side:
      //   pts res_apps res_bonus res_regular res_total res_ratio  pts nr_apps nr_bonus nr_regular nr_total nr_ratio
      // followed by a "Totals" row.
      //
      // We emit one draw_odds row per (hunt × residency). min_points_drawn
      // = highest point level where the residency drew > 0 total permits.
      // total_applicants / total_tags come from the Totals row.

      const HUNT_HEADER_RE =
        /Hunt:\s+([A-Z]{2}\d{4})\s+([^\n]+?)(?=\s+Page\s+\d+|\n|$)/g;

      // Species detection from the description text
      function detectSpecies(description: string): string | null {
        const d = description.toLowerCase();
        if (d.includes("elk")) return "elk";
        if (d.includes("antelope") || d.includes("pronghorn")) return "pronghorn";
        if (d.includes("moose")) return "moose";
        if (d.includes("sheep") || d.includes("bighorn")) return "bighorn_sheep";
        if (d.includes("goat")) return "mountain_goat";
        if (d.includes("bison") || d.includes("buffalo")) return "bison";
        if (d.includes("deer")) return "mule_deer";
        if (d.includes("bear")) return "black_bear";
        return null;
      }

      function detectWeapon(description: string): string | null {
        const d = description.toLowerCase();
        if (d.includes("archery") || d.includes("- archery")) return "archery";
        if (d.includes("muzzleloader")) return "muzzleloader";
        if (d.includes("any legal weapon") || d.includes("alw") || d.includes("rifle"))
          return "rifle";
        return null;
      }

      // Each row in the side-by-side table:
      //   pts res_apps res_bonus res_regular res_total res_ratio  pts nr_apps nr_bonus nr_regular nr_total nr_ratio
      // Ratio is "1 in N.N" or "N/A"
      // Be flexible: the ratio may be split into "1 in" and "N.N" by whitespace, or "N/A".
      const ROW_RE =
        /(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(?:1\s+in\s+[\d.]+|N\/A|in\s+[\d.]+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(?:1\s+in\s+[\d.]+|N\/A|in\s+[\d.]+)/g;

      // Find all hunt headers + the text up to the next header
      const huntMatches: Array<{ code: string; description: string; startIdx: number }> = [];
      let hMatch: RegExpExecArray | null;
      while ((hMatch = HUNT_HEADER_RE.exec(fullText)) !== null) {
        huntMatches.push({
          code: hMatch[1],
          description: hMatch[2].trim(),
          startIdx: hMatch.index,
        });
      }

      result.parsedRecords = huntMatches.length;
      let withData = 0;

      for (let i = 0; i < huntMatches.length; i++) {
        const current = huntMatches[i];
        const nextIdx = i + 1 < huntMatches.length ? huntMatches[i + 1].startIdx : fullText.length;
        const block = fullText.slice(current.startIdx, nextIdx);

        const huntSpeciesSlug = detectSpecies(current.description);
        if (!huntSpeciesSlug) continue;
        if (target.speciesSlug && huntSpeciesSlug !== target.speciesSlug) continue;
        // Filter to species we actually have in the DB
        const huntSpeciesId = speciesMap.get(huntSpeciesSlug);
        if (!huntSpeciesId) continue;

        const weaponType = detectWeapon(current.description);

        // Parse all the per-point-level rows
        const rows: Array<{
          points: number;
          resApps: number;
          resTotal: number;
          nrApps: number;
          nrTotal: number;
        }> = [];
        ROW_RE.lastIndex = 0;
        let rMatch: RegExpExecArray | null;
        while ((rMatch = ROW_RE.exec(block)) !== null) {
          rows.push({
            points: parseInt(rMatch[1], 10),
            resApps: parseInt(rMatch[2], 10),
            resTotal: parseInt(rMatch[5], 10),
            nrApps: parseInt(rMatch[7], 10),
            nrTotal: parseInt(rMatch[11], 10),
          });
        }

        if (rows.length === 0) continue;
        withData++;

        // Aggregate to find min_points_drawn (highest pts with > 0 permits)
        // and totals (sum of all rows for each residency).
        let resMinPoints: number | null = null;
        let nrMinPoints: number | null = null;
        let resTotalApps = 0;
        let nrTotalApps = 0;
        let resTotalTags = 0;
        let nrTotalTags = 0;
        for (const r of rows) {
          resTotalApps += r.resApps;
          nrTotalApps += r.nrApps;
          resTotalTags += r.resTotal;
          nrTotalTags += r.nrTotal;
          if (r.resTotal > 0 && (resMinPoints === null || r.points > resMinPoints))
            resMinPoints = r.points;
          if (r.nrTotal > 0 && (nrMinPoints === null || r.points > nrMinPoints))
            nrMinPoints = r.points;
        }

        // Use hunt code as unit_code; preserve description as unit_name
        const unitCode = current.code;
        let huntUnitId: string | null = null;
        const [existingUnit] = await db
          .select({ id: huntUnits.id })
          .from(huntUnits)
          .where(
            and(
              eq(huntUnits.stateId, utState.id),
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
                stateId: utState.id,
                speciesId: huntSpeciesId,
                unitCode,
                unitName: `${unitCode} — ${current.description.slice(0, 100)}`,
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
                  eq(huntUnits.stateId, utState.id),
                  eq(huntUnits.speciesId, huntSpeciesId),
                  eq(huntUnits.unitCode, unitCode),
                ),
              )
              .limit(1);
            if (reread) huntUnitId = reread.id;
          }
        }

        const residencies = [
          {
            residentType: "resident",
            totalApps: resTotalApps,
            totalTags: resTotalTags,
            minPoints: resMinPoints,
          },
          {
            residentType: "nonresident",
            totalApps: nrTotalApps,
            totalTags: nrTotalTags,
            minPoints: nrMinPoints,
          },
        ];

        for (const r of residencies) {
          try {
            const insertResult = await db
              .insert(drawOdds)
              .values({
                stateId: utState.id,
                speciesId: huntSpeciesId,
                huntUnitId,
                year: TARGET_YEAR,
                residentType: r.residentType,
                weaponType,
                choiceRank: 1,
                totalApplicants: r.totalApps,
                totalTags: r.totalTags,
                minPointsDrawn: r.minPoints,
                drawRate: r.totalApps > 0 ? r.totalTags / r.totalApps : null,
                sourceId,
                rawData: {
                  parser: "utdwr-side-by-side-inline",
                  huntCode: current.code,
                  description: current.description,
                  speciesSlug: huntSpeciesSlug,
                  weaponType,
                  rowCount: rows.length,
                },
              })
              .onConflictDoNothing();
            const rowsAffected = (insertResult as unknown as { rowCount?: number }).rowCount ?? 1;
            if (rowsAffected > 0) result.inserted++;
            else result.conflictsSkipped++;
          } catch (insertErr) {
            const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
            if (msg.includes("duplicate") || msg.includes("conflict")) result.conflictsSkipped++;
            else result.errors.push(`Insert err on ${current.code}: ${msg}`);
          }
        }
      }

      result.qualityScore = huntMatches.length > 0
        ? Math.round((withData / huntMatches.length) * 100)
        : 0;
    } catch (err) {
      result.errors.push(`Top-level error: ${err instanceof Error ? err.message : String(err)}`);
    }

    results.push(result);
  }

  const [counts] = await db
    .select({ drawOddsCount: drizzleSql<number>`COUNT(*)::int` })
    .from(drawOdds)
    .where(eq(drawOdds.stateId, utState.id));

  return NextResponse.json({
    ok: true,
    stateCode: "UT",
    year: TARGET_YEAR,
    speciesFilter,
    which,
    elapsedMs: Date.now() - startedAt,
    perPdf: results,
    totals: {
      newInsertsThisRun: results.reduce((s, r) => s + r.inserted, 0),
      conflictsSkippedThisRun: results.reduce((s, r) => s + r.conflictsSkipped, 0),
      huntUnitsCreatedThisRun: results.reduce((s, r) => s + r.huntUnitsCreated, 0),
      drawOddsRowsInDb: counts?.drawOddsCount ?? 0,
    },
  });
}


export async function GET() {
  const [utState] = await db.select({ id: states.id }).from(states).where(eq(states.code, "UT")).limit(1);
  if (!utState) return NextResponse.json({ error: "UT not seeded" }, { status: 404 });

  const [counts] = await db
    .select({ drawOddsCount: drizzleSql<number>`COUNT(*)::int` })
    .from(drawOdds)
    .where(eq(drawOdds.stateId, utState.id));

  return NextResponse.json({
    endpoint: "POST /api/admin/seed-utdwr-draw-odds",
    auth: "Authorization: Bearer <CRON_SECRET>",
    query: "?which=bg-odds|deer-odds, ?debug=1, ?offset=N",
    pdfTargets: UT_PDFS,
    currentDb: { utDrawOddsRows: counts?.drawOddsCount ?? 0 },
  });
}
