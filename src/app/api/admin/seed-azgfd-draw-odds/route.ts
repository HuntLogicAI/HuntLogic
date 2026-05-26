/**
 * POST /api/admin/seed-azgfd-draw-odds
 *
 * Ingests Arizona Game and Fish Department 2024 Draw Odds PDFs for elk,
 * deer, pronghorn, bighorn sheep, and javelina. Populates draw_odds +
 * auto-creates hunt_units.
 *
 * AZGFD publishes separate PDFs per species (S3-hosted). Parser is a
 * first cut against the AZ format — debug=1 to inspect and iterate.
 *
 * Guarded by CRON_SECRET. ?species=elk|mule_deer|... filters; ?debug=1
 * dumps a 20KB text sample.
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

interface AzPdfTarget {
  url: string;
  speciesSlug: string;
  label: string;
}

const AZ_PDFS: AzPdfTarget[] = [
  { url: "https://azgfd-portal-wordpress-pantheon.s3.us-west-2.amazonaws.com/wp-content/uploads/2024/12/02085505/2024-AZ-Elk-Draw-Odds.pdf", speciesSlug: "elk", label: "2024 AZ Elk Draw Odds" },
  { url: "https://azgfd-portal-wordpress-pantheon.s3.us-west-2.amazonaws.com/wp-content/uploads/2024/12/02085502/2024-AZ-Deer-Draw-Odds.pdf", speciesSlug: "mule_deer", label: "2024 AZ Deer Draw Odds" },
  { url: "https://azgfd-portal-wordpress-pantheon.s3.us-west-2.amazonaws.com/wp-content/uploads/2024/12/02085516/2024-AZ-Pronghorn-Draw-Odds.pdf", speciesSlug: "pronghorn", label: "2024 AZ Pronghorn Draw Odds" },
  { url: "https://azgfd-portal-wordpress-pantheon.s3.us-west-2.amazonaws.com/wp-content/uploads/2024/12/02085454/2024-AZ-Bighorn-Sheep-Draw-Odds.pdf", speciesSlug: "bighorn_sheep", label: "2024 AZ Bighorn Sheep Draw Odds" },
  { url: "https://azgfd-portal-wordpress-pantheon.s3.us-west-2.amazonaws.com/wp-content/uploads/2024/12/02085522/2024-AZ-Spring-Javelina-Draw-Odds.pdf", speciesSlug: "javelina", label: "2024 AZ Spring Javelina Draw Odds" },
];

const TARGET_YEAR = 2024;

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
    console.error("[admin:seed-azgfd] FATAL:", err);
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
  const targets = speciesFilter ? AZ_PDFS.filter((p) => p.speciesSlug === speciesFilter) : AZ_PDFS;

  if (targets.length === 0) {
    return NextResponse.json({ error: `No PDF target matches species=${speciesFilter}` }, { status: 400 });
  }

  const startedAt = Date.now();
  const [azState] = await db.select({ id: states.id }).from(states).where(eq(states.code, "AZ")).limit(1);
  if (!azState) return NextResponse.json({ error: "AZ state row not found in DB" }, { status: 404 });

  const sourceName = `AZGFD ${TARGET_YEAR} Draw Odds Reports`;
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
        url: "https://www.azgfd.com/hunting/hunt-draw-and-licenses/harvest-reporting/",
        refreshCadence: "annual",
        status: "active",
      })
      .returning({ id: dataSources.id });
    sourceId = inserted.id;
  }

  const { extractText, getDocumentProxy } = await import("unpdf");
  const results: PerPdfResult[] = [];

  // Defensive: never let NaN reach the DB
  const safeInt = (n: number | null | undefined): number | null =>
    n == null || Number.isNaN(n) ? null : Math.trunc(n);
  const safeReal = (n: number | null | undefined): number | null =>
    n == null || Number.isNaN(n) || !Number.isFinite(n) ? null : n;

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
      const [speciesRow] = await db
        .select({ id: species.id })
        .from(species)
        .where(eq(species.slug, target.speciesSlug))
        .limit(1);
      if (!speciesRow) {
        result.errors.push(`Species '${target.speciesSlug}' not found in DB`);
        results.push(result);
        continue;
      }
      const speciesId = speciesRow.id;

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
        results.push(result);
        continue;
      }

      // AZGFD draw odds parser.
      //
      // Columnar format (one row per hunt):
      //   UNIT  HUNT  YEAR  METHOD  SEASON_OPEN  SEASON_CLOSE  HUNT_TYPE
      //   FIRST_CHOICE_APPLICANTS  SECOND_CHOICE_APPLICANTS  PERMITS_ISSUED  ODDS
      //
      // unpdf concatenates all rows on one line. Find each row by anchoring
      // on the 4-digit hunt number followed by " 2024 " — that's a reliable
      // row-start signal. The UNIT is the token(s) right before the hunt
      // number; the rest of the row follows.
      //
      // Hunt numbers are unique (3001-3999 for elk, etc.) so we can use a
      // capture that goes from one hunt number to just before the next one.

      const HUNT_ROW_RE =
        /([A-Z0-9][\w/]*(?:\s+\([\w\s]+\))?|Camp\s+Navajo)\s+(\d{4})\s+2024\s+([\w\-()\s/]+?)\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(Early\s+Bull\s+elk|Bull\s+elk|Antlerless\s+elk|Any\s+elk|[\w\s]+?(?:elk|deer|antelope|pronghorn|sheep|javelina|bear|turkey))\s+(\d+)\s+(\d+)\s+(\d+|#DIV\/0!)\s+(\d+\.\d+|#DIV\/0!|\d+)/g;

      function decodeMethod(method: string): { weaponType: string | null; isYouth: boolean } {
        const m = method.toLowerCase();
        return {
          weaponType: m.includes("archery") ? "archery"
            : m.includes("muzzleloader") ? "muzzleloader"
            : m.includes("general") || m.includes("ham") || m.includes("limited opportunity") || m.includes("champ") ? "rifle"
            : null,
          isYouth: m.includes("youth"),
        };
      }

      const parsedRows: Array<{
        unit: string;
        huntCode: string;
        method: string;
        seasonOpen: string;
        seasonClose: string;
        huntType: string;
        firstChoiceApps: number;
        secondChoiceApps: number;
        permitsIssued: number | null;
        odds: number | null;
      }> = [];

      let rowMatch: RegExpExecArray | null;
      while ((rowMatch = HUNT_ROW_RE.exec(fullText)) !== null) {
        const permitsRaw = rowMatch[9];
        const oddsRaw = rowMatch[10];
        parsedRows.push({
          unit: rowMatch[1].trim(),
          huntCode: rowMatch[2],
          method: rowMatch[3].trim(),
          seasonOpen: rowMatch[4],
          seasonClose: rowMatch[5],
          huntType: rowMatch[6].trim(),
          firstChoiceApps: parseInt(rowMatch[7], 10),
          secondChoiceApps: parseInt(rowMatch[8], 10),
          permitsIssued: permitsRaw === "#DIV/0!" ? null : parseInt(permitsRaw, 10),
          odds: oddsRaw === "#DIV/0!" ? null : parseFloat(oddsRaw),
        });
      }

      result.parsedRecords = parsedRows.length;
      result.qualityScore = parsedRows.length > 0 ? 100 : 0;

      // Insert one row per hunt (we infer residency = nonresident — AZ draw
      // is split by allocation pool, not by residency directly. AZ has a 20%
      // NR cap; the odds we have here are first-choice-overall, applicable
      // to either residency at the published level.)
      for (const row of parsedRows) {
        const unitCode = row.unit;
        const { weaponType, isYouth } = decodeMethod(row.method);

        let huntUnitId: string | null = null;
        const [existingUnit] = await db
          .select({ id: huntUnits.id })
          .from(huntUnits)
          .where(
            and(
              eq(huntUnits.stateId, azState.id),
              eq(huntUnits.speciesId, speciesId),
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
                stateId: azState.id,
                speciesId,
                unitCode,
                unitName: `Unit ${unitCode} — AZ ${target.speciesSlug}`,
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
                  eq(huntUnits.stateId, azState.id),
                  eq(huntUnits.speciesId, speciesId),
                  eq(huntUnits.unitCode, unitCode),
                ),
              )
              .limit(1);
            if (reread) huntUnitId = reread.id;
          }
        }

        // odds is published as percent (0-100 range)
        const drawRate = safeReal(row.odds != null ? row.odds / 100 : null);

        try {
          const insertResult = await db
            .insert(drawOdds)
            .values({
              stateId: azState.id,
              speciesId,
              huntUnitId,
              year: TARGET_YEAR,
              residentType: "nonresident",
              weaponType,
              choiceRank: 1,
              totalApplicants: safeInt(row.firstChoiceApps),
              totalTags: safeInt(row.permitsIssued),
              drawRate,
              sourceId,
              rawData: {
                parser: "azgfd-tabular-inline",
                ...row,
                isYouth,
              },
            })
            .onConflictDoNothing();
          const rowsAffected = (insertResult as unknown as { rowCount?: number }).rowCount ?? 1;
          if (rowsAffected > 0) result.inserted++;
          else result.conflictsSkipped++;
        } catch (insertErr) {
          const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
          if (msg.includes("duplicate") || msg.includes("conflict")) result.conflictsSkipped++;
          else result.errors.push(`Insert err on ${row.huntCode}: ${msg}`);
        }
      }
    } catch (err) {
      result.errors.push(`Top-level error: ${err instanceof Error ? err.message : String(err)}`);
    }

    results.push(result);
  }

  const [counts] = await db
    .select({ drawOddsCount: drizzleSql<number>`COUNT(*)::int` })
    .from(drawOdds)
    .where(eq(drawOdds.stateId, azState.id));

  return NextResponse.json({
    ok: true,
    stateCode: "AZ",
    year: TARGET_YEAR,
    speciesFilter,
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
  const [azState] = await db.select({ id: states.id }).from(states).where(eq(states.code, "AZ")).limit(1);
  if (!azState) return NextResponse.json({ error: "AZ not seeded" }, { status: 404 });
  const [counts] = await db
    .select({ drawOddsCount: drizzleSql<number>`COUNT(*)::int` })
    .from(drawOdds)
    .where(eq(drawOdds.stateId, azState.id));
  return NextResponse.json({
    endpoint: "POST /api/admin/seed-azgfd-draw-odds",
    auth: "Authorization: Bearer <CRON_SECRET>",
    query: "?species=elk|mule_deer|pronghorn|bighorn_sheep|javelina, ?debug=1, ?offset=N",
    pdfTargets: AZ_PDFS,
    currentDb: { azDrawOddsRows: counts?.drawOddsCount ?? 0 },
  });
}
