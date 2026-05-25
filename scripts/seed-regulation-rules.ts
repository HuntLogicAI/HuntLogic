/**
 * Seed structured regulation rules for the top 10 hunting states.
 *
 * Each rule is an atomic compliance fact that Grizz can look up to answer
 * questions like "is .22 LR legal for elk in CO?" or "do I need non-toxic
 * shot for pheasants in IA?" without re-parsing PDFs every chat.
 *
 * Idempotent: deletes all existing rules for a state, then re-inserts.
 *
 * Run with: DATABASE_URL=... tsx scripts/seed-regulation-rules.ts
 */

import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);

interface RuleSeed {
  /** Optional species slug — null for state-wide rules */
  species?: string | null;
  ruleType: string;
  seasonType?: string | null;
  weaponType?: string | null;
  value: Record<string, unknown>;
  zoneScope?: string;
  effectiveYear?: number;
  sourceUrl?: string;
  sourceQuote?: string;
  notes?: string;
}

const CURRENT_YEAR = 2026;

// =============================================================================
// PA — Pennsylvania
// =============================================================================
const PA_RULES: RuleSeed[] = [
  {
    ruleType: "weapon_legal",
    weaponType: "rifle",
    value: { legal: true, applies_to: "big game", restrictions: [] },
    sourceUrl: "https://www.pa.gov/agencies/pgc/huntingandtrapping.html",
  },
  {
    ruleType: "antler_restriction",
    species: "whitetail",
    value: {
      required: true,
      min_points_one_side: 3,
      varies_by_wmu: true,
      note: "Most WMUs require 3+ points on one side; some require 4+. Verify the specific WMU.",
    },
    sourceUrl: "https://www.pa.gov/agencies/pgc/huntingandtrapping/get-started-hunting/deer-hunting.html",
  },
  {
    ruleType: "sunday_hunting_legal",
    value: {
      legal: true,
      restrictions: ["Limited to 3 specific Sundays per year statewide"],
      note: "PA Sunday hunting expanded recently but still limited; verify current dates.",
    },
  },
  {
    ruleType: "baiting_legal",
    species: "whitetail",
    value: { legal: false, reason: "PA prohibits hunting deer over bait" },
  },
  {
    ruleType: "baiting_legal",
    species: "black-bear",
    value: { legal: false, reason: "PA prohibits hunting bear over bait" },
  },
  {
    ruleType: "crossbow_during_archery",
    value: { legal: true, all_hunters: true, note: "Crossbow is legal during archery season for all hunters in PA" },
  },
  {
    ruleType: "orange_minimum",
    seasonType: "firearm",
    value: {
      required: true,
      color: "fluorescent_orange",
      min_sq_inches: 250,
      placement: "head, chest, back combined",
    },
  },
  {
    ruleType: "caliber_min",
    species: "whitetail",
    weaponType: "rifle",
    value: { min_caliber: ".22 centerfire", note: "No rimfire for big game" },
  },
  {
    ruleType: "mandatory_harvest_report",
    species: "whitetail",
    value: {
      required: true,
      method: "online or phone (HuntFishPA)",
      deadline_days: 10,
    },
  },
  {
    ruleType: "non_toxic_shot_required",
    value: {
      required: true,
      applies_to: ["waterfowl"],
      note: "Federal requirement, enforced at state level",
    },
  },
  {
    ruleType: "magazine_limit",
    weaponType: "shotgun",
    value: { max_total_rounds: 3, applies_to: "waterfowl", plug_required: true },
  },
];

// =============================================================================
// OH — Ohio
// =============================================================================
const OH_RULES: RuleSeed[] = [
  {
    ruleType: "weapon_legal",
    weaponType: "rifle",
    species: "whitetail",
    value: {
      legal: true,
      note: "Pistol-caliber rifles legalized recently (.357 Mag, .44 Mag, .45 Colt, etc.). Verify current approved list.",
      restrictions: ["pistol-caliber centerfire only"],
    },
    sourceUrl: "https://ohiodnr.gov/discover-and-learn/safety-conservation/about-odnr/division-wildlife",
  },
  {
    ruleType: "weapon_legal",
    weaponType: "shotgun",
    species: "whitetail",
    value: { legal: true, restrictions: ["slug only, 410 gauge or larger"] },
  },
  {
    ruleType: "sunday_hunting_legal",
    value: { legal: true, restrictions: [] },
  },
  {
    ruleType: "baiting_legal",
    species: "whitetail",
    value: { legal: true, note: "Baiting legal for deer in most counties; verify CWD zone restrictions" },
  },
  {
    ruleType: "crossbow_during_archery",
    value: { legal: true, all_hunters: true },
  },
  {
    ruleType: "orange_minimum",
    seasonType: "firearm",
    value: {
      required: true,
      color: "fluorescent_orange",
      min_sq_inches: 400,
      placement: "outermost garment",
    },
  },
  {
    ruleType: "antler_restriction",
    species: "whitetail",
    value: {
      required: true,
      varies_by_county: true,
      note: "APR active in Athens, Hocking, Vinton, and several other counties (typically 4+ points on one side). Verify specific county.",
    },
  },
  {
    ruleType: "mandatory_harvest_report",
    species: "whitetail",
    value: { required: true, method: "online or HuntFish OH app", deadline_days: 1 },
  },
  {
    ruleType: "non_toxic_shot_required",
    value: { required: true, applies_to: ["waterfowl"] },
  },
];

