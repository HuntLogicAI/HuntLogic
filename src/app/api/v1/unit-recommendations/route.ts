// =============================================================================
// POST /api/v1/unit-recommendations — Unit-level ranking engine
//
// Given a state, species, motivation, weapon, points, and residency,
// returns the top 10 units ranked by a composite score.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { eq, and, desc, sql, max } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  drawOdds,
  harvestStats,
  huntUnits,
  states,
  species,
  stateSpecies,
} from "@/lib/db/schema";

// =============================================================================
// Types
// =============================================================================

type Motivation = "trophy" | "meat" | "balanced" | "otl";
type WeaponType = "rifle" | "archery" | "muzzleloader" | "any";
type ResidentType = "resident" | "nonresident";
type Tier = "A" | "B" | "C";

interface UnitRecommendationRequest {
  stateCode: string;
  speciesSlug: string;
  motivation: Motivation;
  weaponType: WeaponType;
  currentPoints: number;
  residentType: ResidentType;
}

interface PointCreepProjection {
  estimatedYearsToDraw: number;
  confidence: "high" | "medium" | "low";
  trend: "increasing" | "stable" | "decreasing";
}

interface UnitRecommendationResult {
  unitCode: string;
  drawRate: number | null;
  drawRatePct: string;
  minPointsDrawn: number | null;
  successRate: number | null;
  successRatePct: string;
  totalApplicants: number | null;
  totalTags: number | null;
  weaponType: string;
  score: number;
  tier: Tier;
  canDrawNow: boolean;
  recommendation: string;
  year: number;
  pointCreep?: PointCreepProjection;
  alternatives?: UnitRecommendationResult[];
}

// =============================================================================
// Motivation Weight Config
// =============================================================================

interface MotivationWeights {
  successRate: number;
  drawRate: number;
  minPointsPenalty: number;
  prestige: number;
  drawRateBonus: { threshold: number; bonus: number };
  favorDrawable: boolean;
}

const MOTIVATION_WEIGHTS: Record<Motivation, MotivationWeights> = {
  meat: {
    successRate: 0.6,
    drawRate: 0.3,
    minPointsPenalty: 0.1,
    prestige: 0.0,
    drawRateBonus: { threshold: 0.15, bonus: 0.05 },
    favorDrawable: false,
  },
  trophy: {
    successRate: 0.4,
    drawRate: 0.2,
    minPointsPenalty: 0.1,
    prestige: 0.3,
    drawRateBonus: { threshold: 0, bonus: 0 },
    favorDrawable: true,
  },
  otl: {
    successRate: 0.3,
    drawRate: 0.15,
    minPointsPenalty: 0.25,
    prestige: 0.3,
    drawRateBonus: { threshold: 0, bonus: 0 },
    favorDrawable: true,
  },
  balanced: {
    successRate: 0.35,
    drawRate: 0.25,
    minPointsPenalty: 0.1,
    prestige: 0.15,
    drawRateBonus: { threshold: 0.15, bonus: 0.03 },
    favorDrawable: true,
  },
};

const TOP_N = 10;
const LOG_PREFIX = "[api:unit-recommendations]";

// =============================================================================
// Validation
// =============================================================================

const VALID_MOTIVATIONS = new Set<string>(["trophy", "meat", "balanced", "otl"]);
const VALID_WEAPONS = new Set<string>(["rifle", "archery", "muzzleloader", "any"]);
const VALID_RESIDENCY = new Set<string>(["resident", "nonresident"]);

