/**
 * Seed: Weapon Regulations — priority states + species
 *
 * Encodes the legal weapon rules per (state, species, weapon, season). Powers
 * the equipment-aware concierge: "Georgia + shotgun + deer → here's what's
 * legal where, with these restrictions, in these seasons."
 *
 * Notes on the schema:
 *   - `allowed=false` rows ARE valuable. They let the concierge say
 *     "you cannot use a rifle for deer in this GA county" instead of
 *     hallucinating.
 *   - `restrictions` JSONB carries the granular rules (min_caliber, gauge,
 *     broadhead, magazine_capacity, etc).
 *   - `hunt_unit_overrides` carries county/zone allowlists/denylists.
 *   - `summary` is a human-readable line cited verbatim by the concierge.
 *
 * Run: pnpm tsx scripts/seed-weapon-regulations.ts
 */

import { db } from "../src/lib/db";
import { states, species, weaponRegulations } from "../src/lib/db/schema";
import { eq, and } from "drizzle-orm";

interface WeaponSeed {
  stateCode: string;
  speciesSlug: string;
  weaponType: string;
  allowed: boolean;
  seasonContext?: string;
  restrictions?: Record<string, unknown>;
  huntUnitOverrides?: Record<string, unknown>;
  summary: string;
  sourceUrl: string;
  year: number;
}

const YEAR = 2026;