// =============================================================================
// WI — Wisconsin
// =============================================================================
const WI_RULES: RuleSeed[] = [
  {
    ruleType: "weapon_legal",
    weaponType: "rifle",
    species: "whitetail",
    value: { legal: true, restrictions: [] },
  },
  {
    ruleType: "sunday_hunting_legal",
    value: { legal: true, restrictions: [] },
  },
  {
    ruleType: "baiting_legal",
    species: "whitetail",
    value: {
      legal: true,
      restrictions: ["50 gallons max per site", "specific feed types only"],
      note: "Banned outright in CWD-positive counties; verify current map",
    },
  },
  {
    ruleType: "baiting_legal",
    species: "black-bear",
    value: { legal: true, restrictions: ["state-licensed bait sites only"] },
  },
  {
    ruleType: "hounding_legal",
    species: "black-bear",
    value: { legal: true, restrictions: ["hound training season + regular hunt season"] },
  },
  {
    ruleType: "crossbow_during_archery",
    value: { legal: true, all_hunters: true },
  },
  {
    ruleType: "orange_minimum",
    seasonType: "firearm",
    value: {
      required: true,
      color: "blaze_orange_or_fluorescent_pink",
      pct_visible_above_waist: 50,
    },
  },
  {
    ruleType: "mandatory_harvest_report",
    species: "whitetail",
    value: { required: true, method: "Go Wild online registration", deadline_days: 1 },
  },
  {
    ruleType: "cwd_carcass_transport",
    value: {
      restricted: true,
      out_of_cwd_zone_parts_allowed: ["boned_meat", "antlers_no_tissue", "hides_no_head", "skull_cap_cleaned"],
      applies_to: ["whitetail"],
      note: "Verify current CWD zone map; rules update annually",
    },
  },
  {
    ruleType: "non_toxic_shot_required",
    value: { required: true, applies_to: ["waterfowl"] },
  },
];

// =============================================================================
// MI — Michigan
// =============================================================================
const MI_RULES: RuleSeed[] = [
  {
    ruleType: "weapon_legal",
    weaponType: "rifle",
    species: "whitetail",
    value: {
      legal: true,
      varies_by_zone: true,
      note: "Rifle legal in UP and NLP. Shotgun-only zone in much of southern Lower Peninsula. Verify the zone.",
    },
  },
  {
    ruleType: "sunday_hunting_legal",
    value: { legal: true, restrictions: [] },
  },
  {
    ruleType: "baiting_legal",
    species: "whitetail",
    value: {
      legal: false,
      varies_by_zone: true,
      note: "Baiting prohibited in CWD zones (much of LP); legal in much of UP. Verify the current map.",
    },
  },
  {
    ruleType: "hounding_legal",
    species: "black-bear",
    value: { legal: true, restrictions: ["zone-specific permits, season-specific"] },
  },
  {
    ruleType: "crossbow_during_archery",
    value: { legal: true, all_hunters: true },
  },
  {
    ruleType: "orange_minimum",
    seasonType: "firearm",
    value: { required: true, color: "hunter_orange", min_sq_inches: 144, placement: "outermost garment above waist" },
  },
  {
    ruleType: "non_toxic_shot_required",
    value: { required: true, applies_to: ["waterfowl"] },
  },
];

