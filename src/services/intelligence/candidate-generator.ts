// =============================================================================
// Candidate Generator — Stage 1 of the Recommendation Pipeline
//
// Filters the universe of hunt opportunities by hard constraints from the
// hunter's profile to produce a manageable set of candidates for scoring.
// =============================================================================

import { eq, and, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  states,
  species,
  stateSpecies,
  huntUnits,
  drawOdds,
  harvestStats,
  seasons,
} from "@/lib/db/schema";

import type { HunterProfile } from "@/services/profile/types";
import type { HuntCandidate, CostEstimate } from "./types";
import { loadStateCosts } from "./cost-lookup";
import { COST_CONFIG } from "./config";

const LOG_PREFIX = "[intelligence]";

// =============================================================================
// State Region Coordinates (approximate center for distance estimation)
// =============================================================================

const STATE_REGIONS: Record<string, { lat: number; lng: number }> = {
  AL: { lat: 32.8, lng: -86.8 },
  AK: { lat: 64.0, lng: -153.0 },
  AZ: { lat: 34.0, lng: -111.0 },
  AR: { lat: 34.8, lng: -92.2 },
  CA: { lat: 37.0, lng: -119.5 },
  CO: { lat: 39.0, lng: -105.5 },
  CT: { lat: 41.6, lng: -72.7 },
  DE: { lat: 39.0, lng: -75.5 },
  FL: { lat: 28.6, lng: -82.4 },
  GA: { lat: 33.0, lng: -83.5 },
  HI: { lat: 20.8, lng: -156.3 },
  ID: { lat: 44.4, lng: -114.7 },
  IL: { lat: 40.0, lng: -89.4 },
  IN: { lat: 39.8, lng: -86.3 },
  IA: { lat: 42.0, lng: -93.5 },
  KS: { lat: 38.5, lng: -98.3 },
  KY: { lat: 37.8, lng: -85.7 },
  LA: { lat: 31.0, lng: -92.0 },
  ME: { lat: 45.4, lng: -69.2 },
  MD: { lat: 39.0, lng: -76.8 },
  MA: { lat: 42.2, lng: -71.8 },
  MI: { lat: 44.3, lng: -84.5 },
  MN: { lat: 46.3, lng: -94.3 },
  MS: { lat: 32.7, lng: -89.7 },
  MO: { lat: 38.4, lng: -92.5 },
  MT: { lat: 47.0, lng: -110.0 },
  NE: { lat: 41.5, lng: -99.8 },
  NV: { lat: 39.5, lng: -116.8 },
  NH: { lat: 43.7, lng: -71.6 },
  NJ: { lat: 40.2, lng: -74.7 },
  NM: { lat: 34.5, lng: -106.0 },
  NY: { lat: 42.9, lng: -75.5 },
  NC: { lat: 35.6, lng: -79.8 },
  ND: { lat: 47.5, lng: -100.5 },
  OH: { lat: 40.4, lng: -82.7 },
  OK: { lat: 35.5, lng: -97.5 },
  OR: { lat: 44.0, lng: -120.5 },
  PA: { lat: 40.9, lng: -77.8 },
  RI: { lat: 41.7, lng: -71.5 },
  SC: { lat: 33.9, lng: -80.9 },
  SD: { lat: 44.4, lng: -100.2 },
  TN: { lat: 35.8, lng: -86.3 },
  TX: { lat: 31.5, lng: -99.3 },
  UT: { lat: 39.3, lng: -111.7 },
  VT: { lat: 44.1, lng: -72.6 },
  VA: { lat: 37.5, lng: -78.9 },
  WA: { lat: 47.4, lng: -120.5 },
  WV: { lat: 38.6, lng: -80.6 },
  WI: { lat: 44.6, lng: -89.8 },
  WY: { lat: 43.0, lng: -107.5 },
};

/**
 * Estimate drive hours between two states using Haversine distance.
 * Assumes average 50 mph driving speed with routing factor of 1.3.
 */
