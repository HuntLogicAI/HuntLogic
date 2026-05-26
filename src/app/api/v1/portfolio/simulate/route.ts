/**
 * POST /api/v1/portfolio/simulate
 *
 * Personalized portfolio simulation. Given a user's point holdings + goals,
 * returns multi-year draw probability projections for each (state × species)
 * track plus a portfolio-level summary.
 *
 * Two input modes:
 *   1. Authenticated: omit `holdings` and we pull from the user's
 *      `pointHoldings` table.
 *   2. Anonymous / explicit: pass `holdings` array directly. Useful for
 *      Grizz to call with a hypothetical portfolio.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { pointHoldings, states, species } from "@/lib/db/schema";
import { simulatePortfolio } from "@/lib/portfolio/engine";
import type { PointHolding, SimulateRequest } from "@/lib/portfolio/types";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  let body: Partial<SimulateRequest>;
  try {
    body = (await request.json()) as Partial<SimulateRequest>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let holdings: PointHolding[] = body.holdings ?? [];

  // If holdings weren't provided explicitly, try pulling from the
  // authenticated user's pointHoldings table.
  if (holdings.length === 0) {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error:
            "No holdings provided and you're not signed in. Either pass `holdings: [{ stateCode, speciesSlug, points }]` or sign in to use your saved point portfolio.",
        },
        { status: 400 },
      );
    }

    const rows = await db
      .select({
        stateCode: states.code,
        speciesSlug: species.slug,
        points: pointHoldings.points,
        pointType: pointHoldings.pointType,
      })
      .from(pointHoldings)
      .innerJoin(states, eq(pointHoldings.stateId, states.id))
      .innerJoin(species, eq(pointHoldings.speciesId, species.id))
      .where(eq(pointHoldings.userId, session.user.id));

    holdings = rows.map((r) => ({
      stateCode: r.stateCode,
      speciesSlug: r.speciesSlug,
      points: r.points,
      pointType: r.pointType as PointHolding["pointType"],
    }));
  }

  if (holdings.length === 0) {
    return NextResponse.json(
      {
        error:
          "No point holdings found for this user. Add holdings to your profile or pass them explicitly in the request body.",
      },
      { status: 400 },
    );
  }

  const goals = body.goals ?? {
    priority: "balanced" as const,
    patienceYears: 10,
  };

  try {
    const response = await simulatePortfolio({
      holdings,
      goals,
      horizonYears: body.horizonYears ?? 10,
      speciesFocus: body.speciesFocus,
    });
    return NextResponse.json(response);
  } catch (err) {
    console.error("[portfolio:simulate] error:", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

export async function GET() {
  return NextResponse.json({
    endpoint: "POST /api/v1/portfolio/simulate",
    body: {
      holdings: "[{ stateCode, speciesSlug, points, pointType? }] — optional if signed in",
      goals: "{ priority: 'trophy' | 'balanced' | 'annual_hunt', patienceYears: number, annualBudgetUsd?: number }",
      horizonYears: "default 10",
      speciesFocus: "optional array of slugs to filter",
    },
    example: {
      holdings: [
        { stateCode: "NV", speciesSlug: "elk", points: 7, pointType: "bonus" },
        { stateCode: "WY", speciesSlug: "mule_deer", points: 6, pointType: "preference" },
      ],
      goals: { priority: "trophy", patienceYears: 10, annualBudgetUsd: 8000 },
    },
  });
}
