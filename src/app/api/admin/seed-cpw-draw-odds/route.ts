/**
 * POST /api/admin/seed-cpw-draw-odds
 *
 * Ingests Colorado Parks & Wildlife 2025 draw recap PDFs for elk, deer,
 * pronghorn, and moose. Populates draw_odds + auto-creates hunt_units.
 *
 * Same pattern as /api/admin/seed-wgfd-draw-odds. CPW publishes Post Draw
 * Recap Reports on cpw.widen.net — these contain pre-draw applicant counts
 * + post-draw success at each preference point level.
 *
 * Guarded by CRON_SECRET. Pass ?species=elk for focused debugging.
 * Pass ?debug=1 to also return the first 2500 chars of extracted text.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, sql as drizzleSql, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { states, species, huntUnits, drawOdds, dataSources } from "@/lib/db/schema";

// Polyfills for pdfjs-dist browser globals (unpdf needs them on Node)
const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.DOMMatrix === "undefined") g.DOMMatrix = class DOMMatrix {};
if (typeof g.Path2D === "undefined") g.Path2D = class Path2D {};
if (typeof g.ImageData === "undefined") g.ImageData = class ImageData {};

export const runtime = "nodejs";
export const maxDuration = 300;

interface CpwPdfTarget {
  url: string;
  speciesSlug: string;
  label: string;
}

// CPW Post Draw Recap Reports: the first 2 pages are statewide pre/post
// summary, then each subsequent page has a "# Drawn Hunt Code List" section
// with quota + Drawn Out At point thresholds per (hunt code × residency).
// That's the per-hunt-code data we need.
const CPW_PDFS: CpwPdfTarget[] = [
  { url: "https://cpw.widen.net/s/qh6nqttnnz/postdrawrecapreport_elk-25_05172025_0612", speciesSlug: "elk", label: "CO Post Draw Recap — Elk 2025" },
  { url: "https://cpw.widen.net/s/r9bjfnqlbc/postdrawrecapreport_deer-25_05102025_1540", speciesSlug: "mule_deer", label: "CO Post Draw Recap — Deer 2025" },
  { url: "https://cpw.widen.net/s/t6tnqjg55q/postdrawrecapreport_prong-25_05222025_0816", speciesSlug: "pronghorn", label: "CO Post Draw Recap — Pronghorn 2025" },
  { url: "https://cpw.widen.net/s/7qvlbxgdl7/postdrawrecapreport_moose-25_05072025_1354", speciesSlug: "moose", label: "CO Post Draw Recap — Moose 2025" },
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
    console.error("[admin:seed-cpw] FATAL:", err);
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
  const targets = speciesFilter ? CPW_PDFS.filter((p) => p.speciesSlug === speciesFilter) : CPW_PDFS;

  if (targets.length === 0) {
    return NextResponse.json({ error: `No PDF target matches species=${speciesFilter}` }, { status: 400 });
  }

  const startedAt = Date.now();

  const [coState] = await db.select({ id: states.id }).from(states).where(eq(states.code, "CO")).limit(1);
  if (!coState) return NextResponse.json({ error: "CO state row not found in DB" }, { status: 404 });

  // Upsert data source
  const sourceName = `CPW ${TARGET_YEAR} Post Draw Recap Reports`;
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
        authorityTier: 1,
        url: "https://cpw.state.co.us/hunting/big-game",
        refreshCadence: "annual",
        status: "active",
      })
      .returning({ id: dataSources.id });
    sourceId = inserted.id;
  }

  const { extractText, getDocumentProxy } = await import("unpdf");

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

      // CPW publishes via Widen CDN. The /s/ URL returns an HTML viewer wrapper,
      // not the PDF binary. Scrape the viewer page to find the actual /content/
      // download URL, then fetch that.
      const wrapperRes = await fetch(target.url, {
        headers: { "User-Agent": "Mozilla/5.0 HuntLogic/1.0" },
        redirect: "follow",
      });
      if (!wrapperRes.ok) {
        result.httpStatus = wrapperRes.status;
        result.errors.push(`HTTP ${wrapperRes.status} fetching wrapper page`);
        results.push(result);
        continue;
      }
      const wrapperHtml = await wrapperRes.text();
      const pdfMatch = wrapperHtml.match(/href="(\/content\/[^"]*\.pdf[^"]*)"/);
      const pdfPath = pdfMatch ? pdfMatch[1].replace(/&amp;/g, "&") : null;
      if (!pdfPath) {
        result.errors.push("Could not find PDF download path in Widen wrapper page");
        results.push(result);
        continue;
      }
      const pdfUrl = `https://cpw.widen.net${pdfPath}`;
      const fetchRes = await fetch(pdfUrl, {
        headers: { "User-Agent": "Mozilla/5.0 HuntLogic/1.0" },
        redirect: "follow",
      });
      result.httpStatus = fetchRes.status;
      if (!fetchRes.ok) {
        result.errors.push(`HTTP ${fetchRes.status} fetching actual PDF`);
        results.push(result);
        continue;
      }

      const buf = await fetchRes.arrayBuffer();
      result.bytes = buf.byteLength;

      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { text } = await extractText(pdf, { mergePages: true });
      const fullText = Array.isArray(text) ? text.join("\n") : (text as string);

      if (debug) {
        // Dump a 20KB window starting at offset 50KB so we see the per-hunt-code
        // section, not the statewide summary header. Adjust ?offset=N to scan
        // different parts of large PDFs.
        const dbgOffset = parseInt(url.searchParams.get("offset") || "50000", 10);
        result.textSample = fullText.slice(dbgOffset, dbgOffset + 20000);
        result.textLength = fullText.length;
      }

      // CPW per-hunt-code parser.
      //
      // The Post Draw Recap PDF contains one "# Drawn Hunt Code List" section
      // per hunt code. Each section follows the same template:
      //
      //   # Drawn Hunt Code List
      //   [QUOTA] [HUNT_CODE] A
      //   Remaining Balance N
      //   Total Quota Amount N
      //   ... pre-draw quota tables ...
      //   Drawn Out At [adultR] [adultNR] [youthR] [youthNR] [unrestr] [restr]
      //
      // Each "drawn out at" value is one of:
      //   "<N> Pref Points"   → N is the min_points_drawn for that bucket
      //   "None Drawn"        → no tags drawn from that bucket
      //   "No Apps"           → no applicants in that bucket
      //   "Choice N"          → drawn during choice N (no preference cutoff)
      //   "Leftover"          → went to leftover
      //
      // We create one draw_odds row per (hunt_code × adultR/adultNR) for the
      // primary case. Youth + Landowner rows are tracked in rawData but not
      // inserted as separate residency rows (we don't have those residency
      // values in the schema enum).
      //
      // Hunt code decoding (CPW):
      //   EE001E1R = Elk (E) + Either-sex (E) + GMU 001 + Season E1 + Rifle (R)
      //   trailing letter: R=rifle, A=archery, M=muzzleloader, P=plains
      // CPW uses different first letters per species: E=elk, D=deer,
      // A=antelope/pronghorn, M=moose, B=bear, O=bighorn sheep, G=mountain
      // goat. Broaden the first char class to any uppercase letter.
      const HUNT_CODE_RE = /\b([A-Z]{2}\d{3}[A-Z0-9]{1,3}[RAMPB])\b/;
      const QUOTA_RE = /Total Quota Amount\s+(\d+)/;
      const DRAWN_OUT_RE =
        /Drawn Out At\s+(.+?)\s+# Drawn at Final Level/s;
      const VALUE_RE =
        /(\d+)\s*Pref\s*Points|None\s+Drawn|No\s+Apps|Choice\s+\d+|Leftover/gi;

      function decodeWeapon(letter: string): string | null {
        switch (letter.toUpperCase()) {
          case "R": return "rifle";
          case "A": return "archery";
          case "M": return "muzzleloader";
          case "P": return null; // plains (not weapon-specific)
          case "B": return null; // any-weapon
          default: return null;
        }
      }

      // Split the document into per-hunt-code blocks
      const sections = fullText.split(/#\s*Drawn\s*Hunt\s*Code\s*List/);
      // The first split is the statewide preamble; subsequent splits are
      // per-hunt-code blocks.
      const huntCodeBlocks = sections.slice(1);

      interface ParsedDrawnOut {
        huntCode: string;
        unit: string;
        weaponLetter: string;
        seasonCode: string;
        quota: number;
        // 6 values matching: adultR, adultNR, youthR, youthNR, lpUnrestr, lpRestr
        drawnOutValues: Array<{ raw: string; pointsCutoff: number | null; status: string }>;
      }
      const parsedSections: ParsedDrawnOut[] = [];

      for (const block of huntCodeBlocks) {
        const codeMatch = block.match(HUNT_CODE_RE);
        if (!codeMatch) continue;
        const huntCode = codeMatch[1];
        // EE001E1R → unit=001, seasonCode=E1, weaponLetter=R
        const unit = huntCode.slice(2, 5);
        const seasonCode = huntCode.slice(5, huntCode.length - 1);
        const weaponLetter = huntCode.slice(-1);

        const quotaMatch = block.match(QUOTA_RE);
        const quota = quotaMatch ? parseInt(quotaMatch[1], 10) : 0;

        const drawnOutMatch = block.match(DRAWN_OUT_RE);
        const drawnOutValues: Array<{ raw: string; pointsCutoff: number | null; status: string }> = [];
        if (drawnOutMatch) {
          const inner = drawnOutMatch[1];
          const tokens = [...inner.matchAll(VALUE_RE)].slice(0, 6);
          for (const t of tokens) {
            const raw = t[0];
            let pointsCutoff: number | null = null;
            let status = "unknown";
            const ptsMatch = raw.match(/(\d+)\s*Pref\s*Points/i);
            if (ptsMatch) {
              pointsCutoff = parseInt(ptsMatch[1], 10);
              status = "drawn";
            } else if (/None\s+Drawn/i.test(raw)) {
              status = "none_drawn";
            } else if (/No\s+Apps/i.test(raw)) {
              status = "no_apps";
            } else if (/Choice/i.test(raw)) {
              status = "drawn_by_choice";
            } else if (/Leftover/i.test(raw)) {
              status = "leftover";
            }
            drawnOutValues.push({ raw, pointsCutoff, status });
          }
        }

        parsedSections.push({
          huntCode,
          unit,
          weaponLetter,
          seasonCode,
          quota,
          drawnOutValues,
        });
      }

      result.parsedRecords = parsedSections.length;
      // Quality score: % of sections with at least one numeric pref-points cutoff
      const withData = parsedSections.filter((s) => s.drawnOutValues.some((v) => v.pointsCutoff !== null)).length;
      result.qualityScore = parsedSections.length > 0
        ? Math.round((withData / parsedSections.length) * 100)
        : 0;

      // Insert one row per (hunt_code × residency). For now we capture
      // adult resident (column 0) and adult nonresident (column 1).
      for (const section of parsedSections) {
        const unitCode = section.unit;
        const weaponType = decodeWeapon(section.weaponLetter);

        let huntUnitId: string | null = null;
        const [existingUnit] = await db
          .select({ id: huntUnits.id })
          .from(huntUnits)
          .where(
            and(
              eq(huntUnits.stateId, coState.id),
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
                stateId: coState.id,
                speciesId,
                unitCode,
                unitName: `GMU ${unitCode} (CO ${target.speciesSlug})`,
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
                  eq(huntUnits.stateId, coState.id),
                  eq(huntUnits.speciesId, speciesId),
                  eq(huntUnits.unitCode, unitCode),
                ),
              )
              .limit(1);
            if (reread) huntUnitId = reread.id;
          }
        }

        const residencies: Array<{ idx: number; residentType: string }> = [
          { idx: 0, residentType: "resident" },
          { idx: 1, residentType: "nonresident" },
        ];

        for (const { idx, residentType } of residencies) {
          const val = section.drawnOutValues[idx];
          if (!val) continue;
          const minPointsDrawn = val.pointsCutoff;

          try {
            const insertResult = await db
              .insert(drawOdds)
              .values({
                stateId: coState.id,
                speciesId,
                huntUnitId,
                year: TARGET_YEAR,
                residentType,
                weaponType,
                choiceRank: 1, // CPW reports are 1st-choice
                totalApplicants: null,
                totalTags: section.quota || null,
                minPointsDrawn,
                drawRate: null, // not directly available; compute from raw later
                sourceId,
                rawData: {
                  parser: "cpw-postdraw-recap-inline",
                  huntCode: section.huntCode,
                  unit: section.unit,
                  seasonCode: section.seasonCode,
                  weaponLetter: section.weaponLetter,
                  quota: section.quota,
                  drawnOutStatus: val.status,
                  drawnOutRaw: val.raw,
                  allBuckets: section.drawnOutValues,
                },
              })
              .onConflictDoNothing();
            const rowsAffected = (insertResult as unknown as { rowCount?: number }).rowCount ?? 1;
            if (rowsAffected > 0) result.inserted++;
            else result.conflictsSkipped++;
          } catch (insertErr) {
            const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
            if (msg.includes("duplicate") || msg.includes("conflict")) result.conflictsSkipped++;
            else result.errors.push(`Insert err on ${section.huntCode}: ${msg}`);
          }
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
    .where(eq(drawOdds.stateId, coState.id));

  return NextResponse.json({
    ok: true,
    stateCode: "CO",
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
  const [coState] = await db.select({ id: states.id }).from(states).where(eq(states.code, "CO")).limit(1);
  if (!coState) return NextResponse.json({ error: "CO not seeded" }, { status: 404 });

  const [counts] = await db
    .select({ drawOddsCount: drizzleSql<number>`COUNT(*)::int` })
    .from(drawOdds)
    .where(eq(drawOdds.stateId, coState.id));

  return NextResponse.json({
    endpoint: "POST /api/admin/seed-cpw-draw-odds",
    auth: "Authorization: Bearer <CRON_SECRET>",
    query: "Optional ?species=elk|mule_deer|pronghorn|moose, ?debug=1",
    pdfTargets: CPW_PDFS,
    currentDb: { coDrawOddsRows: counts?.drawOddsCount ?? 0 },
  });
}
