// =============================================================================
// GET /api/v1/recommendations — List recommendations for user
// POST /api/v1/recommendations — Submit feedback on a recommendation
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  recommendations,
  playbooks,
  states,
  species,
} from "@/lib/db/schema";
import { processRecommendationFeedback } from "@/services/intelligence/feedback-engine";
import type { RecommendationOutput } from "@/services/intelligence/types";

const LOG_PREFIX = "[api:recommendations]";

// =============================================================================
// GET — List recommendations
// =============================================================================

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    // Query params
    const recType = searchParams.get("type"); // apply_now, build_points, otc_opportunity, watch
    const orientation = searchParams.get("orientation"); // trophy, opportunity, balanced, meat, experience
    const stateFilter = searchParams.get("state"); // state code e.g. CO
    const speciesFilter = searchParams.get("species"); // species slug e.g. elk
    const timeline = searchParams.get("timeline"); // this_year, 1-3_years, 3-5_years, 5+_years
    const page = parseInt(searchParams.get("page") ?? "1", 10);
    const limit = Math.min(50, parseInt(searchParams.get("limit") ?? "10", 10));
    const offset = (page - 1) * limit;

    console.log(
      `${LOG_PREFIX} GET: userId=${userId} type=${recType} state=${stateFilter} page=${page}`
    );

    // Find active playbook for this user
    const activePlaybook = await db.query.playbooks.findFirst({
      where: and(eq(playbooks.userId, userId), eq(playbooks.status, "active")),
    });

    if (!activePlaybook) {
      return NextResponse.json({
        recommendations: [],
        total: 0,
        page,
        limit,
        message: "No active playbook found. Generate a playbook first.",
      });
    }

    // Build query — fetch recommendations with joined state/species info
    let query = db
      .select({
        id: recommendations.id,
        playbookId: recommendations.playbookId,
        stateId: recommendations.stateId,
        speciesId: recommendations.speciesId,
        huntUnitId: recommendations.huntUnitId,
        recType: recommendations.recType,
        orientation: recommendations.orientation,
        rank: recommendations.rank,
        score: recommendations.score,
        confidence: recommendations.confidence,
        rationale: recommendations.rationale,
        costEstimate: recommendations.costEstimate,
        timeline: recommendations.timeline,
        drawOddsCtx: recommendations.drawOddsCtx,
        forecastCtx: recommendations.forecastCtx,
        factors: recommendations.factors,
        status: recommendations.status,
        userFeedback: recommendations.userFeedback,
        createdAt: recommendations.createdAt,
        stateCode: states.code,
        stateName: states.name,
        speciesSlug: species.slug,
        speciesName: species.commonName,
      })
      .from(recommendations)
      .innerJoin(states, eq(recommendations.stateId, states.id))
      .innerJoin(species, eq(recommendations.speciesId, species.id))
      .where(
        and(
          eq(recommendations.playbookId, activePlaybook.id),
          eq(recommendations.userId, userId)
        )
      )
      .orderBy(recommendations.rank)
      .$dynamic();

    // Fetch all and filter in memory (Drizzle dynamic where composition is limited)
    const allRecs = await query;

    let filtered = allRecs;

    if (recType) {
      filtered = filtered.filter((r) => r.recType === recType);
    }
    if (orientation) {
      filtered = filtered.filter((r) => r.orientation === orientation);
    }
    if (stateFilter) {
      filtered = filtered.filter(
        (r) => r.stateCode.toUpperCase() === stateFilter.toUpperCase()
      );
    }
    if (speciesFilter) {
      filtered = filtered.filter(
        (r) => r.speciesSlug === speciesFilter.toLowerCase()
      );
    }
    if (timeline) {
      filtered = filtered.filter((r) => r.timeline === timeline);
    }

    // Dedupe duplicates at the (state, species, recType, timeline) level —
    // the playbook generator can occasionally write two near-identical rows
    // when candidate generation produces overlapping unit-less hunts. The
    // higher-ranked (lower `rank` integer) row wins; the rest drop out.
    const seen = new Map<string, (typeof filtered)[number]>();
    for (const r of filtered) {
      const key = `${r.stateId}|${r.speciesId}|${r.recType}|${r.timeline ?? ""}|${r.huntUnitId ?? ""}`;
      const existing = seen.get(key);
      if (!existing || (r.rank ?? 999) < (existing.rank ?? 999)) {
        seen.set(key, r);
      }
    }
    const deduped = Array.from(seen.values()).sort(
      (a, b) => (a.rank ?? 999) - (b.rank ?? 999),
    );

    const total = deduped.length;
    const paginated = deduped.slice(offset, offset + limit);

    // Format response
    const responseRecs: RecommendationOutput[] = paginated.map((rec) => ({
      id: rec.id,
      hunt: {
        stateId: rec.stateId,
        stateCode: rec.stateCode,
        stateName: rec.stateName,
        speciesId: rec.speciesId,
        speciesSlug: rec.speciesSlug,
        speciesName: rec.speciesName,
        huntUnitId: rec.huntUnitId,
        unitCode: null,
        unitName: null,
        publicLandPct: null,
        terrainClass: null,
        elevationMin: null,
        elevationMax: null,
        hasDraw: rec.recType !== "otc_opportunity",
        hasOtc: rec.recType === "otc_opportunity",
        hasPoints: ["apply_now", "build_points", "watch"].includes(rec.recType),
        pointType: null,
        weaponTypes: [],
        latestDrawRate: (rec.drawOddsCtx as Record<string, unknown>)?.drawRate as number | null ?? null,
        latestMinPoints: (rec.drawOddsCtx as Record<string, unknown>)?.minPoints as number | null ?? null,
        latestMaxPoints: (rec.drawOddsCtx as Record<string, unknown>)?.maxPoints as number | null ?? null,
        latestAvgPoints: (rec.drawOddsCtx as Record<string, unknown>)?.avgPoints as number | null ?? null,
        totalApplicants: null,
        totalTags: null,
        latestSuccessRate: (rec.forecastCtx as Record<string, unknown>)?.successRate as number | null ?? null,
        trophyMetrics: null,
        tagType: rec.recType === "otc_opportunity" ? "otc" : "draw",
        seasonName: null,
        seasonStart: null,
        seasonEnd: null,
        estimatedCost: rec.costEstimate as RecommendationOutput["costEstimate"],
        estimatedDriveHours: null,
        filtersApplied: [],
        factors: rec.factors as RecommendationOutput["hunt"]["factors"],
        weightsUsed: {
          draw_odds: 0.2,
          trophy_quality: 0.15,
          success_rate: 0.15,
          cost_efficiency: 0.15,
          access: 0.1,
          forecast: 0.1,
          personal_fit: 0.1,
          timeline_fit: 0.05,
        },
        compositeScore: rec.score ?? 0,
        rank: rec.rank ?? 0,
        confidence: {
          score: rec.confidence ?? 0.5,
          label: (rec.confidence ?? 0.5) >= 0.7 ? "high" : (rec.confidence ?? 0.5) >= 0.4 ? "medium" : "low",
          basis: "Loaded from saved recommendation data.",
        },
        timelineCategory: (rec.timeline ?? "1-3_years") as RecommendationOutput["hunt"]["timelineCategory"],
        recType: rec.recType as RecommendationOutput["hunt"]["recType"],
      },
      rationale: rec.rationale ?? "",
      costEstimate: rec.costEstimate as RecommendationOutput["costEstimate"],
      timelineEstimate: { earliest: "", expected: "", latest: "" },
      confidence: {
        score: rec.confidence ?? 0.5,
        label: (rec.confidence ?? 0.5) >= 0.7 ? "high" : (rec.confidence ?? 0.5) >= 0.4 ? "medium" : "low",
        basis: "Loaded from saved recommendation data.",
      },
      forecast: (rec.forecastCtx as RecommendationOutput["forecast"]) ?? undefined,
      orientation: (rec.orientation ?? "balanced") as RecommendationOutput["orientation"],
      status: (rec.status ?? "active") as RecommendationOutput["status"],
    }));

    return NextResponse.json({
      recommendations: responseRecs,
      total,
      page,
      limit,
      playbookId: activePlaybook.id,
      playbookVersion: activePlaybook.version,
    });
  } catch (error) {
    console.error(`${LOG_PREFIX} GET error:`, error);
    return NextResponse.json(
      { error: "Failed to fetch recommendations" },
      { status: 500 }
    );
  }
}

