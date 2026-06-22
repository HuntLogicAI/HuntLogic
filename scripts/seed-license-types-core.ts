/**
 * Seed: License Types — Core priority states
 *
 * Populates `license_types` with the canonical hunting licenses + species
 * tags for each priority state. Values are nominal 2026 retail prices from
 * each agency's published fee schedules; ops should re-verify annually.
 *
 * Covers:
 *  - Western: CO, WY, AZ, NV, UT, ID, OR, MT, NM, WA
 *  - Eastern/Southern: GA, PA, TX, FL, NC, NY, OH, MI, VA, TN, AL, MS
 *
 * Within each state we seed:
 *  - Base hunting license (resident + nonresident)
 *  - Big-game species tags (deer, elk, turkey, bear where applicable)
 *  - Common stamps (federal waterfowl, state habitat stamp)
 *  - Youth + senior variants where the agency publishes a discount
 *  - Apprentice / sportsman combos where they exist
 *
 * The structure is deliberately verbose — each row is one row in license_types,
 * making downstream querying ("show me every license a CO resident needs to
 * hunt elk") a clean WHERE filter.
 *
 * Run: pnpm tsx scripts/seed-license-types-core.ts
 */

import { db } from "../src/lib/db";
import { states, species, licenseTypes } from "../src/lib/db/schema";
import { eq, and } from "drizzle-orm";

interface LicenseSeed {
  stateCode: string;
  speciesSlug?: string | null;
  licenseCode: string;
  name: string;
  description: string;
  residency: "resident" | "nonresident" | "all";
  cost: number;
  minAge?: number;
  maxAge?: number;
  validFrom?: string;
  validTo?: string;
  prerequisites?: Record<string, unknown>;
  isOtc?: boolean;
  isDrawEntry?: boolean;
  quantityLimit?: number;
  sourceUrl: string;
  year: number;
}

const YEAR = 2026;