const SEEDS: WeaponSeed[] = [
  // ===========================================================================
  // GEORGIA — the headline "shotgun + deer" use case.
  // GA has firearms-only / archery-only / primitive-weapon seasons and
  // some shotgun-only counties (mostly in central/coastal GA where rifle
  // is restricted due to flat terrain and population density).
  // ===========================================================================
  {
    stateCode: "GA", speciesSlug: "whitetail_deer", weaponType: "rifle",
    allowed: true, seasonContext: "firearms_season",
    restrictions: {
      min_caliber: ".22 centerfire",
      sub_caliber_22_long_rifle_prohibited: true,
      magazine_capacity_max: 5,
      tracer_allowed: false,
    },
    huntUnitOverrides: {
      // Some central + coastal GA counties are shotgun-only by ordinance.
      // Examples: Bryan, Camden, Chatham, Glynn, Liberty, McIntosh.
      deny_unit_codes: ["BRYAN", "CAMDEN", "CHATHAM", "GLYNN", "LIBERTY", "MCINTOSH"],
      notes: "Rifle prohibited in coastal/central shotgun-only counties — confirm county-by-county.",
    },
    summary:
      "Rifle legal for deer in firearms season statewide except shotgun-only counties (largely coastal). " +
      "Center-fire only, no .22 long rifle, magazine capacity ≤ 5.",
    sourceUrl: "https://georgiawildlife.com/regulations/hunting",
    year: YEAR,
  },
  {
    stateCode: "GA", speciesSlug: "whitetail_deer", weaponType: "shotgun_slug",
    allowed: true, seasonContext: "firearms_season",
    restrictions: {
      min_gauge: 20,
      slug_or_buckshot_allowed: ["slug", "00_buckshot_or_larger"],
      magazine_capacity_max: 5,
    },
    summary:
      "Shotgun (20 ga. or larger) loaded with slug or 00-buckshot-or-larger is legal for deer statewide. " +
      "Required in shotgun-only counties.",
    sourceUrl: "https://georgiawildlife.com/regulations/hunting",
    year: YEAR,
  },
  {
    stateCode: "GA", speciesSlug: "whitetail_deer", weaponType: "archery",
    allowed: true, seasonContext: "archery_season",
    restrictions: {
      min_draw_weight_lbs: 35,
      broadhead_min_blade_width_inches: 7 / 8,
      mechanical_broadheads_allowed: true,
    },
    summary:
      "Archery legal during archery season (mid-September on). Min 35 lb draw, broadhead ≥ 7/8 in.",
    sourceUrl: "https://georgiawildlife.com/regulations/hunting",
    year: YEAR,
  },
  {
    stateCode: "GA", speciesSlug: "whitetail_deer", weaponType: "crossbow",
    allowed: true, seasonContext: "archery_season",
    restrictions: { min_draw_weight_lbs: 100, broadhead_required: true },
    summary: "Crossbow legal during archery and firearms seasons for all hunters (no disability requirement).",
    sourceUrl: "https://georgiawildlife.com/regulations/hunting",
    year: YEAR,
  },
  {
    stateCode: "GA", speciesSlug: "whitetail_deer", weaponType: "muzzleloader",
    allowed: true, seasonContext: "primitive_weapons_season",
    restrictions: { min_caliber: ".44", scope_allowed: true },
    summary: "Muzzleloader (≥.44 cal) legal during primitive weapons + firearms seasons. Scopes allowed.",
    sourceUrl: "https://georgiawildlife.com/regulations/hunting",
    year: YEAR,
  },
  {
    stateCode: "GA", speciesSlug: "wild_turkey", weaponType: "shotgun",
    allowed: true, seasonContext: "spring_turkey_season",
    restrictions: {
      max_shot_size: "no_2_or_smaller",
      ttss_shot_allowed: true,
      max_gauge: 10,
      magazine_capacity_max: 3,
    },
    summary:
      "Shotgun legal for turkey, ≤ 10 ga., shot size #2 or smaller (incl. tungsten alternatives). " +
      "Magazine ≤ 3 shells.",
    sourceUrl: "https://georgiawildlife.com/turkey",
    year: YEAR,
  },
  {
    stateCode: "GA", speciesSlug: "wild_turkey", weaponType: "rifle",
    allowed: false, seasonContext: "spring_turkey_season",
    summary: "Rifles are NOT legal for spring turkey in Georgia.",
    sourceUrl: "https://georgiawildlife.com/turkey",
    year: YEAR,
  },
  {
    stateCode: "GA", speciesSlug: "wild_turkey", weaponType: "archery",
    allowed: true, seasonContext: "spring_turkey_season",
    restrictions: { min_draw_weight_lbs: 35, broadhead_required: true },
    summary: "Archery legal for spring turkey. Same equipment rules as deer.",
    sourceUrl: "https://georgiawildlife.com/turkey",
    year: YEAR,
  },

  // ===========================================================================
  // COLORADO — sample big-game weapon rules
  // ===========================================================================
  {
    stateCode: "CO", speciesSlug: "elk", weaponType: "rifle",
    allowed: true, seasonContext: "rifle_season",
    restrictions: {
      min_caliber_centerfire: ".24",
      min_bullet_energy_ftlbs_1000yd: 1000,
      magazine_capacity_max: null,
    },
    summary:
      "Center-fire rifle ≥ .24 cal, ≥1000 ft-lbs at 100 yd. Rifle seasons run late Oct–early Nov.",
    sourceUrl: "https://cpw.state.co.us/thingstodo/Pages/Hunting.aspx",
    year: YEAR,
  },
  {
    stateCode: "CO", speciesSlug: "elk", weaponType: "muzzleloader",
    allowed: true, seasonContext: "muzzleloader_season",
    restrictions: {
      min_caliber: ".50",
      open_sights_only: true,
      single_shot_only: true,
      no_sabots: false,
    },
    summary:
      "Muzzleloader ≥ .50 cal, single-shot, open sights only (no scopes). Mid-September.",
    sourceUrl: "https://cpw.state.co.us/thingstodo/Pages/Hunting.aspx",
    year: YEAR,
  },
  {
    stateCode: "CO", speciesSlug: "elk", weaponType: "archery",
    allowed: true, seasonContext: "archery_season",
    restrictions: {
      min_draw_weight_lbs: 35,
      broadhead_min_blade_width_inches: 7 / 8,
      no_electronic_aids: true,
    },
    summary: "Archery legal Sept 2 – Sept 30. ≥35# draw, ≥7/8 in. broadhead, no electronic aids.",
    sourceUrl: "https://cpw.state.co.us/thingstodo/Pages/Hunting.aspx",
    year: YEAR,
  },

  // ===========================================================================
  // WYOMING — sample
  // ===========================================================================
  {
    stateCode: "WY", speciesSlug: "elk", weaponType: "rifle",
    allowed: true, seasonContext: "general_season",
    restrictions: { min_caliber_centerfire: ".22 with 60-grain bullet" },
    summary: "Center-fire rifle for elk, mid-Sept–mid-Oct typical, region-dependent.",
    sourceUrl: "https://wgfd.wyo.gov/hunting/elk",
    year: YEAR,
  },

  // ===========================================================================
  // TEXAS — shotgun-only for deer in some counties (special "Type II")
  // ===========================================================================
  {
    stateCode: "TX", speciesSlug: "whitetail_deer", weaponType: "rifle",
    allowed: true, seasonContext: "general_season",
    huntUnitOverrides: {
      deny_unit_codes: ["COLLIN", "DALLAS", "DENTON", "GRAYSON", "ROCKWALL", "ELLIS"],
      notes: "Shotgun/archery only in densely populated DFW-metro counties.",
    },
    summary: "Rifle legal statewide except shotgun-only DFW-metro counties.",
    sourceUrl: "https://tpwd.texas.gov/regulations/outdoor-annual/hunting/general-rules",
    year: YEAR,
  },
  {
    stateCode: "TX", speciesSlug: "whitetail_deer", weaponType: "shotgun_slug",
    allowed: true, seasonContext: "general_season",
    summary: "Shotgun (slug or buckshot) legal everywhere.",
    sourceUrl: "https://tpwd.texas.gov/regulations/outdoor-annual/hunting/general-rules",
    year: YEAR,
  },
  {
    stateCode: "TX", speciesSlug: "whitetail_deer", weaponType: "archery",
    allowed: true, seasonContext: "archery_season",
    restrictions: { min_draw_weight_lbs: 25 },
    summary: "Archery-only season ~ early Oct–early Nov. ≥25# draw.",
    sourceUrl: "https://tpwd.texas.gov/regulations/outdoor-annual/hunting/general-rules",
    year: YEAR,
  },

  // ===========================================================================
  // PENNSYLVANIA — interesting: semi-auto only legal for big game since 2017
  // ===========================================================================
  {
    stateCode: "PA", speciesSlug: "whitetail_deer", weaponType: "rifle",
    allowed: true, seasonContext: "firearms_season",
    restrictions: {
      semi_auto_allowed: true,
      magazine_capacity_max: 5,
      no_full_auto: true,
    },
    summary: "Center-fire rifle (incl. semi-auto since 2017). Mag ≤ 5.",
    sourceUrl: "https://www.pgc.pa.gov/HuntTrap/Pages/default.aspx",
    year: YEAR,
  },
  {
    stateCode: "PA", speciesSlug: "whitetail_deer", weaponType: "crossbow",
    allowed: true, seasonContext: "archery_season",
    restrictions: { min_draw_weight_lbs: 125 },
    summary: "Crossbow legal during archery + firearms seasons. ≥125# draw.",
    sourceUrl: "https://www.pgc.pa.gov/HuntTrap/Pages/default.aspx",
    year: YEAR,
  },

  // ===========================================================================
  // FLORIDA — interesting: dogs legal for deer in some zones
  // ===========================================================================
  {
    stateCode: "FL", speciesSlug: "whitetail_deer", weaponType: "rifle",
    allowed: true, seasonContext: "general_gun",
    summary: "Rifle legal. Center-fire any caliber typically allowed.",
    sourceUrl: "https://myfwc.com/hunting/deer/",
    year: YEAR,
  },
  {
    stateCode: "FL", speciesSlug: "whitetail_deer", weaponType: "dogs",
    allowed: true, seasonContext: "general_gun",
    huntUnitOverrides: {
      allow_zones: ["zone_a", "zone_b", "zone_c", "zone_d"],
      notes: "Hunting deer with dogs allowed in most zones during general gun season; check specific WMA rules.",
    },
    summary: "Hunting deer with trained dogs is legal in FL during general gun season in most zones.",
    sourceUrl: "https://myfwc.com/hunting/deer/",
    year: YEAR,
  },

  // ===========================================================================
  // NORTH CAROLINA — sample
  // ===========================================================================
  {
    stateCode: "NC", speciesSlug: "whitetail_deer", weaponType: "rifle",
    allowed: true, seasonContext: "gun_season",
    summary: "Rifle legal during gun season (mid-Oct–early Jan, zone-dependent).",
    sourceUrl: "https://www.ncwildlife.org/Hunting",
    year: YEAR,
  },
  {
    stateCode: "NC", speciesSlug: "whitetail_deer", weaponType: "crossbow",
    allowed: true, seasonContext: "archery_season",
    summary: "Crossbow legal during all archery and gun seasons.",
    sourceUrl: "https://www.ncwildlife.org/Hunting",
    year: YEAR,
  },
];