function validateBody(
  body: unknown
): { ok: true; data: UnitRecommendationRequest } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object" };
  }

  const b = body as Record<string, unknown>;

  if (typeof b["stateCode"] !== "string" || b["stateCode"].length < 2) {
    return { ok: false, error: "stateCode is required (e.g. 'NV')" };
  }
  if (typeof b["speciesSlug"] !== "string" || b["speciesSlug"].length < 2) {
    return { ok: false, error: "speciesSlug is required (e.g. 'mule_deer')" };
  }
  if (typeof b["motivation"] !== "string" || !VALID_MOTIVATIONS.has(b["motivation"])) {
    return { ok: false, error: "motivation must be one of: trophy, meat, balanced, otl" };
  }

  const weaponType = b["weaponType"];
  if (weaponType !== undefined && (typeof weaponType !== "string" || !VALID_WEAPONS.has(weaponType))) {
    return { ok: false, error: "weaponType must be one of: rifle, archery, muzzleloader, any" };
  }

  const currentPoints = b["currentPoints"];
  if (currentPoints !== undefined && typeof currentPoints !== "number") {
    return { ok: false, error: "currentPoints must be a number" };
  }

  const residentType = b["residentType"];
  if (residentType !== undefined && (typeof residentType !== "string" || !VALID_RESIDENCY.has(residentType))) {
    return { ok: false, error: "residentType must be 'resident' or 'nonresident'" };
  }

  return {
    ok: true,
    data: {
      stateCode: (b["stateCode"] as string).toUpperCase(),
      speciesSlug: (b["speciesSlug"] as string).toLowerCase(),
      motivation: b["motivation"] as Motivation,
      weaponType: (weaponType as WeaponType | undefined) ?? "any",
      currentPoints: (currentPoints as number | undefined) ?? 0,
      residentType: (residentType as ResidentType | undefined) ?? "nonresident",
    },
  };
}

