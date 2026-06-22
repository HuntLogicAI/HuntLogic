/**
 * Seed: Western State Data Sources
 *
 * Populates `data_sources` for the 11 western states with scraper configs
 * pointing at the canonical agency endpoints. The existing scheduler picks
 * these up and creates BullMQ repeatable jobs based on refreshCadence.
 *
 * Idempotent: uses upsert keyed on (name) so re-runs replace stale config
 * rather than duplicating rows.
 *
 * Each entry's scraper_config matches the existing src/services/ingestion
 * types: { adapter, base_url, endpoints[], rate_limit, retry }.
 *
 * Run: pnpm tsx scripts/seed-data-sources-western.ts
 */

import { db } from "../src/lib/db";
import { dataSources } from "../src/lib/db/schema";
import { eq } from "drizzle-orm";

interface WesternSourceSeed {
  name: string;
  sourceType: string;
  authorityTier: number;
  url: string;
  refreshCadence: "daily" | "weekly" | "monthly" | "annual" | "manual";
  scraperConfig: Record<string, unknown>;
  notes: string;
}

const SOURCES: WesternSourceSeed[] = [
  // ---------------------------------------------------------------------------
  // Idaho — Hunt Planner exposes JSON/CSV/Excel/XML. By far the easiest western
  // state to ingest. 28 years of history (1998–2026) via the same API surface.
  // ---------------------------------------------------------------------------
  {
    name: "Idaho Fish & Game — Hunt Planner (JSON)",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://idfg.idaho.gov/ifwis/huntplanner/odds/",
    refreshCadence: "weekly",
    notes:
      "ID Hunt Planner has JSON/CSV/Excel/XML exports per species/year/unit. Pure-random draw (no point system).",
    scraperConfig: {
      adapter: "api_json",
      base_url: "https://idfg.idaho.gov/ifwis/huntplanner/odds",
      state_code: "ID",
      rate_limit: { requests_per_minute: 20 },
      retry: { max_attempts: 3, backoff_ms: 5000 },
      timeout_ms: 30000,
      endpoints: [
        {
          path: "/elk/{{current_year}}.json",
          parser: "draw_odds_csv",
          params: {},
          doc_type: "draw_report",
          schedule: "0 5 * * 1", // weekly Monday 5am
        },
        {
          path: "/deer/{{current_year}}.json",
          parser: "draw_odds_csv",
          params: {},
          doc_type: "draw_report",
          schedule: "0 5 * * 1",
        },
        {
          path: "/antelope/{{current_year}}.json",
          parser: "draw_odds_csv",
          params: {},
          doc_type: "draw_report",
          schedule: "0 5 * * 1",
        },
        {
          path: "/moose/{{current_year}}.json",
          parser: "draw_odds_csv",
          params: {},
          doc_type: "draw_report",
          schedule: "0 5 * * 1",
        },
        {
          path: "/sheep/{{current_year}}.json",
          parser: "draw_odds_csv",
          params: {},
          doc_type: "draw_report",
          schedule: "0 5 * * 1",
        },
        {
          path: "/goat/{{current_year}}.json",
          parser: "draw_odds_csv",
          params: {},
          doc_type: "draw_report",
          schedule: "0 5 * * 1",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Nevada — NDOW publishes annual hunt statistics as XLSX. New file per year,
  // posted ~6 weeks after the spring draw. Bonus² system.
  // ---------------------------------------------------------------------------
  {
    name: "Nevada Department of Wildlife — Hunt Statistics (XLSX)",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://ndow.org/blog/hunt-statistics/",
    refreshCadence: "monthly",
    notes:
      "NV NDOW posts annual XLSX hunt-stats roll-ups. Bonus² point math.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://ndow.org",
      state_code: "NV",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/blog/hunt-statistics/",
          parser: "draw_odds_table",
          params: {},
          doc_type: "draw_report",
          schedule: "0 6 1,15 * *", // 1st + 15th of each month
          selectors: {
            article_links: "a[href$='.xlsx'], a[href*='hunt-stat']",
          },
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Colorado — CPW collections portal holds the full PDF history (1969+).
  // Pure-preference system. 22 years of digitized data.
  // ---------------------------------------------------------------------------
  {
    name: "Colorado Parks & Wildlife — Hunting Statistics (PDF)",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://cpw.cvlcollections.org",
    refreshCadence: "weekly",
    notes:
      "CPW collections portal: historical PDFs for draw odds + harvest stats. Pure-preference points.",
    scraperConfig: {
      adapter: "pdf_download",
      base_url: "https://cpw.cvlcollections.org",
      state_code: "CO",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 120000,
      endpoints: [
        {
          path: "/search?collection=hunt-statistics&year={{current_year}}",
          parser: "draw_odds_table",
          params: {},
          doc_type: "draw_report",
          schedule: "0 5 * * 1",
        },
        {
          path: "/search?collection=harvest-reports&year={{current_year}}",
          parser: "harvest_report",
          params: {},
          doc_type: "harvest_report",
          schedule: "0 5 * * 1",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Wyoming — WGFD PDFs at predictable URLs by species + year.
  // Pure-preference, separate resident/nonresident pools.
  // ---------------------------------------------------------------------------
  {
    name: "Wyoming Game & Fish — Draw Results (PDF)",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://wgfd.wyo.gov",
    refreshCadence: "weekly",
    notes: "WY WGFD PDF draw reports by species/year. Pure preference points.",
    scraperConfig: {
      adapter: "pdf_download",
      base_url: "https://wgfd.wyo.gov",
      state_code: "WY",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/get-involved/applications-and-draws/elk-draw-results",
          parser: "draw_odds_table",
          params: {},
          doc_type: "draw_report",
          schedule: "0 5 * * 1",
        },
        {
          path: "/get-involved/applications-and-draws/deer-draw-results",
          parser: "draw_odds_table",
          params: {},
          doc_type: "draw_report",
          schedule: "0 5 * * 1",
        },
        {
          path: "/get-involved/applications-and-draws/antelope-draw-results",
          parser: "draw_odds_table",
          params: {},
          doc_type: "draw_report",
          schedule: "0 5 * * 1",
        },
        {
          path: "/get-involved/applications-and-draws/moose-draw-results",
          parser: "draw_odds_table",
          params: {},
          doc_type: "draw_report",
          schedule: "0 5 * * 1",
        },
        {
          path: "/get-involved/applications-and-draws/bighorn-sheep-draw-results",
          parser: "draw_odds_table",
          params: {},
          doc_type: "draw_report",
          schedule: "0 5 * * 1",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Arizona — AZGFD draw portal + harvest reports.
  // Bonus (loyalty capped at +5).
  // ---------------------------------------------------------------------------
  {
    name: "Arizona Game & Fish — Draw Portal",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://draw.azgfd.com",
    refreshCadence: "weekly",
    notes: "AZ draw portal. Bonus point system with +5 loyalty cap.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://draw.azgfd.com",
      state_code: "AZ",
      rate_limit: { requests_per_minute: 6 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/hunt-permit-tag-draw",
          parser: "draw_odds_table",
          params: {},
          doc_type: "draw_report",
          schedule: "0 5 * * 1",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Utah — UDWR draw recap (PDF legacy + JS portal). 50/50 weighted preference.
  // ---------------------------------------------------------------------------
  {
    name: "Utah Division of Wildlife Resources — Draw Recap",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://wildlife.utah.gov",
    refreshCadence: "weekly",
    notes:
      "UT UDWR. 50/50 weighted preference (half tags random, half by points).",
    scraperConfig: {
      adapter: "pdf_download",
      base_url: "https://wildlife.utah.gov",
      state_code: "UT",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/hunting/main-hunting-page/big-game-application/big-game-draw-recap.html",
          parser: "draw_odds_table",
          params: {},
          doc_type: "draw_report",
          schedule: "0 5 * * 1",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Oregon — ODFW exposes XLSX draw results 2017+. Pure preference.
  // ---------------------------------------------------------------------------
  {
    name: "Oregon Dept of Fish & Wildlife — Controlled Hunt Statistics",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://myodfw.com",
    refreshCadence: "weekly",
    notes:
      "OR ODFW. XLSX exports for controlled hunts. Pure preference. 2026 WMU restructure may invalidate older keys.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://myodfw.com",
      state_code: "OR",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/articles/oregon-controlled-hunt-statistics",
          parser: "draw_odds_table",
          params: {},
          doc_type: "draw_report",
          schedule: "0 5 * * 1",
          selectors: {
            xlsx_links: "a[href$='.xlsx']",
          },
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Montana — FWP draw stats portal is JS-rendered (need headless browser).
  // Tag for adapter to switch to headless once that's wired up.
  // ---------------------------------------------------------------------------
  {
    name: "Montana Fish, Wildlife & Parks — Drawing Statistics",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://myfwp.mt.gov/fwpPub/drawingStatistics",
    refreshCadence: "monthly",
    notes:
      "MT FWP. JS-rendered SPA; requires headless browser to extract draw stats. Currently scraper logs and skips.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://myfwp.mt.gov",
      state_code: "MT",
      rate_limit: { requests_per_minute: 6 },
      retry: { max_attempts: 2, backoff_ms: 10000 },
      timeout_ms: 90000,
      endpoints: [
        {
          path: "/fwpPub/drawingStatistics",
          parser: "draw_odds_table",
          params: {},
          doc_type: "draw_report",
          schedule: "0 5 1 * *",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // New Mexico — NMDGF posts XLSX draw results. Pure-random draw, no points.
  // ---------------------------------------------------------------------------
  {
    name: "New Mexico Game & Fish — Draw Results (XLSX)",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://wildlife.dgf.nm.gov",
    refreshCadence: "weekly",
    notes:
      "NM NMDGF XLSX. Pure-random draw — point_system_type='random'.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://wildlife.dgf.nm.gov",
      state_code: "NM",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/hunting/draw-results/",
          parser: "draw_odds_table",
          params: {},
          doc_type: "draw_report",
          schedule: "0 5 * * 1",
          selectors: {
            xlsx_links: "a[href$='.xlsx'], a[href*='draw-result']",
          },
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Washington — WDFW Power BI dashboards stale since 2021. Flagging for ops
  // attention; configure once a replacement source is identified.
  // ---------------------------------------------------------------------------
  {
    name: "Washington Dept of Fish & Wildlife — Special Permits",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://wdfw.wa.gov",
    refreshCadence: "monthly",
    notes:
      "WA WDFW Power BI dashboards have been stale since 2021. Source needs replacement; press-release scrape as fallback.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://wdfw.wa.gov",
      state_code: "WA",
      rate_limit: { requests_per_minute: 6 },
      retry: { max_attempts: 2, backoff_ms: 15000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/hunting/permits/special-hunt-permits",
          parser: "regulation_text",
          params: {},
          doc_type: "draw_report",
          schedule: "0 5 1 * *",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Alaska — ADFG draw supplements as PDF. Largely subsistence/draw.
  // ---------------------------------------------------------------------------
  {
    name: "Alaska Dept of Fish & Game — Draw Supplement (PDF)",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://www.adfg.alaska.gov",
    refreshCadence: "annual",
    notes:
      "AK ADFG draw supplements. Annual PDF. Subsistence/lottery rules differ heavily from western big-game norms.",
    scraperConfig: {
      adapter: "pdf_download",
      base_url: "https://www.adfg.alaska.gov",
      state_code: "AK",
      rate_limit: { requests_per_minute: 6 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 120000,
      endpoints: [
        {
          path: "/static/hunting/regulations/pdfs/draw_supplement.pdf",
          parser: "draw_odds_table",
          params: {},
          doc_type: "draw_report",
          schedule: "0 5 1 4 *", // Apr 1 annually
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // California — CDFW. Largely OTC + LE draw. Schema slot held; ingestion
  // is stub for now (existing repo had no CA seed).
  // ---------------------------------------------------------------------------
  {
    name: "California Dept of Fish & Wildlife — Big Game Draw",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://wildlife.ca.gov",
    refreshCadence: "monthly",
    notes:
      "CA CDFW. Mix of OTC and limited-entry; ingestion is stub (needs PDF locating).",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://wildlife.ca.gov",
      state_code: "CA",
      rate_limit: { requests_per_minute: 6 },
      retry: { max_attempts: 2, backoff_ms: 15000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/Hunting/Big-Game/Drawing",
          parser: "regulation_text",
          params: {},
          doc_type: "draw_report",
          schedule: "0 5 1 * *",
        },
      ],
    },
  },
];

async function upsertSource(source: WesternSourceSeed): Promise<void> {
  const existing = await db
    .select()
    .from(dataSources)
    .where(eq(dataSources.name, source.name))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(dataSources)
      .set({
        sourceType: source.sourceType,
        authorityTier: source.authorityTier,
        url: source.url,
        scraperConfig: source.scraperConfig,
        refreshCadence: source.refreshCadence,
        status: "active",
        enabled: true,
        updatedAt: new Date(),
      })
      .where(eq(dataSources.id, existing[0]!.id));
    console.log(`  ✓ Updated: ${source.name}`);
    return;
  }

  await db.insert(dataSources).values({
    name: source.name,
    sourceType: source.sourceType,
    authorityTier: source.authorityTier,
    url: source.url,
    scraperConfig: source.scraperConfig,
    refreshCadence: source.refreshCadence,
    status: "active",
    enabled: true,
  });
  console.log(`  + Created: ${source.name}`);
}

async function main(): Promise<void> {
  console.log("Seeding western state data sources...");
  console.log("");

  for (const source of SOURCES) {
    try {
      await upsertSource(source);
    } catch (error) {
      console.error(`  ✗ Failed: ${source.name}: ${error}`);
    }
  }

  console.log("");
  console.log(`Done. ${SOURCES.length} western state sources seeded.`);
  console.log("Run the scheduler (`pnpm run ingestion:start`) to activate them.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
