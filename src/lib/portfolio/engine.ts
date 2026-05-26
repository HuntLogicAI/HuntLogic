/**
 * Portfolio engine entry point.
 *
 * Given a user's point holdings + goals, returns multi-year projections
 * for each (state × species) track, plus a portfolio-level summary.
 *
 * Pulls real agency data from `drawOdds` to ground each projection where
 * available; falls back to generic defaults where data is missing.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { drawOdds, huntUnits, species, states } from "@/lib/db/schema";
import { projectTrack, buildPortfolioNarrative, type AgencyDataForTrack } from "./projection";
import type {
  SimulateRequest,
  SimulateResponse,
  PortfolioTrack,
  PointHolding,
} from "./types";

/**
 * Run the simulation for the given request.
 *
 * Pulls drawOdds rows per (state × species) from the DB, computes the
 * agency-data summary, then calls projectTrack for each holding.
 */
export async function simulatePortfolio(
  request: SimulateRequest,
): Promise<SimulateResponse> {
  const horizonYears = request.horizonYears ?? 10;
  const baseYear = new Date().getFullYear();
  const tracks: PortfolioTrack[] = [];

  // Filter holdings by speciesFocus if provided
  const focused = request.speciesFocus && request.speciesFocus.length > 0
    ? request.holdings.filter((h) =>
        request.speciesFocus!.includes(h.speciesSlug),
      )
    : request.holdings;

  for (const holding of focused) {
    const agency = await fetchAgencyDataForTrack(holding);
    const track = projectTrack(holding, agency, horizonYears, baseYear);
    tracks.push(track);
  }

  // Portfolio-level summary
  const firstExpectedDrawYear = tracks
    .map((t) => t.expectedDrawYear)
    .filter((y): y is number => y !== null)
    .sort((a, b) => a - b)[0] ?? null;

  // Expected tags = sum of probability-of-drawing-at-least-once across tracks
  const expectedTagsWithinHorizon = tracks.reduce((sum, t) => {
    const lastP = t.projections[t.projections.length - 1]?.cumulativeDrawPct ?? 0;
    return sum + lastP / 100;
  }, 0);

  const narrative = buildPortfolioNarrative(tracks, request.goals);

  return {
    goals: request.goals,
    horizonYears,
    tracks,
    summary: {
      firstExpectedDrawYear,
      expectedTagsWithinHorizon: Math.round(expectedTagsWithinHorizon * 10) / 10,
      narrative,
    },
    disclaimers: [
      "Projections assume current draw structure, quotas, and applicant pool hold. State agencies can change any of these year-to-year.",
      "Point creep is modeled at a default rate of +0.4 pts/yr where agency-observed rates aren't available. Top-tier units run higher (0.6-1.0+); OTC-adjacent run lower.",
      "Cumulative probabilities assume the hunter applies every year. Skipped years extend the timeline (and disproportionately so for squared-bonus systems).",
      "Pure-random states (NM, ID) have point-independent odds — past applications don't compound. Cumulative probability still rises because you get more 'tries' over time, not because your individual-year odds improve.",
      "Recommendations are projections, not guarantees. Verify quotas, deadlines, and current rules with the state agency before applying.",
    ],
  };
}

/**
 * Pull the most-recent agency draw data for a state × species, aggregated
 * to a single AgencyDataForTrack summary. Picks the most-applied-for unit
 * as the representative case.
 */
async function fetchAgencyDataForTrack(
  holding: PointHolding,
): Promise<AgencyDataForTrack> {
  // Resolve state + species IDs
  const [stateRow] = await db
    .select({ id: states.id })
    .from(states)
    .where(eq(states.code, holding.stateCode))
    .limit(1);
  if (!stateRow) {
    return defaultAgencyData(`no ${holding.stateCode} state row in DB`);
  }

  const [speciesRow] = await db
    .select({ id: species.id })
    .from(species)
    .where(eq(species.slug, holding.speciesSlug))
    .limit(1);
  if (!speciesRow) {
    return defaultAgencyData(`no '${holding.speciesSlug}' species in DB`);
  }

  // Pick the most-applied-for unit for this state × species × NR residency
  // as the "representative trophy unit" the hunter would target.
  const candidates = await db
    .select({
      huntUnitId: drawOdds.huntUnitId,
      totalApplicants: drawOdds.totalApplicants,
      totalTags: drawOdds.totalTags,
      drawRate: drawOdds.drawRate,
      minPointsDrawn: drawOdds.minPointsDrawn,
      year: drawOdds.year,
    })
    .from(drawOdds)
    .where(
      and(
        eq(drawOdds.stateId, stateRow.id),
        eq(drawOdds.speciesId, speciesRow.id),
        eq(drawOdds.residentType, "nonresident"),
      ),
    )
    .orderBy(sql`${drawOdds.totalApplicants} desc nulls last`)
    .limit(5);

  if (candidates.length === 0) {
    return defaultAgencyData(
      `no draw_odds rows for ${holding.stateCode} ${holding.speciesSlug}`,
    );
  }

  // Pick the highest-applicant row that also has a numeric drawRate and minPointsDrawn
  // (more informative for projection). Otherwise fall back to first.
  const representative =
    candidates.find(
      (c) =>
        c.totalApplicants != null &&
        c.drawRate != null &&
        c.minPointsDrawn != null,
    ) ?? candidates[0];

  // Try to surface a hunt unit name for the source label
  let unitLabel = "";
  if (representative.huntUnitId) {
    const [unit] = await db
      .select({ name: huntUnits.unitName, code: huntUnits.unitCode })
      .from(huntUnits)
      .where(eq(huntUnits.id, representative.huntUnitId))
      .limit(1);
    if (unit) unitLabel = ` (representative: ${unit.code})`;
  }

  return {
    quota: representative.totalTags ?? null,
    totalApplicants: representative.totalApplicants ?? null,
    drawnAtMinPoints: representative.minPointsDrawn ?? null,
    observedPointCreepRate: 0.4, // TODO: derive from year-over-year data once we have multi-year history
    sourceLabel: `${holding.stateCode} draw_odds year ${representative.year}${unitLabel}`,
  };
}

function defaultAgencyData(reason: string): AgencyDataForTrack {
  return {
    quota: null,
    totalApplicants: null,
    drawnAtMinPoints: null,
    observedPointCreepRate: 0.4,
    sourceLabel: `generic default (${reason})`,
  };
}
