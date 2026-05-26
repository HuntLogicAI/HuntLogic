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

      // AZGFD draw odds parser — format TBD until ?debug=1 sample inspected.
      // Placeholder: count nothing, no inserts. Will fill in after format
      // discovery.
      result.parsedRecords = 0;
      result.qualityScore = 0;
      void safeInt;
      void safeReal;
      void sourceId;
      void huntUnits;
      void drawOdds;
      void and;
      void speciesId;
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
