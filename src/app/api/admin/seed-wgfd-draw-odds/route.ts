/**
 * POST /api/admin/seed-wgfd-draw-odds
 *
 * Ingests Wyoming Game and Fish Department draw odds PDFs for the major
 * big game species (elk, mule deer, pronghorn, bighorn sheep, moose) and
 * populates the draw_odds table.
 *
 * Idempotent: relies on draw_odds' unique index on
 * (state, species, hunt_unit, year, residency, weapon, choice_rank) and
 * uses ON CONFLICT DO NOTHING. Hunt units are auto-created if missing.
 *
 * Guarded by CRON_SECRET. Pass ?species=elk to process just one PDF for
 * focused debugging.
 *
 * NOTE: PDF parsing depends on WGFD's report layout. If WGFD updates the
 * PDF format mid-year, the column mappings below may need updating.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, sql as drizzleSql, and } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  states,
  species,
  huntUnits,
  drawOdds,
  dataSources,
} from "@/lib/db/schema";

// pdf-parse v2 uses pdfjs-dist which needs browser globals (DOMMatrix,
// Path2D, ImageData) that Node serverless runtimes don't have. Stub them
// with empty classes — pdf-parse only references their existence during
// import; we never actually render images or paths from these PDFs (text
// extraction only).
const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.DOMMatrix === "undefined") g.DOMMatrix = class DOMMatrix {};
if (typeof g.Path2D === "undefined") g.Path2D = class Path2D {};
if (typeof g.ImageData === "undefined") g.ImageData = class ImageData {};

export const runtime = "nodejs";
// PDF parsing + multiple fetches can be slow. Vercel Pro max.
export const maxDuration = 300;

interface WgfdPdfTarget {
  url: string;
  speciesSlug: string;
  label: string;
}

const WGFD_PDFS: WgfdPdfTarget[] = [
  { url: "https://wgfd.wyo.gov/media/32449/download?inline", speciesSlug: "elk", label: "NR Elk Random" },
  { url: "https://wgfd.wyo.gov/media/32699/download?inline", speciesSlug: "mule_deer", label: "NR Deer Random" },
  { url: "https://wgfd.wyo.gov/media/32690/download?inline", speciesSlug: "pronghorn", label: "NR Antelope Random" },
  { url: "https://wgfd.wyo.gov/media/32421/download?inline", speciesSlug: "bighorn_sheep", label: "NR Bighorn Random" },
  { url: "https://wgfd.wyo.gov/media/32422/download?inline", speciesSlug: "moose", label: "NR Moose Random" },
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
}

export async function POST(request: NextRequest) {
  try {
    return await handlePost(request);
  } catch (err) {
    console.error("[admin:seed-wgfd] FATAL:", err);
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
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const speciesFilter = url.searchParams.get("species");
  const debug = url.searchParams.get("debug") === "1";
  const targets = speciesFilter
    ? WGFD_PDFS.filter((p) => p.speciesSlug === speciesFilter)
    : WGFD_PDFS;

  if (targets.length === 0) {
    return NextResponse.json({ error: `No PDF target matches species=${speciesFilter}` }, { status: 400 });
  }

  const startedAt = Date.now();

  // Resolve WY state ID
  const [wyState] = await db
    .select({ id: states.id })
    .from(states)
    .where(eq(states.code, "WY"))
    .limit(1);
  if (!wyState) {
    return NextResponse.json({ error: "WY state row not found in DB" }, { status: 404 });
  }

  // Upsert a data_sources row to attach to the inserts
  const sourceName = `WGFD ${TARGET_YEAR} Draw Odds Report`;
  let sourceId: string;
  const [existingSource] = await db
    .select({ id: dataSources.id })
    .from(dataSources)
    .where(eq(dataSources.name, sourceName))
    .limit(1);
  if (existingSource) {
    sourceId = existingSource.id;
  } else {
    const [inserted] = await db
      .insert(dataSources)
      .values({
        name: sourceName,
        sourceType: "draw_report",
        // authority_tier: 1=official, 2=verified, 3=expert, 4=community
        // WGFD as the state agency is tier 1.
        authorityTier: 1,
        url: "https://wgfd.wyo.gov/Apply-or-Buy/Draw-Odds-Statistics",
        refreshCadence: "annual",
        status: "active",
      })
      .returning({ id: dataSources.id });
    sourceId = inserted.id;
  }

  // Lazy-import the parser + PDF library. We use `unpdf` instead of `pdf-parse`
  // because pdf-parse v2 pulls in pdfjs-dist which expects browser globals
  // (DOMMatrix) and a separate worker file (pdf.worker.mjs) — both of which
  // are absent in Vercel's serverless runtime. unpdf is purpose-built for
  // serverless: it bundles the polyfills and runs pdfjs synchronously without
  // a separate worker.
  const { DrawOddsTableParser } = await import(
    "@/services/ingestion/parsers/draw-odds-parser"
  );
  const { StateNormalizer } = await import(
    "@/services/ingestion/normalizers/state-normalizer"
  );
  const { extractText, getDocumentProxy } = await import("unpdf");
  const drawParser = new DrawOddsTableParser();
  const normalizer = new StateNormalizer();

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
      // Resolve species ID
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

      // Fetch PDF
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

      // Extract text via unpdf (serverless-safe)
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { text } = await extractText(pdf, { mergePages: true });
      const fullText = Array.isArray(text) ? text.join("\n") : (text as string);

      // In debug mode, attach a sample of extracted text so we can see what
      // format WGFD is publishing without grinding through more deploys.
      if (debug) {
        (result as PerPdfResult & { textSample?: string; textLength?: number }).textSample =
          fullText.slice(0, 2500);
        (result as PerPdfResult & { textSample?: string; textLength?: number }).textLength =
          fullText.length;
      }

      // Parse table
      const parsed = await drawParser.parse(fullText, {
        state_code: "WY",
        species_slug: target.speciesSlug,
        year: TARGET_YEAR,
        column_mappings: {
          unit: 0,
          weapon_type: 1,
          species: 2,
          total_tags: 3,
          total_applicants: 4,
        },
      });
      result.parsedRecords = parsed.records.length;
      result.qualityScore = parsed.qualityScore;

      // Normalize. parsed.records is typed as the parser's record type; the
      // normalizer accepts the same shape — cast through unknown to bypass
      // strict overlap checking since the array types are nominally different
      // but structurally compatible.
      const normalized = normalizer.normalizeDrawOdds(
        parsed.records as unknown as Parameters<typeof normalizer.normalizeDrawOdds>[0],
        "WY",
        "wgfd-pdf-seed",
      );

      // Insert each record. Hunt unit gets auto-created with bare code as
      // unit_name (enrichment is a follow-up step).
      for (const rec of normalized.records as Array<Record<string, unknown>>) {
        const rawUnit = (rec.unitCode as string) ?? "";
        const unitCode = normalizer.normalizeUnitCode(rawUnit, "WY");
        if (!unitCode) continue;

        // Look up or create hunt_unit
        let huntUnitId: string | null = null;
        const [existingUnit] = await db
          .select({ id: huntUnits.id })
          .from(huntUnits)
          .where(
            and(
              eq(huntUnits.stateId, wyState.id),
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
                stateId: wyState.id,
                speciesId,
                unitCode,
                unitName: unitCode, // bare code; enrichment is separate step
              })
              .returning({ id: huntUnits.id });
            huntUnitId = created.id;
            result.huntUnitsCreated++;
          } catch (huntErr) {
            // Could be a race or a constraint; recover with a SELECT
            const [reread] = await db
              .select({ id: huntUnits.id })
              .from(huntUnits)
              .where(
                and(
                  eq(huntUnits.stateId, wyState.id),
                  eq(huntUnits.speciesId, speciesId),
                  eq(huntUnits.unitCode, unitCode),
                ),
              )
              .limit(1);
            if (reread) huntUnitId = reread.id;
            else
              result.errors.push(
                `Could not create or find hunt_unit ${unitCode}: ${huntErr instanceof Error ? huntErr.message : String(huntErr)}`,
              );
          }
        }

        // Try inserting the draw_odds row
        try {
          const insertResult = await db
            .insert(drawOdds)
            .values({
              stateId: wyState.id,
              speciesId,
              huntUnitId,
              year: (rec.year as number) ?? TARGET_YEAR,
              residentType: (rec.residentType as string) ?? "nonresident",
              weaponType: (rec.weaponType as string) ?? null,
              choiceRank: (rec.choiceRank as number) ?? null,
              totalApplicants: (rec.totalApplicants as number) ?? null,
              totalTags: (rec.totalTags as number) ?? null,
              minPointsDrawn: (rec.minPointsDrawn as number) ?? null,
              maxPointsDrawn: (rec.maxPointsDrawn as number) ?? null,
              avgPointsDrawn: (rec.avgPointsDrawn as number) ?? null,
              drawRate: (rec.drawRate as number) ?? null,
              sourceId,
              rawData: (rec.rawRow as Record<string, unknown>) ?? {},
            })
            .onConflictDoNothing();
          // drizzle's onConflictDoNothing doesn't give us a clean "did insert"
          // signal across all drivers, so we approximate: assume insert succeeded
          // (most rows are first-time; subsequent runs will be conflict-skipped
          // and the total counts will still be useful per-run).
          const rowsAffected =
            (insertResult as unknown as { rowCount?: number }).rowCount ?? 1;
          if (rowsAffected > 0) {
            result.inserted++;
          } else {
            result.conflictsSkipped++;
          }
        } catch (insertErr) {
          const msg =
            insertErr instanceof Error ? insertErr.message : String(insertErr);
          if (!msg.includes("duplicate") && !msg.includes("conflict")) {
            result.errors.push(`Insert err on unit ${unitCode}: ${msg}`);
          } else {
            result.conflictsSkipped++;
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

  // Quick summary count
  const [counts] = await db
    .select({
      drawOddsCount: drizzleSql<number>`COUNT(*)::int`,
    })
    .from(drawOdds)
    .where(eq(drawOdds.stateId, wyState.id));

  return NextResponse.json({
    ok: true,
    stateCode: "WY",
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
  const [wyState] = await db
    .select({ id: states.id })
    .from(states)
    .where(eq(states.code, "WY"))
    .limit(1);
  if (!wyState) {
    return NextResponse.json({ error: "WY not seeded" }, { status: 404 });
  }

  const [counts] = await db
    .select({
      drawOddsCount: drizzleSql<number>`COUNT(*)::int`,
    })
    .from(drawOdds)
    .where(eq(drawOdds.stateId, wyState.id));

  const [huntUnitCount] = await db
    .select({
      count: drizzleSql<number>`COUNT(*)::int`,
    })
    .from(huntUnits)
    .where(eq(huntUnits.stateId, wyState.id));

  return NextResponse.json({
    endpoint: "POST /api/admin/seed-wgfd-draw-odds",
    auth: "Authorization: Bearer <CRON_SECRET>",
    query: "Optional ?species=elk|mule_deer|pronghorn|bighorn_sheep|moose to process one PDF",
    pdfTargets: WGFD_PDFS,
    currentDb: {
      wyDrawOddsRows: counts?.drawOddsCount ?? 0,
      wyHuntUnitRows: huntUnitCount?.count ?? 0,
    },
  });
}