async function upsert(seed: WeaponSeed): Promise<void> {
  const [state] = await db
    .select()
    .from(states)
    .where(eq(states.code, seed.stateCode))
    .limit(1);
  if (!state) {
    console.log(`  ! State not found: ${seed.stateCode}`);
    return;
  }
  const [sp] = await db
    .select()
    .from(species)
    .where(eq(species.slug, seed.speciesSlug))
    .limit(1);
  if (!sp) {
    console.log(`  ! Species not found: ${seed.speciesSlug}`);
    return;
  }

  const existing = await db
    .select()
    .from(weaponRegulations)
    .where(
      and(
        eq(weaponRegulations.stateId, state.id),
        eq(weaponRegulations.speciesId, sp.id),
        eq(weaponRegulations.weaponType, seed.weaponType),
        eq(weaponRegulations.year, seed.year)
      )
    )
    .limit(1);

  const row = {
    stateId: state.id,
    speciesId: sp.id,
    weaponType: seed.weaponType,
    allowed: seed.allowed,
    seasonContext: seed.seasonContext ?? null,
    restrictions: seed.restrictions ?? {},
    huntUnitOverrides: seed.huntUnitOverrides ?? {},
    summary: seed.summary,
    sourceUrl: seed.sourceUrl,
    year: seed.year,
    lastVerified: new Date(),
  };

  if (existing.length > 0) {
    await db
      .update(weaponRegulations)
      .set(row)
      .where(eq(weaponRegulations.id, existing[0]!.id));
  } else {
    await db.insert(weaponRegulations).values(row);
  }
}

async function main(): Promise<void> {
  console.log(`Seeding ${SEEDS.length} weapon-regulation rows...`);
  let ok = 0, fail = 0;
  for (const s of SEEDS) {
    try {
      await upsert(s);
      ok++;
    } catch (error) {
      fail++;
      console.error(
        `  ✗ ${s.stateCode}/${s.speciesSlug}/${s.weaponType}: ${error}`
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