// =============================================================================
// POST handler
// =============================================================================

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    const body: unknown = await request.json();
    const validation = validateBody(body);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const {
      stateCode,
      speciesSlug,
      motivation,
      weaponType,
      currentPoints,
      residentType,
    } = validation.data;

    console.log(
      `${LOG_PREFIX} POST: user=${session.user.id} state=${stateCode} species=${speciesSlug} motivation=${motivation}`
    );

    // -- Resolve state and species IDs --
    const stateRow = await db
      .select({ id: states.id })
      .from(states)
      .where(eq(states.code, stateCode))
      .limit(1);

    const stateId = stateRow[0]?.id;
    if (!stateId) {
      return NextResponse.json(
        { error: `State '${stateCode}' not found` },
        { status: 404 }
      );
    }

    const speciesRow = await db
      .select({ id: species.id })
      .from(species)
      .where(eq(species.slug, speciesSlug))
      .limit(1);

    const speciesId = speciesRow[0]?.id;
    if (!speciesId) {
      return NextResponse.json(
        { error: `Species '${speciesSlug}' not found` },
        { status: 404 }
      );
    }

    // -- Resolve dynamic PRIMARY_YEAR from draw_odds data --
    const yearRow = await db
      .select({ maxYear: max(drawOdds.year) })
      .from(drawOdds)
      .where(eq(drawOdds.stateId, stateId))
      .limit(1);

    const PRIMARY_YEAR = yearRow[0]?.maxYear ?? new Date().getFullYear();

    // -- Check if this species has OTC in this state (for freezer/meat scoring) --
    const otcRow = await db
      .select({ hasOtc: stateSpecies.hasOtc })
      .from(stateSpecies)
      .where(
        and(
          eq(stateSpecies.stateId, stateId),
          eq(stateSpecies.speciesId, speciesId),
        )
      )
      .limit(1);

    const isOtcSpecies = otcRow[0]?.hasOtc ?? false;

    // -- Fetch draw odds with unit join --
    // Try primary year first, then fall back to most recent
    const drawRows = await db
      .select({
        huntUnitId: drawOdds.huntUnitId,
        unitCode: huntUnits.unitCode,
        year: drawOdds.year,
        drawRate: drawOdds.drawRate,
        minPointsDrawn: drawOdds.minPointsDrawn,
        totalApplicants: drawOdds.totalApplicants,
        totalTags: drawOdds.totalTags,
        weaponType: drawOdds.weaponType,
        residentType: drawOdds.residentType,
      })
      .from(drawOdds)
      .innerJoin(huntUnits, eq(drawOdds.huntUnitId, huntUnits.id))
      .where(
        and(
          eq(drawOdds.stateId, stateId),
          eq(drawOdds.speciesId, speciesId),
          eq(drawOdds.residentType, residentType)
        )
      )
      .orderBy(desc(drawOdds.year));

    if (drawRows.length === 0) {
      return NextResponse.json({
        results: [],
        meta: {
          stateCode,
          speciesSlug,
          motivation,
          weaponType,
          residentType,
          currentPoints,
          message: "No draw odds data found for this state/species/residency combination",
        },
      });
    }

    // -- Determine the best year available --
    const availableYears = [...new Set(drawRows.map((r) => r.year))].sort(
      (a, b) => b - a
    );
    const targetYear =
      availableYears.includes(PRIMARY_YEAR)
        ? PRIMARY_YEAR
        : availableYears[0] ?? PRIMARY_YEAR;

    // -- Filter to target year --
    let yearRows = drawRows.filter((r) => r.year === targetYear);

    // -- Filter by weapon type --
    if (weaponType !== "any") {
      const filtered = yearRows.filter((r) => {
        const wt = r.weaponType?.toLowerCase() ?? "";
        return wt.includes(weaponType);
      });
      if (filtered.length > 0) {
        yearRows = filtered;
      }
      // If no match after filtering, keep all (graceful fallback)
    }

    // -- Aggregate per unit (take best row per unit — highest draw rate if multiple weapon/choice combos) --
    const unitMap = new Map<
      string,
      {
        unitCode: string;
        drawRate: number | null;
        minPointsDrawn: number | null;
        totalApplicants: number | null;
        totalTags: number | null;
        weaponType: string;
        year: number;
      }
    >();

    for (const row of yearRows) {
      if (!row.huntUnitId || !row.unitCode) continue;

      const existing = unitMap.get(row.huntUnitId);
      const rowDrawRate = row.drawRate ?? 0;
      const existingDrawRate = existing?.drawRate ?? -1;

      // Keep the row with the highest draw rate per unit
      if (!existing || rowDrawRate > existingDrawRate) {
        unitMap.set(row.huntUnitId, {
          unitCode: row.unitCode,
          drawRate: row.drawRate,
          minPointsDrawn: row.minPointsDrawn,
          totalApplicants: row.totalApplicants,
          totalTags: row.totalTags,
          weaponType: row.weaponType ?? "unknown",
          year: row.year,
        });
      }
    }

    // -- Fetch harvest stats for these units --
    const unitIds = [...unitMap.keys()];
    const harvestRows =
      unitIds.length > 0
        ? await db
            .select({
              huntUnitId: harvestStats.huntUnitId,
              successRate: harvestStats.successRate,
              trophyMetrics: harvestStats.trophyMetrics,
              year: harvestStats.year,
            })
            .from(harvestStats)
            .where(
              and(
                eq(harvestStats.stateId, stateId),
                eq(harvestStats.speciesId, speciesId),
                sql`${harvestStats.huntUnitId} = ANY(${sql`ARRAY[${sql.join(
                  unitIds.map((id) => sql`${id}::uuid`),
                  sql`, `
                )}]`})`
              )
            )
            .orderBy(desc(harvestStats.year))
        : [];

    // Build success rate map and trophy metrics map: unit -> most recent data
    const successMap = new Map<string, number>();
    interface TrophyMetricsData {
      avgBcScore?: number;
      maturePercent?: number;
      [key: string]: unknown;
    }
    const trophyMetricsMap = new Map<string, TrophyMetricsData>();
    for (const row of harvestRows) {
      if (row.huntUnitId && !successMap.has(row.huntUnitId)) {
        if (row.successRate !== null) {
          successMap.set(row.huntUnitId, row.successRate);
        }
        if (row.trophyMetrics && typeof row.trophyMetrics === "object") {
          trophyMetricsMap.set(row.huntUnitId, row.trophyMetrics as TrophyMetricsData);
        }
      }
    }

    // -- Compute prestige normalization --
    // prestige_score = (totalApplicants / totalTags) normalized across all units
    const prestigeRaw: { unitId: string; ratio: number }[] = [];
    for (const [unitId, data] of unitMap) {
      const apps = data.totalApplicants ?? 0;
      const tags = data.totalTags ?? 1;
      if (apps > 0 && tags > 0) {
        prestigeRaw.push({ unitId, ratio: apps / tags });
      }
    }

    const maxPrestige = prestigeRaw.length > 0
      ? Math.max(...prestigeRaw.map((p) => p.ratio))
      : 1;
    const prestigeMap = new Map<string, number>();
    for (const p of prestigeRaw) {
      prestigeMap.set(p.unitId, maxPrestige > 0 ? p.ratio / maxPrestige : 0);
    }

    // -- Score each unit --
    const weights = MOTIVATION_WEIGHTS[motivation];
    const userPoints = currentPoints ?? 0;

    interface ScoredUnit {
      unitId: string;
      unitCode: string;
      drawRate: number | null;
      minPointsDrawn: number | null;
      successRate: number | null;
      totalApplicants: number | null;
      totalTags: number | null;
      weaponType: string;
      score: number;
      canDrawNow: boolean;
      year: number;
    }

    const scored: ScoredUnit[] = [];

    for (const [unitId, data] of unitMap) {
      const dr = data.drawRate;
      const sr = successMap.get(unitId) ?? null;
      const minPts = data.minPointsDrawn;
      const prestige = prestigeMap.get(unitId) ?? 0;

      // Normalize factors to 0-1
      const drawRateScore = dr ?? 0;
      const successRateScore = sr ?? 0;

      // Min points penalty: lower min points = better (inverted)
      // Normalize: if minPts is 0, score = 1.0; if minPts is high, score approaches 0
      const minPtsVal = minPts ?? 0;
      const minPointsScore = minPtsVal === 0 ? 1.0 : Math.max(0, 1.0 - minPtsVal / 20);

      // Composite score
      let score =
        weights.successRate * successRateScore +
        weights.drawRate * drawRateScore +
        weights.minPointsPenalty * minPointsScore +
        weights.prestige * prestige;

      // Trophy metrics bonus for trophy/otl motivations
      if (motivation === "trophy" || motivation === "otl") {
        const tm = trophyMetricsMap.get(unitId);
        if (tm) {
          // Normalize avgBcScore: typical B&C elk ~300-400, deer ~150-200
          // Use a simple 0-1 normalization with reasonable ceiling
          if (tm.avgBcScore != null && tm.avgBcScore > 0) {
            const bcNorm = Math.min(tm.avgBcScore / 400, 1.0);
            score += 0.08 * bcNorm;
          }
          // maturePercent: 0-1 already, boost units with mature animals
          if (tm.maturePercent != null && tm.maturePercent > 0) {
            score += 0.05 * tm.maturePercent;
          }
        }
      }

      // OTC boost for meat/freezer motivation
      if (motivation === "meat" && isOtcSpecies) {
        score += 0.08;
      }

      // Bonus for easy-to-draw units (meat motivation)
      if (weights.drawRateBonus.threshold > 0 && dr !== null && dr > weights.drawRateBonus.threshold) {
        score += weights.drawRateBonus.bonus;
      }

      // Favor drawable units for trophy/otl/balanced
      const canDrawNow = minPts === null || minPts === 0 || userPoints >= minPts;
      if (weights.favorDrawable && canDrawNow && minPts !== null && minPts > 0) {
        score += 0.05;
      }

      // Clamp
      score = Math.min(1.0, Math.max(0, score));

      scored.push({
        unitId,
        unitCode: data.unitCode,
        drawRate: dr,
        minPointsDrawn: minPts,
        successRate: sr,
        totalApplicants: data.totalApplicants,
        totalTags: data.totalTags,
        weaponType: data.weaponType,
        score: Math.round(score * 1000) / 1000,
        canDrawNow,
        year: data.year,
      });
    }

    // -- Sort by score descending, take top N --
    scored.sort((a, b) => b.score - a.score);
    const topUnits = scored.slice(0, TOP_N);

    // -- Assign tiers, point creep, and generate recommendations --
    const results: UnitRecommendationResult[] = [];

    for (let idx = 0; idx < topUnits.length; idx++) {
      const unit = topUnits[idx]!;
      const tier: Tier = idx < 3 ? "A" : idx < 7 ? "B" : "C";

      // Point creep projection
      const pointCreep = await getPointCreepProjection(
        stateId,
        speciesId,
        unit.unitId,
        userPoints,
        residentType,
      );

      const recommendation = generateRecommendation(
        unit,
        motivation,
        userPoints,
        tier,
        pointCreep,
      );

      // Find 2-3 alternative units: same state, similar draw rate, different weapon or nearby score
      const unitDrawRate = unit.drawRate ?? 0;
      const alternatives: UnitRecommendationResult[] = scored
        .filter((alt) =>
          alt.unitId !== unit.unitId &&
          Math.abs((alt.drawRate ?? 0) - unitDrawRate) < 0.2 &&
          !topUnits.some((t) => t.unitId === alt.unitId)
        )
        .slice(0, 3)
        .map((alt) => {
          const altTier: Tier = alt.score >= 0.7 ? "A" : alt.score >= 0.4 ? "B" : "C";
          return {
            unitCode: alt.unitCode,
            drawRate: alt.drawRate,
            drawRatePct: alt.drawRate !== null ? `${(alt.drawRate * 100).toFixed(1)}%` : "N/A",
            minPointsDrawn: alt.minPointsDrawn,
            successRate: alt.successRate,
            successRatePct: alt.successRate !== null ? `${Math.round(alt.successRate * 100)}%` : "N/A",
            totalApplicants: alt.totalApplicants,
            totalTags: alt.totalTags,
            weaponType: alt.weaponType,
            score: alt.score,
            tier: altTier,
            canDrawNow: alt.canDrawNow,
            recommendation: `Alternative to Unit ${unit.unitCode} with similar draw odds.`,
            year: alt.year,
          };
        });

      results.push({
        unitCode: unit.unitCode,
        drawRate: unit.drawRate,
        drawRatePct: unit.drawRate !== null ? `${(unit.drawRate * 100).toFixed(1)}%` : "N/A",
        minPointsDrawn: unit.minPointsDrawn,
        successRate: unit.successRate,
        successRatePct: unit.successRate !== null ? `${Math.round(unit.successRate * 100)}%` : "N/A",
        totalApplicants: unit.totalApplicants,
        totalTags: unit.totalTags,
        weaponType: unit.weaponType,
        score: unit.score,
        tier,
        canDrawNow: unit.canDrawNow,
        recommendation,
        year: unit.year,
        ...(pointCreep ? { pointCreep } : {}),
        ...(alternatives.length > 0 ? { alternatives } : {}),
      });
    }

    console.log(
      `${LOG_PREFIX} POST: returning ${results.length} units for ${stateCode}/${speciesSlug} (year=${targetYear})`
    );

    return NextResponse.json({
      results,
      meta: {
        stateCode,
        speciesSlug,
        motivation,
        weaponType,
        residentType,
        currentPoints: userPoints,
        year: targetYear,
        totalUnitsEvaluated: unitMap.size,
      },
    });
  } catch (error) {
    console.error(`${LOG_PREFIX} POST error:`, error);
    return NextResponse.json(
      { error: "Failed to generate unit recommendations" },
      { status: 500 }
    );
  }
}

