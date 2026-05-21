// =============================================================================
// GET /api/v1/dashboard/this-weekend
// =============================================================================
// "What can I hunt this weekend?" — surfaces OTC + open-season hunts near the
// user's home state for the upcoming weekend (today + next 3 days). Used by
// the dashboard activation widget.
//
// Data sources (in order of preference):
//   1. seasons table — for season_start <= today + 7d AND season_end >= today
//   2. state_species table — to flag OTC vs draw
//   3. user profile — to filter to user's home state + neighbors
//
// We deliberately return a small number (5) and keep the response light;
// the widget is meant to be glanceable, not browsable.
// =============================================================================

import { NextResponse } from "next/server";
import { and, eq, sql, gte, lte, or } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  seasons,
  states,
  species,
  stateSpecies,
  huntUnits,
} from "@/lib/db/schema";
import { getProfile } from "@/services/profile";

interface WeekendOpportunity {
  stateCode: string;
  stateName: string;
  speciesSlug: string;
  speciesName: string;
  seasonName: string | null;
  weaponType: string | null;
  tagType: "draw" | "otc" | "leftover" | "unknown";
  seasonStart: string | null;
  seasonEnd: string | null;
  daysRemaining: number | null;
  isHomeState: boolean;
  isOtc: boolean;
  publicLandPct: number | null;
  // Why we picked this: short rationale string for the card subtitle.
  rationale: string;
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Compute the "this weekend" window: today through 7 days out.
  const today = new Date();
  const todayIso = today.toISOString().split("T")[0]!;
  const sevenDaysOut = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0]!;

  // Load the user's profile to learn home state.
  let homeStateCode: string | null = null;
  try {
    const profile = await getProfile(session.user.id);
    const homePref = profile.preferences.find(
      (p) => p.category === "location" && p.key === "home_state",
    );
    if (typeof homePref?.value === "string") {
      homeStateCode = homePref.value.toUpperCase();
    }
  } catch (err) {
    console.warn("[this-weekend] profile load failed (continuing):", err);
  }

  // Pull active or imminent seasons.
  const rows = await db
    .select({
      seasonId: seasons.id,
      seasonName: seasons.seasonName,
      weaponType: seasons.weaponType,
      tagType: seasons.tagType,
      seasonStart: seasons.startDate,
      seasonEnd: seasons.endDate,
      stateCode: states.code,
      stateName: states.name,
      speciesSlug: species.slug,
      speciesName: species.commonName,
      isOtc: stateSpecies.hasOtc,
      publicLandPct: huntUnits.publicLandPct,
    })
    .from(seasons)
    .innerJoin(states, eq(seasons.stateId, states.id))
    .innerJoin(species, eq(seasons.speciesId, species.id))
    // state_species is sometimes-sparse — leftJoin so we still get rows even
    // when the metadata table hasn't been seeded for this combination.
    .leftJoin(
      stateSpecies,
      and(
        eq(stateSpecies.stateId, seasons.stateId),
        eq(stateSpecies.speciesId, seasons.speciesId),
      ),
    )
    .leftJoin(huntUnits, eq(seasons.huntUnitId, huntUnits.id))
    .where(
      and(
        // Open right now: start <= today + 7d AND end >= today.
        lte(seasons.startDate, sevenDaysOut),
        gte(seasons.endDate, todayIso),
        // Prefer OTC for the "this weekend" use case — these are
        // hunts a hunter can actually go on without a draw cycle.
        // We still keep general/leftover; just down-rank pure-draw.
        or(
          eq(seasons.tagType, "otc"),
          eq(seasons.tagType, "leftover"),
          // Allow draw too — many states call general-season "draw"
          // even when nonresidents can buy over-the-counter equivalents.
          sql`${seasons.tagType} IS NULL OR ${seasons.tagType} = 'draw'`,
        ),
      ),
    )
    .limit(60);

  // Score + dedupe at the (state, species, season_name) level.
  type Scored = WeekendOpportunity & { _score: number; _key: string };
  const seen = new Map<string, Scored>();

  for (const r of rows) {
    const isHomeState =
      !!homeStateCode && r.stateCode.toUpperCase() === homeStateCode;
    const isOtc = !!r.isOtc || r.tagType === "otc" || r.tagType === "leftover";
    const endDate = r.seasonEnd ? new Date(r.seasonEnd) : null;
    const startDate = r.seasonStart ? new Date(r.seasonStart) : null;
    const daysRemaining = endDate
      ? Math.max(
          0,
          Math.ceil(
            (endDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000),
          ),
        )
      : null;
    const daysUntilStart = startDate
      ? Math.max(
          0,
          Math.ceil(
            (startDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000),
          ),
        )
      : null;

    // Score: home state +50, OTC +30, season already open +15, recent
    // public land bonus, longer remaining window +10.
    let score = 0;
    if (isHomeState) score += 50;
    if (isOtc) score += 30;
    if (daysUntilStart === 0) score += 15;
    if ((r.publicLandPct ?? 0) >= 50) score += 10;
    if ((daysRemaining ?? 0) >= 30) score += 5;

    // Rationale string for the card subtitle.
    const rationaleBits: string[] = [];
    if (isHomeState) rationaleBits.push("in your home state");
    if (isOtc) rationaleBits.push("OTC");
    if (daysUntilStart === 0 && daysRemaining !== null)
      rationaleBits.push(`open now, ${daysRemaining}d left`);
    else if (daysUntilStart !== null && daysUntilStart > 0)
      rationaleBits.push(`opens in ${daysUntilStart}d`);
    if ((r.publicLandPct ?? 0) >= 50)
      rationaleBits.push(`${Math.round(r.publicLandPct ?? 0)}% public land`);
    const rationale =
      rationaleBits.length > 0 ? rationaleBits.join(" · ") : "Season open";

    const key = `${r.stateCode}|${r.speciesSlug}|${r.seasonName ?? ""}`;
    const candidate: Scored = {
      _score: score,
      _key: key,
      stateCode: r.stateCode,
      stateName: r.stateName,
      speciesSlug: r.speciesSlug,
      speciesName: r.speciesName,
      seasonName: r.seasonName,
      weaponType: r.weaponType,
      tagType: ((r.tagType as WeekendOpportunity["tagType"]) ?? "unknown"),
      seasonStart: r.seasonStart,
      seasonEnd: r.seasonEnd,
      daysRemaining,
      isHomeState,
      isOtc,
      publicLandPct: r.publicLandPct ?? null,
      rationale,
    };

    const existing = seen.get(key);
    if (!existing || candidate._score > existing._score) {
      seen.set(key, candidate);
    }
  }

  const ranked = Array.from(seen.values())
    .sort((a, b) => b._score - a._score)
    .slice(0, 5)
    .map(({ _score: _s, _key: _k, ...rest }) => {
      void _s;
      void _k;
      return rest as WeekendOpportunity;
    });

  return NextResponse.json({
    opportunities: ranked,
    homeState: homeStateCode,
    window: { from: todayIso, to: sevenDaysOut },
  });
}