// =============================================================================
// IA — Iowa
// =============================================================================
const IA_RULES: RuleSeed[] = [
  {
    ruleType: "weapon_legal",
    weaponType: "rifle",
    species: "whitetail",
    value: {
      legal: false,
      reason: "Iowa prohibits rifle for deer. Shotgun (slug), muzzleloader, archery, and pistol calibers in straight-walled handguns only.",
    },
  },
  {
    ruleType: "weapon_legal",
    weaponType: "shotgun",
    species: "whitetail",
    value: { legal: true, restrictions: ["slug only, 20 gauge or larger"] },
  },
  {
    ruleType: "sunday_hunting_legal",
    value: { legal: true, restrictions: [] },
  },
  {
    ruleType: "baiting_legal",
    species: "whitetail",
    value: { legal: false, reason: "Iowa prohibits hunting deer over bait" },
  },
  {
    ruleType: "crossbow_during_archery",
    value: {
      legal: true,
      only: ["disabled hunters", "hunters 70+", "youth in some cases"],
      note: "General population: crossbow legal only during shotgun season, NOT during archery",
    },
  },
  {
    ruleType: "orange_minimum",
    seasonType: "firearm",
    value: { required: true, color: "blaze_orange", min_sq_inches: 144, placement: "outermost garment" },
  },
  {
    ruleType: "nonresident_cap_pct",
    species: "whitetail",
    value: { cap_pct: 5, applies_to: "any-sex tags", note: "Limited NR allocation; lottery-based" },
  },
  {
    ruleType: "non_toxic_shot_required",
    value: { required: true, applies_to: ["waterfowl"] },
  },
];

// =============================================================================
// TX — Texas
// =============================================================================
const TX_RULES: RuleSeed[] = [
  {
    ruleType: "weapon_legal",
    weaponType: "rifle",
    species: "whitetail",
    value: { legal: true, restrictions: [] },
  },
  {
    ruleType: "sunday_hunting_legal",
    value: { legal: true, restrictions: [] },
  },
  {
    ruleType: "baiting_legal",
    species: "whitetail",
    value: { legal: true, note: "Baiting and feeders are standard practice in TX deer hunting" },
  },
  {
    ruleType: "baiting_legal",
    species: "feral-hog",
    value: { legal: true },
  },
  {
    ruleType: "night_hunting_legal",
    species: "feral-hog",
    value: { legal: true, with_artificial_light: true, note: "Year-round nightly hog hunting legal on private with landowner consent" },
  },
  {
    ruleType: "crossbow_during_archery",
    value: { legal: true, all_hunters: true },
  },
  {
    ruleType: "orange_minimum",
    value: {
      required: false,
      note: "Not required statewide. Many TPWD public hunts require blaze orange; verify the specific permit.",
    },
  },
  {
    ruleType: "caliber_min",
    species: "whitetail",
    weaponType: "rifle",
    value: {
      min_caliber: null,
      note: "TX has no statewide caliber minimum for deer. Common ethical practice is .243 or larger.",
    },
  },
  {
    ruleType: "bag_limit_season",
    species: "feral-hog",
    value: { limit: null, note: "No closed season, no bag limit on feral hog with valid hunting license on private land" },
  },
  {
    ruleType: "non_toxic_shot_required",
    value: { required: true, applies_to: ["waterfowl"] },
  },
];

// =============================================================================
// CO — Colorado
// =============================================================================
const CO_RULES: RuleSeed[] = [
  {
    ruleType: "weapon_legal",
    weaponType: "rifle",
    species: "elk",
    value: { legal: true, restrictions: [] },
  },
  {
    ruleType: "caliber_min",
    species: "elk",
    weaponType: "rifle",
    value: {
      min_caliber: ".24",
      min_bullet_grain: 70,
      note: "Minimum .24 caliber (.243) for big game in CO; expanding-type bullet required",
    },
    sourceUrl: "https://cpw.state.co.us/thingstodo/Pages/Hunting.aspx",
  },
  {
    ruleType: "sunday_hunting_legal",
    value: { legal: true, restrictions: [] },
  },
  {
    ruleType: "baiting_legal",
    species: "elk",
    value: { legal: false, reason: "Baiting prohibited for big game in CO" },
  },
  {
    ruleType: "baiting_legal",
    species: "whitetail",
    value: { legal: false },
  },
  {
    ruleType: "crossbow_during_archery",
    value: {
      legal: false,
      exceptions: ["disabled hunters with permit"],
      note: "Crossbow legal during muzzleloader and rifle for all; archery requires bow",
    },
  },
  {
    ruleType: "orange_minimum",
    seasonType: "firearm",
    value: {
      required: true,
      color: "daylight_fluorescent_orange",
      min_sq_inches: 500,
      placement: "outer garment above waist + head cover",
    },
  },
  {
    ruleType: "nonresident_cap_pct",
    species: "elk",
    value: {
      cap_pct: 20,
      applies_to: "units requiring 6+ preference points to draw",
      note: "High-demand unit NR cap; standard units less restrictive",
    },
  },
  {
    ruleType: "non_toxic_shot_required",
    value: { required: true, applies_to: ["waterfowl"] },
  },
];

