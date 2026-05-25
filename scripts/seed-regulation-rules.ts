/**
 * CLI seed for structured regulation rules.
 *
 * Run with: DATABASE_URL=... npx tsx scripts/seed-regulation-rules.ts
 *
 * Most of the time you should hit POST /api/admin/seed-regulation-rules
 * instead — it runs the same seed against prod DB from inside Vercel,
 * so you don't need to handle DATABASE_URL locally. This CLI is for
 * dev/local DB only.
 *
 * Rule data lives in src/lib/db/seed-data/regulation-rules-data.ts so
 * the CLI and the API route stay in sync.
 */

import postgres from "postgres";
import {
  STATE_REGULATION_RULES,
  REGULATION_RULES_YEAR,
} from "../src/lib/db/seed-data/regulation-rules-data";

const sql = postgres(process.env.DATABASE_URL!);

async function seedRegulationRules() {
  const stateCodes = Object.keys(STATE_REGULATION_RULES);

  const stateRows = await sql`
    SELECT id, code FROM states WHERE code = ANY(${stateCodes})
  `;
  const stateMap = new Map<string, string>();
  for (const row of stateRows) stateMap.set(row.code, row.id);
  console.log(`[seed:rules] Resolved ${stateMap.size} state IDs:`, [...stateMap.keys()]);

  const speciesSlugs = new Set<string>();
  for (const rules of Object.values(STATE_REGULATION_RULES)) {
    for (const rule of rules) if (rule.species) speciesSlugs.add(rule.species);
  }
  const speciesRows = await sql`
    SELECT id, slug FROM species WHERE slug = ANY(${[...speciesSlugs]})
  `;
  const speciesMap = new Map<string, string>();
  for (const row of speciesRows) speciesMap.set(row.slug, row.id);
  console.log(`[seed:rules] Resolved ${speciesMap.size} species IDs:`, [...speciesMap.keys()]);

  let totalInserted = 0;
  let totalDeleted = 0;

  for (const [stateCode, rules] of Object.entries(STATE_REGULATION_RULES)) {
    const stateId = stateMap.get(stateCode);
    if (!stateId) {
      console.warn(`[seed:rules] State ${stateCode} not found, skipping ${rules.length} rules`);
      continue;
    }

    const deleted = await sql`
      DELETE FROM state_regulation_rules WHERE state_id = ${stateId}
    `;
    totalDeleted += deleted.count;

    for (const rule of rules) {
      const speciesId = rule.species ? speciesMap.get(rule.species) ?? null : null;
      if (rule.species && !speciesId) {
        console.warn(`[seed:rules] ${stateCode}: species '${rule.species}' not found, skipping rule ${rule.ruleType}`);
        continue;
      }

      await sql`
        INSERT INTO state_regulation_rules (
          state_id, species_id, rule_type, season_type, weapon_type,
          value, zone_scope, effective_year, source_url, source_quote, notes
        ) VALUES (
          ${stateId},
          ${speciesId},
          ${rule.ruleType},
          ${rule.seasonType ?? null},
          ${rule.weaponType ?? null},
          ${sql.json(rule.value)},
          ${rule.zoneScope ?? "statewide"},
          ${rule.effectiveYear ?? REGULATION_RULES_YEAR},
          ${rule.sourceUrl ?? null},
          ${rule.sourceQuote ?? null},
          ${rule.notes ?? null}
        )
      `;
      totalInserted++;
    }
    console.log(`[seed:rules] ${stateCode}: deleted ${deleted.count} old, inserted ${rules.length} new`);
  }

  console.log(`\n[seed:rules] Done. Deleted ${totalDeleted} stale rules, inserted ${totalInserted} fresh rules across ${stateMap.size} states.`);

  await sql.end();
}

seedRegulationRules().catch((err) => {
  console.error("[seed:rules] Failed:", err);
  process.exit(1);
});