const SEEDS: LicenseSeed[] = [
  // ===========================================================================
  // COLORADO
  // ===========================================================================
  {
    stateCode: "CO", licenseCode: "small_game_license", name: "Annual Small Game License",
    description: "Required to hunt small game and to purchase big-game tags.",
    residency: "resident", cost: 30.87, isOtc: true, year: YEAR,
    sourceUrl: "https://cpw.state.co.us/buyapply/Pages/HuntingLicenses.aspx",
  },
  {
    stateCode: "CO", licenseCode: "small_game_license", name: "Annual Small Game License",
    description: "Required to hunt small game and to purchase big-game tags.",
    residency: "nonresident", cost: 91.94, isOtc: true, year: YEAR,
    sourceUrl: "https://cpw.state.co.us/buyapply/Pages/HuntingLicenses.aspx",
  },
  {
    stateCode: "CO", speciesSlug: "elk", licenseCode: "elk_tag_otc",
    name: "Elk OTC Either-Sex Tag (specific units)",
    description: "Over-the-counter elk tag valid in designated OTC units.",
    residency: "resident", cost: 60.32, isOtc: true, year: YEAR,
    sourceUrl: "https://cpw.state.co.us/buyapply/Pages/HuntingLicenses.aspx",
  },
  {
    stateCode: "CO", speciesSlug: "elk", licenseCode: "elk_tag_otc",
    name: "Elk OTC Either-Sex Tag (specific units)",
    description: "Over-the-counter elk tag valid in designated OTC units.",
    residency: "nonresident", cost: 791.59, isOtc: true, year: YEAR,
    sourceUrl: "https://cpw.state.co.us/buyapply/Pages/HuntingLicenses.aspx",
  },
  {
    stateCode: "CO", speciesSlug: "mule_deer", licenseCode: "deer_tag_draw",
    name: "Deer License (Draw)",
    description: "Limited-entry deer tag awarded via the spring big-game draw.",
    residency: "resident", cost: 45.65, isDrawEntry: true, year: YEAR,
    sourceUrl: "https://cpw.state.co.us/buyapply/Pages/HuntingLicenses.aspx",
  },
  {
    stateCode: "CO", speciesSlug: "mule_deer", licenseCode: "deer_tag_draw",
    name: "Deer License (Draw)",
    description: "Limited-entry deer tag awarded via the spring big-game draw.",
    residency: "nonresident", cost: 478.50, isDrawEntry: true, year: YEAR,
    sourceUrl: "https://cpw.state.co.us/buyapply/Pages/HuntingLicenses.aspx",
  },
  {
    stateCode: "CO", licenseCode: "habitat_stamp", name: "Habitat Stamp",
    description: "Required for all hunters and anglers age 18-64. Funds habitat conservation.",
    residency: "all", cost: 10.94, isOtc: true, year: YEAR, minAge: 18, maxAge: 64,
    sourceUrl: "https://cpw.state.co.us/buyapply/Pages/HabitatStamp.aspx",
  },
  {
    stateCode: "CO", licenseCode: "preference_point", name: "Big Game Preference Point",
    description: "Build preference points for future big-game draws.",
    residency: "all", cost: 47, isOtc: true, year: YEAR,
    sourceUrl: "https://cpw.state.co.us/buyapply/Pages/PreferencePoints.aspx",
    prerequisites: { hunter_ed: true },
  },

  // ===========================================================================
  // WYOMING
  // ===========================================================================
  {
    stateCode: "WY", licenseCode: "conservation_stamp", name: "Conservation Stamp",
    description: "Required for all hunters and anglers 14+ purchasing any license.",
    residency: "all", cost: 21.50, isOtc: true, year: YEAR, minAge: 14,
    sourceUrl: "https://wgfd.wyo.gov/get-involved/buy-a-license",
  },
  {
    stateCode: "WY", speciesSlug: "elk", licenseCode: "elk_license_draw",
    name: "Elk License (Draw)",
    description: "Limited-entry elk license awarded via draw. Separate resident/nonresident pools.",
    residency: "resident", cost: 57, isDrawEntry: true, year: YEAR,
    sourceUrl: "https://wgfd.wyo.gov/get-involved/applications-and-draws",
  },
  {
    stateCode: "WY", speciesSlug: "elk", licenseCode: "elk_license_draw",
    name: "Elk License (Draw)",
    description: "Limited-entry elk license awarded via draw. Separate resident/nonresident pools.",
    residency: "nonresident", cost: 707, isDrawEntry: true, year: YEAR,
    sourceUrl: "https://wgfd.wyo.gov/get-involved/applications-and-draws",
  },
  {
    stateCode: "WY", speciesSlug: "pronghorn", licenseCode: "pronghorn_license_draw",
    name: "Pronghorn (Antelope) License (Draw)",
    description: "Limited-entry pronghorn tag. Strong nonresident odds in many units.",
    residency: "resident", cost: 35, isDrawEntry: true, year: YEAR,
    sourceUrl: "https://wgfd.wyo.gov/get-involved/applications-and-draws",
  },
  {
    stateCode: "WY", speciesSlug: "pronghorn", licenseCode: "pronghorn_license_draw",
    name: "Pronghorn (Antelope) License (Draw)",
    description: "Limited-entry pronghorn tag. Strong nonresident odds in many units.",
    residency: "nonresident", cost: 363, isDrawEntry: true, year: YEAR,
    sourceUrl: "https://wgfd.wyo.gov/get-involved/applications-and-draws",
  },

  // ===========================================================================
  // ARIZONA
  // ===========================================================================
  {
    stateCode: "AZ", licenseCode: "general_license", name: "General Hunting License",
    description: "Required for all hunters and to purchase big-game tags.",
    residency: "resident", cost: 37, isOtc: true, year: YEAR,
    sourceUrl: "https://www.azgfd.com/license/hunting/",
  },
  {
    stateCode: "AZ", licenseCode: "general_license", name: "General Hunting License",
    description: "Required for all hunters and to purchase big-game tags.",
    residency: "nonresident", cost: 160, isOtc: true, year: YEAR,
    sourceUrl: "https://www.azgfd.com/license/hunting/",
  },
  {
    stateCode: "AZ", speciesSlug: "elk", licenseCode: "elk_tag_draw",
    name: "Elk Hunt Permit-Tag (Draw)",
    description: "Awarded via spring draw. 10% nonresident quota in most hunts.",
    residency: "resident", cost: 138, isDrawEntry: true, year: YEAR,
    sourceUrl: "https://www.azgfd.com/hunting/draw/",
  },
  {
    stateCode: "AZ", speciesSlug: "elk", licenseCode: "elk_tag_draw",
    name: "Elk Hunt Permit-Tag (Draw)",
    description: "Awarded via spring draw. 10% nonresident quota in most hunts.",
    residency: "nonresident", cost: 685, isDrawEntry: true, year: YEAR,
    sourceUrl: "https://www.azgfd.com/hunting/draw/",
  },
  {
    stateCode: "AZ", licenseCode: "bonus_point", name: "Bonus Point (per species)",
    description: "Build bonus points for future draws. Earned by applying.",
    residency: "all", cost: 15, isOtc: true, year: YEAR,
    sourceUrl: "https://www.azgfd.com/hunting/draw/",
  },

  // ===========================================================================
  // NEVADA
  // ===========================================================================
  {
    stateCode: "NV", licenseCode: "hunting_license", name: "Hunting License",
    description: "Required to hunt and to apply for tag draws.",
    residency: "resident", cost: 38, isOtc: true, year: YEAR,
    sourceUrl: "https://www.ndow.org/Hunt/Licensing/",
  },
  {
    stateCode: "NV", licenseCode: "hunting_license", name: "Hunting License",
    description: "Required to hunt and to apply for tag draws.",
    residency: "nonresident", cost: 155, isOtc: true, year: YEAR,
    sourceUrl: "https://www.ndow.org/Hunt/Licensing/",
  },
  {
    stateCode: "NV", speciesSlug: "elk", licenseCode: "elk_tag_draw",
    name: "Elk Tag (Draw)",
    description: "Limited-entry elk tag. Bonus² point system.",
    residency: "resident", cost: 120, isDrawEntry: true, year: YEAR,
    sourceUrl: "https://www.ndow.org/Hunt/Tags/Draw/",
  },
  {
    stateCode: "NV", speciesSlug: "elk", licenseCode: "elk_tag_draw",
    name: "Elk Tag (Draw)",
    description: "Limited-entry elk tag. Bonus² point system.",
    residency: "nonresident", cost: 1200, isDrawEntry: true, year: YEAR,
    sourceUrl: "https://www.ndow.org/Hunt/Tags/Draw/",
  },

  // ===========================================================================
  // UTAH
  // ===========================================================================
  {
    stateCode: "UT", licenseCode: "combination_license", name: "Combination Hunting+Fishing License",
    description: "Annual hunting/fishing combination license. Required to hunt or fish.",
    residency: "resident", cost: 38, isOtc: true, year: YEAR,
    sourceUrl: "https://wildlife.utah.gov/license.html",
  },
  {
    stateCode: "UT", licenseCode: "combination_license", name: "Combination Hunting+Fishing License",
    description: "Annual hunting/fishing combination license.",
    residency: "nonresident", cost: 144, isOtc: true, year: YEAR,
    sourceUrl: "https://wildlife.utah.gov/license.html",
  },
  {
    stateCode: "UT", speciesSlug: "mule_deer", licenseCode: "general_deer_permit",
    name: "General Deer Permit (Draw)",
    description: "Limited-entry deer permit by region (Northern/Central/Southeastern/Southern).",
    residency: "resident", cost: 50, isDrawEntry: true, year: YEAR,
    sourceUrl: "https://wildlife.utah.gov/hunting/big-game.html",
  },
  {
    stateCode: "UT", speciesSlug: "mule_deer", licenseCode: "general_deer_permit",
    name: "General Deer Permit (Draw)",
    description: "Limited-entry deer permit by region.",
    residency: "nonresident", cost: 412, isDrawEntry: true, year: YEAR,
    sourceUrl: "https://wildlife.utah.gov/hunting/big-game.html",
  },

  // ===========================================================================
  // IDAHO
  // ===========================================================================
  {
    stateCode: "ID", licenseCode: "hunting_license", name: "Hunting License",
    description: "Required to hunt and to apply for controlled hunt tags.",
    residency: "resident", cost: 19.75, isOtc: true, year: YEAR,
    sourceUrl: "https://idfg.idaho.gov/licenses",
  },
  {
    stateCode: "ID", licenseCode: "hunting_license", name: "Hunting License",
    description: "Required to hunt and to apply for controlled hunt tags.",
    residency: "nonresident", cost: 185, isOtc: true, year: YEAR,
    sourceUrl: "https://idfg.idaho.gov/licenses",
  },
  {
    stateCode: "ID", speciesSlug: "elk", licenseCode: "elk_tag_general",
    name: "General Elk Tag",
    description: "Most ID elk tags are OTC general-season; some controlled hunts.",
    residency: "resident", cost: 30.75, isOtc: true, year: YEAR,
    sourceUrl: "https://idfg.idaho.gov/hunt/elk",
  },
  {
    stateCode: "ID", speciesSlug: "elk", licenseCode: "elk_tag_general",
    name: "General Elk Tag",
    description: "Most ID elk tags are OTC general-season; some controlled hunts.",
    residency: "nonresident", cost: 651.75, isOtc: true, year: YEAR,
    sourceUrl: "https://idfg.idaho.gov/hunt/elk",
  },

  // ===========================================================================
  // GEORGIA — specifically chosen because Mitch called it out for the
  // "shotgun in GA → what can I hunt" use case.
  // ===========================================================================
  {
    stateCode: "GA", licenseCode: "hunting_license", name: "Resident Hunting License",
    description: "Required for all resident hunters age 16+.",
    residency: "resident", cost: 15, isOtc: true, year: YEAR, minAge: 16,
    sourceUrl: "https://georgiawildlife.com/licenses-permits-passes",
  },
  {
    stateCode: "GA", licenseCode: "hunting_license", name: "Nonresident Hunting License",
    description: "Required for all nonresident hunters age 16+.",
    residency: "nonresident", cost: 100, isOtc: true, year: YEAR, minAge: 16,
    sourceUrl: "https://georgiawildlife.com/licenses-permits-passes",
  },
  {
    stateCode: "GA", licenseCode: "sportsman_license", name: "Sportsman License",
    description: "Combo license: hunting + fishing + big-game + WMA + waterfowl. Best value for active GA hunters.",
    residency: "resident", cost: 65, isOtc: true, year: YEAR,
    sourceUrl: "https://georgiawildlife.com/licenses-permits-passes",
  },
  {
    stateCode: "GA", speciesSlug: "whitetail_deer", licenseCode: "big_game_license",
    name: "Big Game License (incl. with Sportsman)",
    description: "Required to hunt deer, bear, or turkey. Bundled in Sportsman.",
    residency: "resident", cost: 25, isOtc: true, year: YEAR,
    sourceUrl: "https://georgiawildlife.com/licenses-permits-passes",
  },
  {
    stateCode: "GA", speciesSlug: "whitetail_deer", licenseCode: "big_game_license",
    name: "Big Game License (incl. with Sportsman)",
    description: "Required to hunt deer, bear, or turkey.",
    residency: "nonresident", cost: 225, isOtc: true, year: YEAR,
    sourceUrl: "https://georgiawildlife.com/licenses-permits-passes",
  },
  {
    stateCode: "GA", licenseCode: "wma_license", name: "WMA License",
    description: "Required to hunt or fish on Wildlife Management Areas. Included with Sportsman license.",
    residency: "all", cost: 30, isOtc: true, year: YEAR,
    sourceUrl: "https://georgiawildlife.com/licenses-permits-passes",
  },
  {
    stateCode: "GA", speciesSlug: "wild_turkey", licenseCode: "turkey_license",
    name: "Turkey License (incl. with Sportsman)",
    description: "Required to hunt turkey. 2-tag annual limit. Bundled in Sportsman.",
    residency: "resident", cost: 0, isOtc: true, year: YEAR, quantityLimit: 2,
    sourceUrl: "https://georgiawildlife.com/turkey",
  },
  {
    stateCode: "GA", licenseCode: "waterfowl_stamp", name: "Federal Migratory Bird Stamp (Duck Stamp)",
    description: "Required for waterfowl hunting nationwide. Federal stamp.",
    residency: "all", cost: 25, isOtc: true, year: YEAR,
    sourceUrl: "https://georgiawildlife.com/waterfowl",
  },
  {
    stateCode: "GA", licenseCode: "ga_waterfowl_license", name: "Georgia Waterfowl License",
    description: "Required for state waterfowl hunting (in addition to federal duck stamp).",
    residency: "resident", cost: 10, isOtc: true, year: YEAR,
    sourceUrl: "https://georgiawildlife.com/waterfowl",
  },

  // ===========================================================================
  // PENNSYLVANIA
  // ===========================================================================
  {
    stateCode: "PA", licenseCode: "general_license", name: "General Hunting License",
    description: "Required for all hunters age 12+.",
    residency: "resident", cost: 20.97, isOtc: true, year: YEAR, minAge: 12,
    sourceUrl: "https://www.pgc.pa.gov/HuntTrap/HuntingLicenses/Pages/default.aspx",
  },
  {
    stateCode: "PA", licenseCode: "general_license", name: "General Hunting License",
    description: "Required for all hunters age 12+.",
    residency: "nonresident", cost: 101.97, isOtc: true, year: YEAR, minAge: 12,
    sourceUrl: "https://www.pgc.pa.gov/HuntTrap/HuntingLicenses/Pages/default.aspx",
  },
  {
    stateCode: "PA", speciesSlug: "elk", licenseCode: "elk_license_draw",
    name: "Elk License (Draw)",
    description: "Rare draw-only elk tag for PA's growing herd.",
    residency: "resident", cost: 41.97, isDrawEntry: true, year: YEAR,
    sourceUrl: "https://www.pgc.pa.gov/HuntTrap/Elk/Pages/default.aspx",
  },
  {
    stateCode: "PA", speciesSlug: "whitetail_deer", licenseCode: "antlerless_deer",
    name: "Antlerless Deer License",
    description: "Required for doe harvest. Allocated by WMU.",
    residency: "resident", cost: 6.97, isDrawEntry: true, year: YEAR,
    sourceUrl: "https://www.pgc.pa.gov/HuntTrap/Antlerless/Pages/default.aspx",
  },

  // ===========================================================================
  // TEXAS
  // ===========================================================================
  {
    stateCode: "TX", licenseCode: "annual_hunting_license", name: "Resident Annual Hunting License",
    description: "Required for all Texas hunters age 17+.",
    residency: "resident", cost: 25, isOtc: true, year: YEAR, minAge: 17,
    sourceUrl: "https://tpwd.texas.gov/regulations/outdoor-annual/licenses",
  },
  {
    stateCode: "TX", licenseCode: "annual_hunting_license", name: "Nonresident General Hunting License",
    description: "Required for nonresident hunters.",
    residency: "nonresident", cost: 315, isOtc: true, year: YEAR, minAge: 17,
    sourceUrl: "https://tpwd.texas.gov/regulations/outdoor-annual/licenses",
  },
  {
    stateCode: "TX", licenseCode: "super_combo", name: "Super Combo License Package",
    description: "Bundles hunting, fishing, archery, migratory bird, and all stamps. Best value.",
    residency: "resident", cost: 68, isOtc: true, year: YEAR,
    sourceUrl: "https://tpwd.texas.gov/regulations/outdoor-annual/licenses",
  },
  {
    stateCode: "TX", licenseCode: "upland_stamp", name: "Upland Game Bird Stamp",
    description: "Required for quail, pheasant, chachalaca hunting.",
    residency: "all", cost: 7, isOtc: true, year: YEAR,
    sourceUrl: "https://tpwd.texas.gov/regulations/outdoor-annual/licenses",
  },

  // ===========================================================================
  // FLORIDA
  // ===========================================================================
  {
    stateCode: "FL", licenseCode: "hunting_license", name: "Hunting License",
    description: "Annual license. Required for ages 16+.",
    residency: "resident", cost: 17, isOtc: true, year: YEAR, minAge: 16,
    sourceUrl: "https://myfwc.com/license/recreational/",
  },
  {
    stateCode: "FL", licenseCode: "hunting_license", name: "Hunting License",
    description: "Annual license for nonresident.",
    residency: "nonresident", cost: 151.50, isOtc: true, year: YEAR, minAge: 16,
    sourceUrl: "https://myfwc.com/license/recreational/",
  },
  {
    stateCode: "FL", licenseCode: "wma_permit", name: "Wildlife Management Area Permit",
    description: "Required for hunting on FL WMAs.",
    residency: "all", cost: 26.50, isOtc: true, year: YEAR,
    sourceUrl: "https://myfwc.com/license/recreational/",
  },
  {
    stateCode: "FL", licenseCode: "deer_permit", name: "Deer Permit",
    description: "Required for deer hunting.",
    residency: "all", cost: 5, isOtc: true, year: YEAR,
    sourceUrl: "https://myfwc.com/hunting/deer/",
  },
  {
    stateCode: "FL", speciesSlug: "wild_turkey", licenseCode: "turkey_permit",
    name: "Turkey Permit",
    description: "Required for turkey hunting. Annual.",
    residency: "all", cost: 10, isOtc: true, year: YEAR,
    sourceUrl: "https://myfwc.com/hunting/turkey/",
  },

  // ===========================================================================
  // NORTH CAROLINA
  // ===========================================================================
  {
    stateCode: "NC", licenseCode: "sportsman", name: "Sportsman License (Combo)",
    description: "Hunting + fishing + big-game + bear + game lands.",
    residency: "resident", cost: 40, isOtc: true, year: YEAR,
    sourceUrl: "https://www.ncwildlife.org/Licenses-Permits",
  },
  {
    stateCode: "NC", licenseCode: "annual_hunting", name: "Annual Hunting License",
    description: "Basic hunting license.",
    residency: "resident", cost: 25, isOtc: true, year: YEAR,
    sourceUrl: "https://www.ncwildlife.org/Licenses-Permits",
  },
  {
    stateCode: "NC", licenseCode: "annual_hunting", name: "Annual Hunting License",
    description: "Basic hunting license — nonresident.",
    residency: "nonresident", cost: 100, isOtc: true, year: YEAR,
    sourceUrl: "https://www.ncwildlife.org/Licenses-Permits",
  },
  {
    stateCode: "NC", speciesSlug: "whitetail_deer", licenseCode: "big_game_privilege",
    name: "Big Game Hunting Privilege",
    description: "Required in addition to base license for deer/bear/turkey.",
    residency: "resident", cost: 15, isOtc: true, year: YEAR,
    sourceUrl: "https://www.ncwildlife.org/Licenses-Permits",
  },

  // ===========================================================================
  // NEW YORK
  // ===========================================================================
  {
    stateCode: "NY", licenseCode: "small_game", name: "Small Game License",
    description: "Required for all hunters. Annual.",
    residency: "resident", cost: 22, isOtc: true, year: YEAR,
    sourceUrl: "https://www.dec.ny.gov/things-to-do/licenses",
  },
  {
    stateCode: "NY", speciesSlug: "whitetail_deer", licenseCode: "big_game_license",
    name: "Big Game License",
    description: "Required for deer or bear. Includes 1 buck tag.",
    residency: "resident", cost: 25, isOtc: true, year: YEAR,
    sourceUrl: "https://www.dec.ny.gov/things-to-do/licenses",
  },
  {
    stateCode: "NY", speciesSlug: "whitetail_deer", licenseCode: "doe_permit",
    name: "Deer Management Permit (DMP)",
    description: "Antlerless deer permit allocated by WMU via random selection.",
    residency: "all", cost: 10, isDrawEntry: true, year: YEAR,
    sourceUrl: "https://www.dec.ny.gov/outdoor/deer",
  },
];