// =============================================================================
// WY — Wyoming
// =============================================================================
const WY_RULES: RuleSeed[] = [
  {
    ruleType: "weapon_legal",
    weaponType: "rifle",
    species: "elk",
    value: { legal: true, restrictions: [] },
  },
  {
    ruleType: "caliber_min",
    species: "elk",
    weaponType: "rifle",
    value: { min_caliber: ".22 centerfire", note: "WY .22 centerfire minimum for big game; expanding bullet required" },
    sourceUrl: "https://wgfd.wyo.gov/Hunting/Regulations",
  },
  {
    ruleType: "sunday_hunting_legal",
    value: { legal: true, restrictions: [] },
  },
  {
    ruleType: "baiting_legal",
    species: "elk",
    value: { legal: false, reason: "Baiting prohibited for big game" },
  },
  {
    ruleType: "baiting_legal",
    species: "black-bear",
    value: { legal: true, restrictions: ["state-licensed bait sites only, registration required"] },
  },
  {
    ruleType: "crossbow_during_archery",
    value: {
      legal: false,
      exceptions: ["disabled hunters with permit"],
      note: "Crossbow legal during regular firearm season; not during archery-only",
    },
  },
  {
    ruleType: "orange_minimum",
    seasonType: "firearm",
    value: {
      required: true,
      color: "fluorescent_orange",
      note: "1 garment (hat OR vest/coat covering chest+back) of fluorescent orange required during firearm seasons",
    },
  },
  {
    ruleType: "nonresident_cap_pct",
    species: "elk",
    value: {
      cap_pct: 16,
      applies_to: "regular elk draw",
      note: "16% NR cap on regular elk; 25% on deer/antelope. Special draw has separate quota.",
    },
  },
  {
    ruleType: "non_toxic_shot_required",
    value: { required: true, applies_to: ["waterfowl"] },
  },
];

// =============================================================================
// UT — Utah
// =============================================================================
const UT_RULES: RuleSeed[] = [
  {
    ruleType: "weapon_legal",
    weaponType: "rifle",
    species: "elk",
    value: { legal: true, restrictions: [] },
  },
  {
    ruleType: "caliber_min",
    species: "elk",
    weaponType: "rifle",
    value: { min_caliber: ".24 centerfire", note: "UT minimum .24 centerfire (.243) for big game; expanding bullet required" },
  },
  {
    ruleType: "sunday_hunting_legal",
    value: { legal: true, restrictions: [] },
  },
  {
    ruleType: "baiting_legal",
    species: "elk",
    value: { legal: false, reason: "Baiting prohibited for big game" },
  },
  {
    ruleType: "crossbow_during_archery",
    value: {
      legal: false,
      exceptions: ["disabled hunters with permit"],
      note: "Crossbow legal during muzzleloader and rifle; not during archery-only",
    },
  },
  {
    ruleType: "orange_minimum",
    seasonType: "firearm",
    value: {
      required: true,
      color: "hunter_orange",
      min_sq_inches: 400,
      placement: "above the waist, visible from all sides",
    },
  },
  {
    ruleType: "bag_limit_lifetime",
    species: "bighorn-sheep",
    value: { limit: 1, lifetime: true, note: "Rocky Mountain bighorn is once-in-a-lifetime in UT" },
  },
  {
    ruleType: "bag_limit_lifetime",
    species: "moose",
    value: { limit: 1, lifetime: true, note: "Shiras moose is once-in-a-lifetime in UT" },
  },
  {
    ruleType: "bag_limit_lifetime",
    species: "mountain-goat",
    value: { limit: 1, lifetime: true, note: "Rocky Mountain goat is once-in-a-lifetime in UT" },
  },
  {
    ruleType: "non_toxic_shot_required",
    value: { required: true, applies_to: ["waterfowl"] },
  },
];