// =============================================================================
// Point Creep Projection
// =============================================================================

async function getPointCreepProjection(
  stateId: string,
  speciesId: string,
  huntUnitId: string,
  currentPoints: number,
  residentType: string,
): Promise<PointCreepProjection | null> {
  try {
    // Fetch 3-5 years of minPointsDrawn for this unit
    const rows = await db
      .select({
        year: drawOdds.year,
        minPointsDrawn: drawOdds.minPointsDrawn,
      })
      .from(drawOdds)
      .where(
        and(
          eq(drawOdds.stateId, stateId),
          eq(drawOdds.speciesId, speciesId),
          eq(drawOdds.huntUnitId, huntUnitId),
          eq(drawOdds.residentType, residentType),
        )
      )
      .orderBy(desc(drawOdds.year))
      .limit(5);

    const validRows = rows.filter((r) => r.minPointsDrawn != null);
    if (validRows.length < 2) return null;

    // Calculate slope using linear regression on (year, minPointsDrawn)
    const points: { x: number; y: number }[] = validRows.map((r) => ({
      x: r.year,
      y: r.minPointsDrawn!,
    }));

    const n = points.length;
    const sumX = points.reduce((s, p) => s + p.x, 0);
    const sumY = points.reduce((s, p) => s + p.y, 0);
    const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
    const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);

    const denom = n * sumXX - sumX * sumX;
    if (denom === 0) return null;

    const slope = (n * sumXY - sumX * sumY) / denom;
    const latestMin = validRows[0]!.minPointsDrawn!;

    // Determine trend
    const trend: PointCreepProjection["trend"] =
      slope > 0.3 ? "increasing" : slope < -0.3 ? "decreasing" : "stable";

    // Estimate years to draw
    let estimatedYearsToDraw: number;
    if (currentPoints >= latestMin) {
      estimatedYearsToDraw = 0;
    } else if (slope <= 0) {
      // Points are stable or decreasing — deficit / 1 point per year
      estimatedYearsToDraw = Math.max(1, latestMin - currentPoints);
    } else {
      // Point creep: need to account for increasing threshold
      // Solve: currentPoints + years >= latestMin + slope * years
      // years * (1 - slope) >= latestMin - currentPoints
      const effectiveRate = 1 - slope;
      if (effectiveRate <= 0) {
        estimatedYearsToDraw = 99; // Can never catch up
      } else {
        estimatedYearsToDraw = Math.ceil((latestMin - currentPoints) / effectiveRate);
      }
    }

    // Confidence based on data coverage
    const confidence: PointCreepProjection["confidence"] =
      validRows.length >= 4 ? "high" : validRows.length >= 3 ? "medium" : "low";

    return {
      estimatedYearsToDraw: Math.max(0, estimatedYearsToDraw),
      confidence,
      trend,
    };
  } catch {
    return null;
  }
}

