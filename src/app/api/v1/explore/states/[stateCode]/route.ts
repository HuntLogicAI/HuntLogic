import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { states, species, stateSpecies } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ stateCode: string }> }
) {
  try {
    const { stateCode } = await params;

    const state = await db.query.states.findFirst({
      where: eq(states.code, stateCode.toUpperCase()),
    });

    if (!state) {
      return NextResponse.json({ error: "State not found" }, { status: 404 });
    }

    // First: pull the canonical curated state_species metadata.
    const curated = await db
      .select({
        stateCode: states.code,
        stateName: states.name,
        speciesId: species.id,
        speciesSlug: species.slug,
        speciesName: species.commonName,
        hasDraw: stateSpecies.hasDraw,
        hasOtc: stateSpecies.hasOtc,
        hasPoints: stateSpecies.hasPoints,
        pointType: stateSpecies.pointType,
        huntTypes: stateSpecies.huntTypes,
      })
      .from(stateSpecies)
      .innerJoin(states, eq(stateSpecies.stateId, states.id))
      .innerJoin(species, eq(stateSpecies.speciesId, species.id))
      .where(eq(stateSpecies.stateId, state.id));

    const curatedSpeciesIds = new Set(curated.map((r) => r.speciesId));

    // Then: derive any species we have observational data for that aren't
    // in the curated metadata yet. This lets the UI surface "yes, we know
    // about CO elk" even when the state_species seed is incomplete.
    const derived = await db
      .select({
        speciesId: species.id,
        speciesSlug: species.slug,
        speciesName: species.commonName,
        hasDrawData: sql<boolean>`EXISTS (
          SELECT 1 FROM draw_odds
          WHERE draw_odds.state_id = ${state.id}
            AND draw_odds.species_id = species.id
        )`,
        hasSeasons: sql<boolean>`EXISTS (
          SELECT 1 FROM seasons
          WHERE seasons.state_id = ${state.id}
            AND seasons.species_id = species.id
        )`,
        hasUnits: sql<boolean>`EXISTS (
          SELECT 1 FROM hunt_units
          WHERE hunt_units.state_id = ${state.id}
            AND hunt_units.species_id = species.id
        )`,
      })
      .from(species)
      .where(
        sql`EXISTS (
          SELECT 1 FROM draw_odds
          WHERE draw_odds.state_id = ${state.id}
            AND draw_odds.species_id = species.id
        ) OR EXISTS (
          SELECT 1 FROM harvest_stats
          WHERE harvest_stats.state_id = ${state.id}
            AND harvest_stats.species_id = species.id
        ) OR EXISTS (
          SELECT 1 FROM seasons
          WHERE seasons.state_id = ${state.id}
            AND seasons.species_id = species.id
        ) OR EXISTS (
          SELECT 1 FROM hunt_units
          WHERE hunt_units.state_id = ${state.id}
            AND hunt_units.species_id = species.id
        )`,
      );

    // Build the merged response. Curated entries win; derived-only species
    // are appended with conservative defaults (hasDraw derived from
    // draw_odds presence; everything else null/false).
    const merged = [
      ...curated.map((r) => ({
        stateCode: r.stateCode,
        stateName: r.stateName,
        speciesSlug: r.speciesSlug,
        speciesName: r.speciesName,
        hasDraw: r.hasDraw,
        hasOtc: r.hasOtc,
        hasPoints: r.hasPoints,
        pointType: r.pointType,
        huntTypes: r.huntTypes,
      })),
      ...derived
        .filter((r) => !curatedSpeciesIds.has(r.speciesId))
        .map((r) => ({
          stateCode: state.code,
          stateName: state.name,
          speciesSlug: r.speciesSlug,
          speciesName: r.speciesName,
          hasDraw: r.hasDrawData,
          hasOtc: false,
          hasPoints: false,
          pointType: null as string | null,
          huntTypes: [] as string[],
        })),
    ];

    return NextResponse.json({
      state: {
        code: state.code,
        name: state.name,
        region: state.region,
        agencyName: state.agencyName,
        agencyUrl: state.agencyUrl,
      },
      species: merged,
    });
  } catch (error) {
    console.error("[explore/states/detail] Error:", error);
    return NextResponse.json({ error: "Failed to load state details" }, { status: 500 });
  }
}