export function estimateDriveHours(fromState: string, toState: string): number {
  const from = STATE_REGIONS[fromState.toUpperCase()];
  const to = STATE_REGIONS[toState.toUpperCase()];

  if (!from || !to) return 999; // Unknown state → effectively infinite distance

  if (fromState.toUpperCase() === toState.toUpperCase()) return 0;

  const R = COST_CONFIG.earthRadiusMiles;
  const dLat = ((to.lat - from.lat) * Math.PI) / 180;
  const dLng = ((to.lng - from.lng) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((from.lat * Math.PI) / 180) *
      Math.cos((to.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distanceMiles = R * c;

  // Apply routing factor (roads aren't straight lines) and divide by avg speed
  return Math.round((distanceMiles * COST_CONFIG.routingFactor) / COST_CONFIG.averageSpeedMph * 10) / 10;
}

// =============================================================================
// Cost Estimation Helpers
// =============================================================================

function estimateCost(
  stateCode: string,
  isResident: boolean,
  driveHours: number | null,
  stateCosts: Map<string, { tagCost: number; licenseCost: number; pointCost: number }>
): CostEstimate {
  // Track whether we hit state-specific fee data or had to fall back to
  // defaults. The UX walkthrough flagged that every recommendation in prod
  // showed the same $1,820 total — that's the all-defaults case, and it's
  // important to label it so users don't read it as a precise quote.
  const stateSpecific = stateCosts.get(stateCode);
  const isExact = !!stateSpecific;
  const costs = stateSpecific ?? {
    tagCost: COST_CONFIG.defaultTagCost,
    licenseCost: COST_CONFIG.defaultLicenseCost,
    pointCost: COST_CONFIG.defaultPointCost,
  };
  const tag = costs.tagCost * (isResident ? COST_CONFIG.residentTagMultiplier : 1);
  const license = costs.licenseCost * (isResident ? COST_CONFIG.residentLicenseMultiplier : 1);
  const points = costs.pointCost;

  // Travel cost: rough estimate based on drive hours
  let travel = COST_CONFIG.defaultTravelCost;
  if (driveHours !== null) {
    for (const tier of COST_CONFIG.travelTiers) {
      if (driveHours <= tier.maxHours) {
        travel = tier.cost;
        break;
      }
    }
  }

  const gear = COST_CONFIG.gearCostPerTrip;

  return {
    tag: Math.round(tag),
    license: Math.round(license),
    points,
    travel,
    gear,
    total: Math.round(tag + license + points + travel + gear),
    isExact,
  };
}

// =============================================================================
// Profile Preference Helpers
// =============================================================================

function getPreferenceValue(
  profile: HunterProfile,
  category: string,
  key: string
): unknown | null {
  const pref = profile.preferences.find(
    (p) => p.category === category && p.key === key
  );
  return pref?.value ?? null;
}

function getPreferenceValues(
  profile: HunterProfile,
  category: string
): Array<{ key: string; value: unknown }> {
  return profile.preferences
    .filter((p) => p.category === category)
    .map((p) => ({ key: p.key, value: p.value }));
}

function getHomeState(profile: HunterProfile): string | null {
  const loc = getPreferenceValue(profile, "location", "home_state");
  return typeof loc === "string" ? loc.toUpperCase() : null;
}

function getTravelTolerance(profile: HunterProfile): string {
  const val = getPreferenceValue(profile, "travel", "travel_tolerance");
  if (typeof val === "string") return val;
  return "regional"; // default
}

function getMaxDriveHours(profile: HunterProfile): number {
  const explicit = getPreferenceValue(profile, "travel", "max_drive_hours");
  if (typeof explicit === "number") return explicit;

  const tolerance = getTravelTolerance(profile);
  return COST_CONFIG.travelToleranceHours[tolerance] ?? COST_CONFIG.defaultTravelToleranceHours;
}

function getBudgetCeiling(profile: HunterProfile): number {
  const val = getPreferenceValue(profile, "budget", "annual_budget");
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const mapped = COST_CONFIG.budgetCeilingMappings[val];
    if (mapped !== undefined) return mapped;
    const parsed = parseInt(val, 10);
    return isNaN(parsed) ? COST_CONFIG.defaultBudgetCeiling : parsed;
  }
  return COST_CONFIG.defaultBudgetCeiling;
}

function getTimeline(profile: HunterProfile): string {
  const val = getPreferenceValue(profile, "timeline", "timeline");
  if (typeof val === "string") return val;
  return "flexible";
}

function getWeaponPreferences(profile: HunterProfile): string[] {
  const val = getPreferenceValue(profile, "weapon", "weapon");
  if (Array.isArray(val)) return val as string[];
  if (typeof val === "string") return [val];
  return []; // no filter = all weapons
}

function getHuntStyle(profile: HunterProfile): string {
  const val = getPreferenceValue(profile, "hunt_style", "diy_preference");
  if (val === true) return "diy";
  const guided = getPreferenceValue(profile, "hunt_style", "guided_interest");
  if (guided === true) return "guided";
  return "any";
}

function getPhysicalAbility(profile: HunterProfile): string {
  const val = getPreferenceValue(profile, "physical", "physical_ability");
  if (typeof val === "string") return val;
  return "moderate";
}

// =============================================================================
// Main Candidate Generator
// =============================================================================

/**
 * Generate hunt candidates by filtering the universe of opportunities
 * against the hunter's hard constraints from their profile.
 */
export async function generateCandidates(
  profile: HunterProfile
): Promise<HuntCandidate[]> {
  console.log(`${LOG_PREFIX} generateCandidates: starting for user ${profile.id}`);

  const stateCosts = await loadStateCosts();
  const filtersApplied: string[] = [];

  // ---- Extract profile constraints ----
  const homeState = getHomeState(profile);
  const maxDriveHours = getMaxDriveHours(profile);
  const budgetCeiling = getBudgetCeiling(profile);
  const timeline = getTimeline(profile);
  const weaponPrefs = getWeaponPreferences(profile);
  const huntStyle = getHuntStyle(profile);
  const physicalAbility = getPhysicalAbility(profile);
  // orientation is resolved downstream in scoring engine, no need to fetch here

  // ---- 1. Get species interests ----
  const speciesInterests = getPreferenceValues(profile, "species_interest");
  const interestedSlugs = speciesInterests
    .filter((s) => s.value === true || s.value === "true")
    .map((s) => s.key);

  if (interestedSlugs.length === 0) {
    console.log(`${LOG_PREFIX} generateCandidates: no species interests, returning empty`);
    return [];
  }
  filtersApplied.push(`species_interest:${interestedSlugs.join(",")}`);

  // ---- 2. Load matching species from DB ----
  const allSpecies = await db
    .select()
    .from(species)
    .where(eq(species.enabled, true));

  const matchingSpecies = allSpecies.filter((s) =>
    interestedSlugs.includes(s.slug)
  );

  if (matchingSpecies.length === 0) {
    console.log(`${LOG_PREFIX} generateCandidates: no matching species found in DB`);
    return [];
  }

  const speciesIds = matchingSpecies.map((s) => s.id);
  const speciesMap = new Map(matchingSpecies.map((s) => [s.id, s]));

  // ---- 3. Load state_species mappings ----
  const stateSpeciesRows = await db
    .select()
    .from(stateSpecies)
    .where(inArray(stateSpecies.speciesId, speciesIds));

  if (stateSpeciesRows.length === 0) {
    console.log(`${LOG_PREFIX} generateCandidates: no state-species mappings found`);
    return [];
  }

  const stateIds = [...new Set(stateSpeciesRows.map((ss) => ss.stateId))];

  // ---- 4. Load all relevant states ----
  const allStates = await db
    .select()
    .from(states)
    .where(and(eq(states.enabled, true), inArray(states.id, stateIds)));

  const stateMap = new Map(allStates.map((s) => [s.id, s]));

  // ---- 5. Filter by travel tolerance ----
  let eligibleStateIds = allStates.map((s) => s.id);
  if (homeState && maxDriveHours < 999) {
    filtersApplied.push(`travel_tolerance:${maxDriveHours}h`);
    eligibleStateIds = allStates
      .filter((s) => {
        const hours = estimateDriveHours(homeState, s.code);
        return hours <= maxDriveHours;
      })
      .map((s) => s.id);

    console.log(
      `${LOG_PREFIX} generateCandidates: ${eligibleStateIds.length}/${allStates.length} states within travel tolerance`
    );
  }

  if (eligibleStateIds.length === 0) {
    console.log(`${LOG_PREFIX} generateCandidates: no states within travel tolerance`);
    return [];
  }

  // ---- 6. Load hunt units for eligible states + species ----
  const eligibleStateSpecies = stateSpeciesRows.filter(
    (ss) => eligibleStateIds.includes(ss.stateId) && speciesIds.includes(ss.speciesId)
  );

  const unitQuery = await db
    .select()
    .from(huntUnits)
    .where(
      and(
        eq(huntUnits.enabled, true),
        inArray(huntUnits.stateId, eligibleStateIds),
        inArray(huntUnits.speciesId, speciesIds)
      )
    );

  // ---- 7. Build candidates ----
  const candidates: HuntCandidate[] = [];
  const currentYear = new Date().getFullYear();

  for (const ss of eligibleStateSpecies) {
    const state = stateMap.get(ss.stateId);
    const sp = speciesMap.get(ss.speciesId);
    if (!state || !sp) continue;

    // Get units for this state+species
    const units = unitQuery.filter(
      (u) => u.stateId === ss.stateId && u.speciesId === ss.speciesId
    );

    // Get available weapon types
    const huntTypes = (Array.isArray(ss.huntTypes) ? ss.huntTypes : []) as string[];

    // ---- 7a. Filter by weapon preference ----
    if (weaponPrefs.length > 0) {
      const hasMatchingWeapon = weaponPrefs.some((wp) =>
        huntTypes.some((ht) => ht.toLowerCase().includes(wp.toLowerCase()))
      );
      if (!hasMatchingWeapon && huntTypes.length > 0) {
        // No matching weapon for this state/species combo
        continue;
      }
    }

    // If there are units, create per-unit candidates; otherwise state-level
    const unitList = units.length > 0 ? units : [null];

    for (const unit of unitList) {
      // ---- 7b. Filter by physical ability ----
      if (
        physicalAbility === "limited" &&
        unit?.terrainClass === "alpine"
      ) {
        filtersApplied.push("physical_ability:excluded_alpine");
        continue;
      }
      if (
        physicalAbility === "limited" &&
        unit?.elevationMax &&
        unit.elevationMax > COST_CONFIG.highElevationCutoff
      ) {
        continue;
      }

      // Calculate drive hours
      const driveHours = homeState
        ? estimateDriveHours(homeState, state.code)
        : null;

      // Estimate cost
      const isResident = homeState === state.code;
      const cost = estimateCost(state.code, isResident, driveHours, stateCosts);

      // ---- 7c. Filter by budget ceiling ----
      if (cost.total > budgetCeiling * COST_CONFIG.budgetCeilingMultiplier) {
        continue;
      }

      // ---- 7d. Get latest draw odds for this unit ----
      let latestDrawOddsRow = null;
      if (unit) {
        const drawOddsRows = await db
          .select()
          .from(drawOdds)
          .where(
            and(
              eq(drawOdds.stateId, ss.stateId),
              eq(drawOdds.speciesId, ss.speciesId),
              eq(drawOdds.huntUnitId, unit.id)
            )
          )
          .limit(1);

        latestDrawOddsRow = drawOddsRows[0] ?? null;
      }

      // ---- 7e. Get latest harvest stats ----
      let latestHarvestRow = null;
      if (unit) {
        const harvestRows = await db
          .select()
          .from(harvestStats)
          .where(
            and(
              eq(harvestStats.stateId, ss.stateId),
              eq(harvestStats.speciesId, ss.speciesId),
              eq(harvestStats.huntUnitId, unit.id)
            )
          )
          .limit(1);

        latestHarvestRow = harvestRows[0] ?? null;
      }

      // ---- 7f. Get season info ----
      let seasonRow = null;
      if (unit) {
        const seasonRows = await db
          .select()
          .from(seasons)
          .where(
            and(
              eq(seasons.stateId, ss.stateId),
              eq(seasons.speciesId, ss.speciesId),
              eq(seasons.huntUnitId, unit.id),
              eq(seasons.year, currentYear)
            )
          )
          .limit(1);
        seasonRow = seasonRows[0] ?? null;
      }

      // ---- 7g. Timeline filter ----
      const tagType = seasonRow?.tagType ?? (ss.hasDraw ? "draw" : "otc");
      const drawRate = latestDrawOddsRow?.drawRate ?? null;

      if (timeline === "this_year") {
        // Only include OTC, high-odds draws, or leftovers
        if (tagType === "draw" && drawRate !== null && drawRate < COST_CONFIG.thisYearMinDrawRate) {
          continue; // Too low odds for this-year timeline
        }
        filtersApplied.push("timeline:this_year");
      }

      // ---- 7h. Hunt style filter ----
      if (huntStyle === "diy" && unit?.publicLandPct !== null) {
        if ((unit?.publicLandPct ?? 0) < COST_CONFIG.diyMinPublicLandPct) {
          continue; // Too little public land for DIY
        }
        filtersApplied.push("hunt_style:diy_public_land");
      }

      // Build the candidate
      const candidate: HuntCandidate = {
        stateId: state.id,
        stateCode: state.code,
        stateName: state.name,
        speciesId: sp.id,
        speciesSlug: sp.slug,
        speciesName: sp.commonName,
        huntUnitId: unit?.id ?? null,
        unitCode: unit?.unitCode ?? null,
        unitName: unit?.unitName ?? null,
        publicLandPct: unit?.publicLandPct ?? null,
        terrainClass: unit?.terrainClass ?? null,
        elevationMin: unit?.elevationMin ?? null,
        elevationMax: unit?.elevationMax ?? null,
        hasDraw: ss.hasDraw,
        hasOtc: ss.hasOtc,
        hasPoints: ss.hasPoints,
        pointType: ss.pointType,
        weaponTypes: huntTypes,
        latestDrawRate: latestDrawOddsRow?.drawRate ?? null,
        latestMinPoints: latestDrawOddsRow?.minPointsDrawn ?? null,
        latestMaxPoints: latestDrawOddsRow?.maxPointsDrawn ?? null,
        latestAvgPoints: latestDrawOddsRow?.avgPointsDrawn ?? null,
        totalApplicants: latestDrawOddsRow?.totalApplicants ?? null,
        totalTags: latestDrawOddsRow?.totalTags ?? null,
        latestSuccessRate: latestHarvestRow?.successRate ?? null,
        trophyMetrics: latestHarvestRow?.trophyMetrics as Record<string, unknown> | null,
        tagType,
        seasonName: seasonRow?.seasonName ?? null,
        seasonStart: seasonRow?.startDate ?? null,
        seasonEnd: seasonRow?.endDate ?? null,
        estimatedCost: cost,
        estimatedDriveHours: driveHours,
        filtersApplied: [...new Set(filtersApplied)],
      };

      candidates.push(candidate);
    }
  }

  // Deduplicate by state+species+unit
  const seen = new Set<string>();
  const deduped = candidates.filter((c) => {
    const key = `${c.stateId}:${c.speciesId}:${c.huntUnitId ?? "state"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(
    `${LOG_PREFIX} generateCandidates: produced ${deduped.length} candidates ` +
      `(from ${candidates.length} raw, filters: ${[...new Set(filtersApplied)].join(", ")})`
  );

  return deduped;
}