// =============================================================================
// Recommendation sentence generator
// =============================================================================

function generateRecommendation(
  unit: { drawRate: number | null; successRate: number | null; minPointsDrawn: number | null; canDrawNow: boolean },
  motivation: Motivation,
  userPoints: number,
  tier: Tier,
  pointCreep?: PointCreepProjection | null,
): string {
  const drPct = unit.drawRate !== null ? Math.round(unit.drawRate * 100) : null;
  const srPct = unit.successRate !== null ? Math.round(unit.successRate * 100) : null;
  const minPts = unit.minPointsDrawn ?? 0;

  // Point creep suffix
  const creepSuffix = pointCreep && pointCreep.estimatedYearsToDraw > 0
    ? ` Point trend: ${pointCreep.trend}. ~${pointCreep.estimatedYearsToDraw} year${pointCreep.estimatedYearsToDraw === 1 ? "" : "s"} to draw.`
    : "";

  if (motivation === "meat") {
    if (unit.canDrawNow && srPct !== null && srPct >= 40) {
      return `Strong meat-hunter pick with ${srPct}% success rate and realistic draw odds.${creepSuffix}`;
    }
    if (srPct !== null && srPct >= 30) {
      return `Solid success rate (${srPct}%) makes this a reliable harvest unit.${creepSuffix}`;
    }
    return `Worth considering for a meat hunt${drPct !== null ? ` with ${drPct}% draw odds` : ""}.${creepSuffix}`;
  }

  if (motivation === "trophy" || motivation === "otl") {
    if (unit.canDrawNow && tier === "A") {
      return `Top-tier trophy unit you can draw now with ${userPoints} points${srPct ? ` and ${srPct}% success` : ""}.${creepSuffix}`;
    }
    if (!unit.canDrawNow && minPts > 0) {
      const deficit = minPts - userPoints;
      const creepNote = pointCreep
        ? ` Point trend: ${pointCreep.trend} (~${pointCreep.estimatedYearsToDraw}yr to draw).`
        : "";
      return `Premium unit requiring ~${deficit} more point${deficit === 1 ? "" : "s"} to draw — high demand for a reason.${creepNote}`;
    }
    return `High-quality unit${drPct !== null ? ` with ${drPct}% draw odds` : ""} worth your consideration.${creepSuffix}`;
  }

  // balanced
  if (unit.canDrawNow && srPct !== null && srPct >= 30) {
    return `Well-rounded unit: drawable now with ${srPct}% success and ${drPct ?? "N/A"}% odds.${creepSuffix}`;
  }
  // Bug fix: previous copy could produce "Balanced pick at 0% draw odds and
  // 100% success" — statistically impossible (you can't have 100% success
  // without ever drawing a tag), which strongly implies thin/bad source data.
  // Detect the contradiction and flag it rather than claiming a "pick".
  if (drPct === 0 && srPct !== null && srPct > 0) {
    return `Data flag: this unit shows ${srPct}% historical success but a 0% draw rate — likely a sparse or stale source row. Treat with skepticism until the next data refresh.${creepSuffix}`;
  }
  if (drPct === null && srPct === null) {
    return `Not enough data yet to give a confident pick on this unit. Once we have draw odds and harvest stats it will move into the ranking.${creepSuffix}`;
  }
  return `Balanced pick${drPct !== null ? ` at ${drPct}% draw odds` : ""}${srPct !== null ? ` and ${srPct}% success` : ""}.${creepSuffix}`;
}