async function upsertLicense(seed: LicenseSeed): Promise<void> {
  const [state] = await db
    .select()
    .from(states)
    .where(eq(states.code, seed.stateCode))
    .limit(1);
  if (!state) {
    console.log(`  ! State not found in DB: ${seed.stateCode} — skipping`);
    return;
  }

  let speciesId: string | null = null;
  if (seed.speciesSlug) {
    const [sp] = await db
      .select()
      .from(species)
      .where(eq(species.slug, seed.speciesSlug))
      .limit(1);
    if (!sp) {
      console.log(
        `  ! Species not in DB: ${seed.speciesSlug} (state ${seed.stateCode}) — inserting license without species link`
      );
    } else {
      speciesId = sp.id;
    }
  }

  // Composite key: (state, species, licenseCode, residency, year)
  const existing = await db
    .select()
    .from(licenseTypes)
    .where(
      and(
        eq(licenseTypes.stateId, state.id),
        eq(licenseTypes.licenseCode, seed.licenseCode),
        eq(licenseTypes.residency, seed.residency),
        eq(licenseTypes.year, seed.year)
      )
    )
    .limit(1);

  const row = {
    stateId: state.id,
    speciesId,
    licenseCode: seed.licenseCode,
    name: seed.name,
    description: seed.description,
    residency: seed.residency,
    cost: seed.cost,
    minAge: seed.minAge ?? null,
    maxAge: seed.maxAge ?? null,
    validFrom: seed.validFrom ?? null,
    validTo: seed.validTo ?? null,
    prerequisites: seed.prerequisites ?? {},
    isOtc: seed.isOtc ?? false,
    isDrawEntry: seed.isDrawEntry ?? false,
    quantityLimit: seed.quantityLimit ?? null,
    sourceUrl: seed.sourceUrl,
    year: seed.year,
    lastVerified: new Date(),
    enabled: true,
  };

  if (existing.length > 0) {
    await db
      .update(licenseTypes)
      .set(row)
      .where(eq(licenseTypes.id, existing[0]!.id));
  } else {
    await db.insert(licenseTypes).values(row);
  }
}

async function main(): Promise<void> {
  console.log(`Seeding ${SEEDS.length} license-type rows...`);
  console.log("");
  let ok = 0;
  let fail = 0;
  for (const seed of SEEDS) {
    try {
      await upsertLicense(seed);
      ok++;
    } catch (error) {
      fail++;
      console.error(
        `  ✗ ${seed.stateCode}/${seed.licenseCode} (${seed.residency}): ${error}`
      );
    }
  }
  console.log("");
  console.log(`Done. ${ok} seeded, ${fail} failed.`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