// =============================================================================
// POST — Submit feedback on a recommendation
// =============================================================================

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { recommendationId, feedback } = body;

    if (!recommendationId || !feedback) {
      return NextResponse.json(
        { error: "recommendationId and feedback are required" },
        { status: 400 }
      );
    }

    if (!["like", "dislike", "save"].includes(feedback)) {
      return NextResponse.json(
        { error: "feedback must be one of: like, dislike, save" },
        { status: 400 }
      );
    }

    console.log(
      `${LOG_PREFIX} POST feedback: userId=${userId} recId=${recommendationId} feedback=${feedback}`
    );

    // Map legacy feedback values to feedback engine actions
    const actionMap: Record<string, "save" | "dismiss" | "like" | "dislike"> = {
      save: "save",
      like: "like",
      dislike: "dislike",
    };
    const action = actionMap[feedback]!;

    // Process feedback: updates recommendation status AND adjusts preference weights
    const result = await processRecommendationFeedback({
      userId,
      recommendationId,
      action,
    });

    if (!result.success) {
      return NextResponse.json(
        { error: "Recommendation not found" },
        { status: 404 }
      );
    }

    const newStatus = action === "save" || action === "like" ? "saved" : "dismissed";

    return NextResponse.json({
      success: true,
      recommendationId,
      feedback,
      status: newStatus,
      preferencesAdjusted: result.adjustments,
    });
  } catch (error) {
    console.error(`${LOG_PREFIX} POST error:`, error);
    return NextResponse.json(
      { error: "Failed to submit feedback" },
      { status: 500 }
    );
  }
}
