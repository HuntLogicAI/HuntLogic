import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { states } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";

export async function GET() {
  try {
    // speciesCount is a UNION across every table that ties species to a
    // state, so the count reflects "do we have ANY data about this species
    // in this state" rather than just the curated `state_species` metadata
    // table. Without this, every state showed "0 species" in prod even when
    // draw_odds / seasons / hunt_units had years of data — because
    // state_species wasn't fully backfilled.
    const result = await db
      .select({
        id: states.id,
        code: states.code,
        name: states.name,
        region: states.region,
        hasDrawSystem: states.hasDrawSystem,
        hasPointSystem: states.hasPointSystem,
        agencyName: states.agencyName,
        agencyUrl: states.agencyUrl,
        speciesCount: sql<number>`(
          SELECT count(DISTINCT species_id)::int FROM (
            SELECT species_id FROM state_species WHERE state_id = ${states.id}
            UNION
            SELECT species_id FROM draw_odds WHERE state_id = ${states.id}
            UNION
            SELECT species_id FROM harvest_stats WHERE state_id = ${states.id}
            UNION
            SELECT species_id FROM seasons WHERE state_id = ${states.id}
            UNION
            SELECT species_id FROM hunt_units WHERE state_id = ${states.id}
          ) all_species
        )`,
      })
      .from(states)
      .where(eq(states.enabled, true))
      .orderBy(states.name);

    return NextResponse.json({ states: result });
  } catch (error) {
    console.error("[explore/states] Error:", error);
    return NextResponse.json({ error: "Failed to load states" }, { status: 500 });
  }
}