// =============================================================================
// NV — Nevada
// =============================================================================
const NV_RULES: RuleSeed[] = [
  {
    ruleType: "weapon_legal",
    weaponType: "rifle",
    species: "elk",
    value: { legal: true, restrictions: [] },
  },
  {
    ruleType: "caliber_min",
    species: "elk",
    weaponType: "rifle",
    value: { min_caliber: ".22 centerfire", note: "NV minimum .22 centerfire for big game; expanding bullet required" },
  },
  {
    ruleType: "sunday_hunting_legal",
    value: { legal: true, restrictions: [] },
  },
  {
    ruleType: "baiting_legal",
    species: "elk",
    value: { legal: false, reason: "Baiting prohibited for big game" },
  },
  {
    ruleType: "crossbow_during_archery",
    value: {
      legal: false,
      exceptions: ["disabled hunters with permit"],
      note: "Crossbow legal during muzzleloader and rifle; archery requires bow",
    },
  },
  {
    ruleType: "orange_minimum",
    value: {
      required: false,
      note: "Not required statewide. Some specific units may have requirements; verify by unit.",
    },
  },
  {
    ruleType: "nonresident_cap_pct",
    species: "elk",
    value: { cap_pct: 10, applies_to: "all big game except non-quota", note: "NV 10% NR cap is among the most restrictive in the west" },
  },
  {
    ruleType: "bag_limit_lifetime",
    species: "bighorn-sheep",
    value: { limit: 1, lifetime: true, note: "Each bighorn subspecies (California, desert, Rocky Mountain) is separate lifetime tag" },
  },
  {
    ruleType: "non_toxic_shot_required",
    value: { required: true, applies_to: ["waterfowl"] },
  },
];

// =============================================================================
// Orchestration
// =============================================================================

const STATE_RULES: Record<string, RuleSeed[]> = {
  PA: PA_RULES,
  OH: OH_RULES,
  WI: WI_RULES,
  MI: MI_RULES,
  IA: IA_RULES,
  TX: TX_RULES,
  CO: CO_RULES,
  WY: WY_RULES,
  UT: UT_RULES,
  NV: NV_RULES,
};

async function seedRegulationRules() {
  // Lookup state IDs by code
  const stateRows = await sql`
    SELECT id, code FROM states WHERE code = ANY(${Object.keys(STATE_RULES)})
  `;
  const stateMap = new Map<string, string>();
  for (const row of stateRows) stateMap.set(row.code, row.id);
  console.log(`[seed:rules] Resolved ${stateMap.size} state IDs:`, [...stateMap.keys()]);

  // Lookup all species IDs by slug (covers every species referenced across all states)
  const allSpeciesSlugs = new Set<string>();
  for (const rules of Object.values(STATE_RULES)) {
    for (const rule of rules) {
      if (rule.species) allSpeciesSlugs.add(rule.species);
    }
  }
  const speciesRows = await sql`
    SELECT id, slug FROM species WHERE slug = ANY(${[...allSpeciesSlugs]})
  `;
  const speciesMap = new Map<string, string>();
  for (const row of speciesRows) speciesMap.set(row.slug, row.id);
  console.log(`[seed:rules] Resolved ${speciesMap.size} species IDs:`, [...speciesMap.keys()]);

  let totalInserted = 0;
  let totalDeleted = 0;

  for (const [stateCode, rules] of Object.entries(STATE_RULES)) {
    const stateId = stateMap.get(stateCode);
    if (!stateId) {
      console.warn(`[seed:rules] State ${stateCode} not found, skipping ${rules.length} rules`);
      continue;
    }

    // Idempotent: wipe existing rules for this state before re-inserting
    const deleted = await sql`
      DELETE FROM state_regulation_rules WHERE state_id = ${stateId}
    `;
    totalDeleted += deleted.count;

    for (const rule of rules) {
      const speciesId = rule.species ? speciesMap.get(rule.species) ?? null : null;
      if (rule.species && !speciesId) {
        console.warn(`[seed:rules] ${stateCode}: species '${rule.species}' not found, skipping rule ${rule.ruleType}`);
        continue;
      }

      await sql`
        INSERT INTO state_regulation_rules (
          state_id, species_id, rule_type, season_type, weapon_type,
          value, zone_scope, effective_year, source_url, source_quote, notes
        ) VALUES (
          ${stateId},
          ${speciesId},
          ${rule.ruleType},
          ${rule.seasonType ?? null},
          ${rule.weaponType ?? null},
          ${sql.json(rule.value)},
          ${rule.zoneScope ?? "statewide"},
          ${rule.effectiveYear ?? CURRENT_YEAR},
          ${rule.sourceUrl ?? null},
          ${rule.sourceQuote ?? null},
          ${rule.notes ?? null}
        )
      `;
      totalInserted++;
    }
    console.log(`[seed:rules] ${stateCode}: deleted ${deleted.count} old, inserted ${rules.length} new`);
  }

  console.log(`\n[seed:rules] Done. Deleted ${totalDeleted} stale rules, inserted ${totalInserted} fresh rules across ${stateMap.size} states.`);

  await sql.end();
}

seedRegulationRules().catch((err) => {
  console.error("[seed:rules] Failed:", err);
  process.exit(1);
});
