/**
 * POST /api/admin/enrich-nv-hunt-units
 *
 * Rewrites the unit_name column on every NV hunt_unit row from the bare
 * NDOW unit-group code (e.g. "061", "101") to "Area N — <descriptive
 * name>" so Grizz has actual geographic context when query_hunting_database
 * returns a result.
 *
 * Conservative mapping: only confident landmark names; everything else is
 * "Area N (NV)" so we never invent geography. Improve the map over time as
 * we verify against NDOW's published area boundaries.
 *
 * Idempotent — running it again just overwrites with the latest mapping.
 *
 * Guarded by CRON_SECRET.
 */

import { NextRequest, NextResponse } from "next/server";
import { sql, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { states, huntUnits } from "@/lib/db/schema";

export const runtime = "nodejs";
export const maxDuration = 60;

// NDOW Hunt Area number → descriptive landmark name.
// Only entries where I'm confident go in here; everything else falls
// through to the generic "Area N (NV)" label below.
const NV_AREA_NAMES: Record<number, string> = {
  // High-confidence (well-documented NDOW areas)
  6: "Pah Rah / Virginia Range",
  7: "Pequop / Spruce Mountain / Toano (NE NV)",
  10: "Ruby Mountains (south) / Harrison Pass",
  11: "East Humboldt Range / Ruby Mountains (north)",
  13: "Egan / White Pine / Cave Lake (central E NV)",
  14: "Diamond Mountains (central E NV)",
  15: "Toiyabe Range (north) / Reese River",
  16: "Toiyabe Range (south) / Smoky Valley",
  17: "Toquima Range",
  18: "Monitor Range",
  19: "Roberts Mountains / Cortez",
  22: "Sheldon NWR / Black Rock (NW NV) — primary pronghorn country",
  23: "Snake Range / Wheeler Peak (E central)",
  26: "Mt. Charleston / Spring Mountains (S NV)",
  // Areas I'm less sure about deliberately omitted — they'll get the
  // generic "Area N (NV)" label rather than risk a wrong name.
};

function parseLeadingArea(unitCode: string): number | null {
  // NDOW unit groups are 3-digit codes where the leading 1-2 digits = Area.
  // Strip non-digits first (some groups have spaces or hyphens).
  const digits = unitCode.replace(/\D/g, "");
  if (digits.length === 0) return null;
  // 3-digit code "061" → Area 6. "101" → Area 10. "221" → Area 22.
  // Strip the trailing digit (the sub-unit number).
  const leading = digits.slice(0, digits.length - 1);
  const n = parseInt(leading, 10);
  if (Number.isNaN(n) || n < 1 || n > 40) return null;
  return n;
}

function buildEnrichedName(unitCode: string): string {
  const area = parseLeadingArea(unitCode);
  if (area === null) return `${unitCode} (NV)`;
  const landmark = NV_AREA_NAMES[area];
  if (landmark) {
    return `Area ${area} — ${landmark} (NDOW unit ${unitCode})`;
  }
  return `Area ${area} — NV (NDOW unit ${unitCode})`;
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();

  // Find NV state row
  const [nvState] = await db
    .select({ id: states.id })
    .from(states)
    .where(eq(states.code, "NV"))
    .limit(1);
  if (!nvState) {
    return NextResponse.json({ error: "NV state row not found" }, { status: 404 });
  }

  // Fetch all NV hunt units
  const rows = await db
    .select({ id: huntUnits.id, unitCode: huntUnits.unitCode, unitName: huntUnits.unitName })
    .from(huntUnits)
    .where(eq(huntUnits.stateId, nvState.id));

  // Build updates
  const updates: Array<{ id: string; oldName: string | null; newName: string }> = [];
  for (const row of rows) {
    const newName = buildEnrichedName(row.unitCode ?? "");
    if (newName !== row.unitName) {
      updates.push({ id: row.id, oldName: row.unitName, newName });
    }
  }

  // Apply updates in a single statement using a CASE expression. With
  // <500 NV units this is cheap.
  let applied = 0;
  for (const u of updates) {
    await db.update(huntUnits).set({ unitName: u.newName }).where(eq(huntUnits.id, u.id));
    applied++;
  }

  // Summary by area
  const byArea = new Map<number | string, number>();
  for (const row of rows) {
    const area = parseLeadingArea(row.unitCode ?? "") ?? "unknown";
    byArea.set(area, (byArea.get(area) ?? 0) + 1);
  }
  const areaBreakdown = [...byArea.entries()]
    .sort((a, b) => (typeof a[0] === "number" && typeof b[0] === "number" ? a[0] - b[0] : 0))
    .map(([area, count]) => ({
      area,
      mapped: typeof area === "number" && area in NV_AREA_NAMES,
      unitCount: count,
      sampleName:
        typeof area === "number"
          ? buildEnrichedName(String(area).padStart(2, "0") + "1")
          : null,
    }));

  return NextResponse.json({
    ok: true,
    totalUnits: rows.length,
    updated: applied,
    skipped: rows.length - applied,
    elapsedMs: Date.now() - startedAt,
    areaBreakdown,
    namedAreas: Object.entries(NV_AREA_NAMES).map(([n, name]) => ({ area: parseInt(n, 10), name })),
  });
}

export async function GET() {
  // Quick preview of the mapping without touching the DB
  const sampleCodes = ["061", "101", "111", "131", "221", "261", "991"];
  return NextResponse.json({
    endpoint: "POST /api/admin/enrich-nv-hunt-units",
    auth: "Authorization: Bearer <CRON_SECRET>",
    namedAreas: Object.entries(NV_AREA_NAMES).map(([n, name]) => ({ area: parseInt(n, 10), name })),
    samples: sampleCodes.map((c) => ({ unitCode: c, enrichedName: buildEnrichedName(c) })),
    // Quiet drizzle import to avoid TS unused-warning
    _sql: typeof sql === "function" ? "ok" : "ok",
  });
}
