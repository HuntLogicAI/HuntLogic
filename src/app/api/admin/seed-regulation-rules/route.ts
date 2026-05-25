/**
 * POST /api/admin/seed-regulation-rules
 *
 * Populates the state_regulation_rules table for the top 10 hunting states.
 * Idempotent: deletes all rules for each state before re-inserting.
 *
 * Guarded by CRON_SECRET — same auth pattern as the cron routes.
 *
 * Usage:
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     https://app-chi-rust-81.vercel.app/api/admin/seed-regulation-rules
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  states,
  species,
  stateRegulationRules,
} from "@/lib/db/schema";
import {
  STATE_REGULATION_RULES,
  REGULATION_RULES_YEAR,
} from "@/lib/db/seed-data/regulation-rules-data";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  // Auth check — matches the cron pattern in src/app/api/cron/deadlines/route.ts
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const stateCodes = Object.keys(STATE_REGULATION_RULES);
  const startedAt = Date.now();

  // Resolve state IDs
  const stateRows = await db
    .select({ id: states.id, code: states.code })
    .from(states)
    .where(inArray(states.code, stateCodes));
  const stateMap = new Map<string, string>();
  for (const row of stateRows) stateMap.set(row.code, row.id);

  // Resolve all species slugs we reference across every state
  const speciesSlugs = new Set<string>();
  for (const rules of Object.values(STATE_REGULATION_RULES)) {
    for (const rule of rules) if (rule.species) speciesSlugs.add(rule.species);
  }
  const speciesRows = await db
    .select({ id: species.id, slug: species.slug })
    .from(species)
    .where(inArray(species.slug, [...speciesSlugs]));
  const speciesMap = new Map<string, string>();
  for (const row of speciesRows) speciesMap.set(row.slug, row.id);

  const perStateResults: Array<{
    state: string;
    deleted: number;
    inserted: number;
    skipped: string[];
  }> = [];

  for (const [stateCode, rules] of Object.entries(STATE_REGULATION_RULES)) {
    const stateId = stateMap.get(stateCode);
    if (!stateId) {
      perStateResults.push({ state: stateCode, deleted: 0, inserted: 0, skipped: ["state_not_found"] });
      continue;
    }

    // Idempotent: wipe before re-insert
    const deletedResult = await db
      .delete(stateRegulationRules)
      .where(eq(stateRegulationRules.stateId, stateId));
    const deleted = (deletedResult as unknown as { rowCount?: number }).rowCount ?? 0;

    const skipped: string[] = [];
    let inserted = 0;

    for (const rule of rules) {
      const speciesId = rule.species ? (speciesMap.get(rule.species) ?? null) : null;
      if (rule.species && !speciesId) {
        skipped.push(`${rule.ruleType}:species=${rule.species}`);
        continue;
      }

      await db.insert(stateRegulationRules).values({
        stateId,
        speciesId: speciesId ?? undefined,
        ruleType: rule.ruleType,
        seasonType: rule.seasonType ?? undefined,
        weaponType: rule.weaponType ?? undefined,
        value: rule.value,
        zoneScope: rule.zoneScope ?? "statewide",
        effectiveYear: rule.effectiveYear ?? REGULATION_RULES_YEAR,
        sourceUrl: rule.sourceUrl ?? undefined,
        sourceQuote: rule.sourceQuote ?? undefined,
        notes: rule.notes ?? undefined,
      });
      inserted++;
    }

    perStateResults.push({ state: stateCode, deleted, inserted, skipped });
  }

  const totalDeleted = perStateResults.reduce((s, r) => s + r.deleted, 0);
  const totalInserted = perStateResults.reduce((s, r) => s + r.inserted, 0);
  const elapsedMs = Date.now() - startedAt;

  return NextResponse.json({
    ok: true,
    statesProcessed: perStateResults.length,
    totalDeleted,
    totalInserted,
    elapsedMs,
    perState: perStateResults,
  });
}

// GET returns a friendly status hint
export async function GET() {
  // Use a raw COUNT(*) to give a quick state of the table
  const countRows = await db.execute<{
    state_code: string;
    rule_count: number;
  }>(drizzleSql`
    SELECT s.code AS state_code, COUNT(r.id)::int AS rule_count
    FROM ${stateRegulationRules} r
    JOIN ${states} s ON s.id = r.state_id
    GROUP BY s.code
    ORDER BY s.code
  `);
  const rows = (countRows as unknown as { rows?: Array<{ state_code: string; rule_count: number }> })
    .rows ?? (countRows as unknown as Array<{ state_code: string; rule_count: number }>);

  return NextResponse.json({
    endpoint: "POST /api/admin/seed-regulation-rules",
    auth: "Authorization: Bearer <CRON_SECRET>",
    currentRowsByState: rows,
  });
}
