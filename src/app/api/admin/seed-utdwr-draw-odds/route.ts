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
import { eq, sql as drizzleSql } from "drizzle-orm";
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
  void sourceId; // reserved for future parser inserts

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

      // Placeholder parser: UT format is TBD until we see the actual PDF text.
      // For now, just report textLength + sample so we can build the regex
      // based on real format.
      result.parsedRecords = 0;
      result.qualityScore = 0;

      // Touch unused imports
      void huntUnits;
      void drawOdds;
      void speciesId(result, target.speciesSlug, speciesMap);
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

// Helper that resolves species, currently a no-op stub for the placeholder
// parser. Will be wired up to the parser once we see UT's PDF format.
function speciesId(
  _result: PerPdfResult,
  _speciesSlug: string | null,
  _speciesMap: Map<string, string>,
): string | null {
  return null;
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
