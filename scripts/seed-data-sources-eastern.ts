/**
 * Seed: Eastern State Data Sources
 *
 * Eastern + southern + midwest state agencies for whitetail deer, turkey,
 * waterfowl, bear, and small game. Most of these states are OTC-heavy with
 * county-based "zones" rather than the unit-based draw system of the west;
 * the schema (`huntUnits` with `unitType` carried in `config`) accommodates
 * this without modification.
 *
 * Coverage:
 *   GA, PA, TX, FL, NC, NY, OH, MI, VA, TN, AL, MS, LA, AR, SC, IL, IN, WI, MN, MO
 *
 * Run: pnpm tsx scripts/seed-data-sources-eastern.ts
 */

import { db } from "../src/lib/db";
import { dataSources } from "../src/lib/db/schema";
import { eq } from "drizzle-orm";

interface EasternSourceSeed {
  name: string;
  sourceType: string;
  authorityTier: number;
  url: string;
  refreshCadence: "daily" | "weekly" | "monthly" | "annual" | "manual";
  scraperConfig: Record<string, unknown>;
  notes: string;
}

const SOURCES: EasternSourceSeed[] = [
  // ---------------------------------------------------------------------------
  // GEORGIA
  // ---------------------------------------------------------------------------
  {
    name: "Georgia DNR — Hunting Regulations + Harvest Reports",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://georgiawildlife.com",
    refreshCadence: "monthly",
    notes:
      "GA WRD publishes annual hunting guides + WMA-specific rules + deer harvest summaries (PDF).",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://georgiawildlife.com",
      state_code: "GA",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/regulations/hunting",
          parser: "regulation_text",
          params: {},
          doc_type: "regulation",
          schedule: "0 5 1 * *",
        },
        {
          path: "/research-publications",
          parser: "harvest_report",
          params: {},
          doc_type: "harvest_report",
          schedule: "0 5 1 9 *",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // PENNSYLVANIA
  // ---------------------------------------------------------------------------
  {
    name: "Pennsylvania Game Commission — Harvest Reports + Regulations",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://www.pgc.pa.gov",
    refreshCadence: "monthly",
    notes:
      "PGC publishes the Hunting & Trapping Digest (annual) and detailed deer/turkey/elk harvest summaries.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://www.pgc.pa.gov",
      state_code: "PA",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/HuntTrap/HuntingTrappingDigest/Pages/default.aspx",
          parser: "regulation_text",
          params: {},
          doc_type: "regulation",
          schedule: "0 5 15 6 *",
        },
        {
          path: "/Wildlife/WildlifeSpecies/Pages/HarvestData.aspx",
          parser: "harvest_report",
          params: {},
          doc_type: "harvest_report",
          schedule: "0 5 1 * *",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // TEXAS
  // ---------------------------------------------------------------------------
  {
    name: "Texas Parks & Wildlife — Outdoor Annual",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://tpwd.texas.gov",
    refreshCadence: "weekly",
    notes:
      "TPWD Outdoor Annual is the canonical regs source. Big-game harvest reports per county.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://tpwd.texas.gov",
      state_code: "TX",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/regulations/outdoor-annual/hunting",
          parser: "regulation_text",
          params: {},
          doc_type: "regulation",
          schedule: "0 5 * * 1",
        },
        {
          path: "/huntwild/hunt/research/big-game-harvest",
          parser: "harvest_report",
          params: {},
          doc_type: "harvest_report",
          schedule: "0 5 1 * *",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // FLORIDA
  // ---------------------------------------------------------------------------
  {
    name: "Florida FWC — Hunting & Regulations",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://myfwc.com",
    refreshCadence: "monthly",
    notes: "FWC's hunting regs cover WMAs, zones (A-D), and the unique dog-deer hunting tradition.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://myfwc.com",
      state_code: "FL",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/hunting/regulations/",
          parser: "regulation_text",
          params: {},
          doc_type: "regulation",
          schedule: "0 5 1 * *",
        },
        {
          path: "/hunting/deer/",
          parser: "regulation_text",
          params: {},
          doc_type: "regulation",
          schedule: "0 5 1 * *",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // NORTH CAROLINA
  // ---------------------------------------------------------------------------
  {
    name: "North Carolina Wildlife Resources Commission",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://www.ncwildlife.org",
    refreshCadence: "monthly",
    notes: "NCWRC posts the Inland Game Lands regs + Annual Big-Game Harvest Summary.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://www.ncwildlife.org",
      state_code: "NC",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/Hunting/Regulations",
          parser: "regulation_text",
          params: {},
          doc_type: "regulation",
          schedule: "0 5 1 * *",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // NEW YORK
  // ---------------------------------------------------------------------------
  {
    name: "New York DEC — Big Game Hunting",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://www.dec.ny.gov",
    refreshCadence: "monthly",
    notes:
      "NYDEC publishes Big Game Hunting regs + annual Deer/Bear/Turkey Harvest Summaries.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://www.dec.ny.gov",
      state_code: "NY",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/things-to-do/hunting/deer",
          parser: "regulation_text",
          params: {},
          doc_type: "regulation",
          schedule: "0 5 * * 1",
        },
        {
          path: "/things-to-do/hunting/big-game/harvest-report",
          parser: "harvest_report",
          params: {},
          doc_type: "harvest_report",
          schedule: "0 5 1 * *",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // OHIO
  // ---------------------------------------------------------------------------
  {
    name: "Ohio DNR Division of Wildlife — Hunting",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://ohiodnr.gov",
    refreshCadence: "monthly",
    notes: "Ohio's deer/turkey harvest dashboards are updated annually.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://ohiodnr.gov",
      state_code: "OH",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/discover-and-learn/safety-conservation/about-odnr/division-of-wildlife/hunting",
          parser: "regulation_text",
          params: {},
          doc_type: "regulation",
          schedule: "0 5 1 * *",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // MICHIGAN
  // ---------------------------------------------------------------------------
  {
    name: "Michigan DNR — Hunting Digest",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://www.michigan.gov/dnr",
    refreshCadence: "monthly",
    notes:
      "Michigan publishes the Hunting Digest annually + deer/elk/bear harvest summaries.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://www.michigan.gov",
      state_code: "MI",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/dnr/things-to-do/hunting",
          parser: "regulation_text",
          params: {},
          doc_type: "regulation",
          schedule: "0 5 1 * *",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // VIRGINIA
  // ---------------------------------------------------------------------------
  {
    name: "Virginia DWR — Hunting + Elk",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://dwr.virginia.gov",
    refreshCadence: "monthly",
    notes:
      "VA DWR — new elk lottery added; deer/turkey harvest reports + regs.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://dwr.virginia.gov",
      state_code: "VA",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/hunting/regulations/",
          parser: "regulation_text",
          params: {},
          doc_type: "regulation",
          schedule: "0 5 1 * *",
        },
        {
          path: "/wildlife/elk/",
          parser: "regulation_text",
          params: {},
          doc_type: "regulation",
          schedule: "0 5 1 * *",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // TENNESSEE
  // ---------------------------------------------------------------------------
  {
    name: "Tennessee Wildlife Resources Agency",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://www.tn.gov/twra",
    refreshCadence: "monthly",
    notes: "TWRA publishes annual hunting guide and harvest summaries.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://www.tn.gov",
      state_code: "TN",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/twra/hunting.html",
          parser: "regulation_text",
          params: {},
          doc_type: "regulation",
          schedule: "0 5 1 * *",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // ALABAMA, MISSISSIPPI, LOUISIANA, ARKANSAS, SOUTH CAROLINA
  // ---------------------------------------------------------------------------
  {
    name: "Alabama Dept of Conservation",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://www.outdooralabama.com",
    refreshCadence: "monthly",
    notes: "Alabama publishes annual hunting guide.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://www.outdooralabama.com",
      state_code: "AL",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/seasons-and-bag-limits",
          parser: "regulation_text",
          params: {},
          doc_type: "regulation",
          schedule: "0 5 1 * *",
        },
      ],
    },
  },
  {
    name: "Mississippi Dept of Wildlife, Fisheries & Parks",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://www.mdwfp.com",
    refreshCadence: "monthly",
    notes: "MDWFP hunting regs + deer/turkey harvest.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://www.mdwfp.com",
      state_code: "MS",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/wildlife-hunting/regulations/",
          parser: "regulation_text",
          params: {},
          doc_type: "regulation",
          schedule: "0 5 1 * *",
        },
      ],
    },
  },
  {
    name: "Louisiana Dept of Wildlife & Fisheries",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://www.wlf.louisiana.gov",
    refreshCadence: "monthly",
    notes: "LWF hunting regs + deer area boundaries.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://www.wlf.louisiana.gov",
      state_code: "LA",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/page/hunting-regulations",
          parser: "regulation_text",
          params: {},
          doc_type: "regulation",
          schedule: "0 5 1 * *",
        },
      ],
    },
  },
  {
    name: "Arkansas Game & Fish Commission",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://www.agfc.com",
    refreshCadence: "monthly",
    notes: "AGFC hunting guidebook + alligator/elk draw + deer harvest.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://www.agfc.com",
      state_code: "AR",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/hunting/regulations/",
          parser: "regulation_text",
          params: {},
          doc_type: "regulation",
          schedule: "0 5 1 * *",
        },
      ],
    },
  },
  {
    name: "South Carolina DNR",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://www.dnr.sc.gov",
    refreshCadence: "monthly",
    notes: "SCDNR — game zones, deer/turkey/duck regs.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://www.dnr.sc.gov",
      state_code: "SC",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/regs/hunting.html",
          parser: "regulation_text",
          params: {},
          doc_type: "regulation",
          schedule: "0 5 1 * *",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // MIDWEST: WI, MN, IL, IN, MO, IA
  // ---------------------------------------------------------------------------
  {
    name: "Wisconsin DNR — Hunting",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://dnr.wisconsin.gov",
    refreshCadence: "monthly",
    notes: "Wisconsin's deer/bear/turkey programs + Hunters Choice (DMU) system.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://dnr.wisconsin.gov",
      state_code: "WI",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/topic/Hunt/regulations.html",
          parser: "regulation_text",
          params: {},
          doc_type: "regulation",
          schedule: "0 5 1 * *",
        },
      ],
    },
  },
  {
    name: "Minnesota DNR",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://www.dnr.state.mn.us",
    refreshCadence: "monthly",
    notes: "Minnesota's deer permit area system + bear lottery + moose history.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://www.dnr.state.mn.us",
      state_code: "MN",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/regulations/hunting/",
          parser: "regulation_text",
          params: {},
          doc_type: "regulation",
          schedule: "0 5 1 * *",
        },
      ],
    },
  },
  {
    name: "Illinois DNR",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://dnr.illinois.gov",
    refreshCadence: "monthly",
    notes: "Illinois — shotgun-only for deer statewide; archery + muzzleloader lottery.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://dnr.illinois.gov",
      state_code: "IL",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/hunting.html",
          parser: "regulation_text",
          params: {},
          doc_type: "regulation",
          schedule: "0 5 1 * *",
        },
      ],
    },
  },
  {
    name: "Indiana DNR — Hunting",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://www.in.gov/dnr",
    refreshCadence: "monthly",
    notes: "Indiana — shotgun + rifle (for HSCC since 2007) + crossbow.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://www.in.gov",
      state_code: "IN",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/dnr/fish-and-wildlife/hunting-and-trapping/",
          parser: "regulation_text",
          params: {},
          doc_type: "regulation",
          schedule: "0 5 1 * *",
        },
      ],
    },
  },
  {
    name: "Missouri Department of Conservation",
    sourceType: "state_agency",
    authorityTier: 1,
    url: "https://mdc.mo.gov",
    refreshCadence: "monthly",
    notes: "MDC — turkey + deer + elk (small herd). Many free apprentice-friendly licenses.",
    scraperConfig: {
      adapter: "web_scraper",
      base_url: "https://mdc.mo.gov",
      state_code: "MO",
      rate_limit: { requests_per_minute: 10 },
      retry: { max_attempts: 3, backoff_ms: 10000 },
      timeout_ms: 60000,
      endpoints: [
        {
          path: "/hunting-trapping",
          parser: "regulation_text",
          params: {},
          doc_type: "regulation",
          schedule: "0 5 1 * *",
        },
      ],
    },
  },
];

async function upsert(source: EasternSourceSeed): Promise<void> {
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
  console.log("Seeding eastern/southern/midwest state data sources...");
  console.log("");
  for (const source of SOURCES) {
    try {
      await upsert(source);
    } catch (error) {
      console.error(`  ✗ Failed: ${source.name}: ${error}`);
    }
  }
  console.log("");
  console.log(`Done. ${SOURCES.length} eastern-region sources seeded.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
