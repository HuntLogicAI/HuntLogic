// =============================================================================
// Regulation Snapshot Service
// =============================================================================
// Takes a freshly-fetched regulation document and produces a versioned
// snapshot. If a snapshot already exists for the same (state, doc_type, year)
// and the content hash matches, this is a no-op (idempotent re-ingest).
// Otherwise, a new snapshot is created, the previous one is marked
// "superseded", and a denormalized diff is written to `regulation_changes`
// so the concierge can surface "what changed since last year".
// =============================================================================

import { createHash } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  regulationSnapshots,
  regulationChanges,
} from "@/lib/db/schema";

const LOG_PREFIX = "[regulations:snapshot]";

export interface SnapshotInput {
  stateId: string;
  speciesId?: string | null;
  year: number;
  docType: string;
  title: string;
  url?: string | null;
  sourceUrl?: string | null;
  // The full canonical text of the document (already stripped of
  // boilerplate so the hash is stable across cosmetic agency edits).
  canonicalText: string;
  // Structured rules extracted from the document.
  extractedRules?: Record<string, unknown>;
  sourceId?: string | null;
}

export interface SnapshotResult {
  snapshotId: string;
  isNew: boolean; // true if the hash didn't already exist for this slot
  changesDetected: number;
}

/**
 * SHA-256 of the canonical text. Used as the content-addressable key for
 * snapshots — two ingestions of the same doc produce the same hash even if
 * the file was re-downloaded.
 */
export function hashContent(canonicalText: string): string {
  return createHash("sha256").update(canonicalText, "utf8").digest("hex");
}

/**
 * Canonicalize free text so cosmetic agency edits (whitespace, page
 * headers, last-modified stamps) don't produce false-positive deltas.
 * Conservative — only strips boilerplate that's known-meaningless.
 */
export function canonicalizeText(text: string): string {
  return (
    text
      // Normalize whitespace
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      // Drop common per-page headers/footers (e.g. "Page 12 of 47"), incl.
      // the trailing newline so we don't leave a blank line behind.
      .replace(/^\s*Page\s+\d+\s+of\s+\d+\s*\n?/gim, "")
      // Drop "Last updated YYYY-MM-DD" stamps
      .replace(/Last\s+updated:?\s+\d{4}-\d{2}-\d{2}/gi, "")
      // Drop printed-on timestamps
      .replace(/Printed\s+on:?\s+\d{1,2}\/\d{1,2}\/\d{2,4}/gi, "")
      .trim()
  );
}

/**
 * Walk two extracted-rules objects and produce a list of diff records.
 * This is intentionally simple — recursive walk by key path. The output
 * is good enough for the concierge to say "quota for unit X dropped 30%".
 */
export function diffExtractedRules(
  fromRules: Record<string, unknown>,
  toRules: Record<string, unknown>,
  pathPrefix = ""
): Array<{
  fieldPath: string;
  oldValue: unknown;
  newValue: unknown;
}> {
  const diffs: Array<{
    fieldPath: string;
    oldValue: unknown;
    newValue: unknown;
  }> = [];

  const allKeys = new Set([
    ...Object.keys(fromRules ?? {}),
    ...Object.keys(toRules ?? {}),
  ]);

  for (const key of allKeys) {
    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    const oldVal = fromRules?.[key];
    const newVal = toRules?.[key];

    const bothObjects =
      oldVal !== null &&
      newVal !== null &&
      typeof oldVal === "object" &&
      typeof newVal === "object" &&
      !Array.isArray(oldVal) &&
      !Array.isArray(newVal);

    if (bothObjects) {
      diffs.push(
        ...diffExtractedRules(
          oldVal as Record<string, unknown>,
          newVal as Record<string, unknown>,
          path
        )
      );
      continue;
    }

    // Stable JSON comparison
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      diffs.push({ fieldPath: path, oldValue: oldVal, newValue: newVal });
    }
  }

  return diffs;
}

/**
 * Heuristic classifier — map a diff field path to a (change_type, severity).
 * Lets the concierge prioritize "quota cut 30%" over "URL formatting fix".
 */
export function classifyDiff(
  fieldPath: string,
  oldValue: unknown,
  newValue: unknown
): { changeType: string; severity: "critical" | "high" | "medium" | "low" } {
  const lowered = fieldPath.toLowerCase();

  if (lowered.includes("quota") || lowered.includes("tags")) {
    // Magnitude-aware: big quota cuts are critical, small are medium.
    if (
      typeof oldValue === "number" &&
      typeof newValue === "number" &&
      oldValue > 0
    ) {
      const pctChange = Math.abs(newValue - oldValue) / oldValue;
      if (pctChange >= 0.25) return { changeType: "quota_change", severity: "critical" };
      if (pctChange >= 0.1) return { changeType: "quota_change", severity: "high" };
      return { changeType: "quota_change", severity: "medium" };
    }
    return { changeType: "quota_change", severity: "medium" };
  }
  if (lowered.includes("season") || lowered.includes("date")) {
    return { changeType: "season_dates", severity: "high" };
  }
  if (lowered.includes("fee") || lowered.includes("cost") || lowered.includes("price")) {
    return { changeType: "fee_change", severity: "medium" };
  }
  if (lowered.includes("weapon") || lowered.includes("caliber") || lowered.includes("broadhead")) {
    return { changeType: "weapon_rule", severity: "high" };
  }
  if (lowered.includes("deadline")) {
    return { changeType: "deadline_change", severity: "critical" };
  }
  if (lowered.includes("point") || lowered.includes("preference") || lowered.includes("bonus")) {
    return { changeType: "point_system", severity: "high" };
  }
  if (lowered.includes("eligibility") || lowered.includes("resident")) {
    return { changeType: "eligibility", severity: "high" };
  }
  if (lowered.includes("closure") || lowered.includes("closed")) {
    return { changeType: "closure", severity: "critical" };
  }
  return { changeType: "other", severity: "low" };
}

/**
 * Produce a short, human-readable summary line for a diff record. Used
 * directly as the `summary` column and surfaced verbatim to the concierge.
 */
export function summarizeDiff(
  fieldPath: string,
  oldValue: unknown,
  newValue: unknown
): string {
  const oldDisplay =
    oldValue === undefined || oldValue === null
      ? "(none)"
      : JSON.stringify(oldValue);
  const newDisplay =
    newValue === undefined || newValue === null
      ? "(removed)"
      : JSON.stringify(newValue);
  return `${fieldPath}: ${oldDisplay} → ${newDisplay}`;
}

/**
 * Ingest one regulation document, snapshotting it and producing diff
 * records against the previous active snapshot for the same slot.
 *
 * Idempotent: re-running with identical content is a no-op.
 */
export async function ingestSnapshot(input: SnapshotInput): Promise<SnapshotResult> {
  const canonical = canonicalizeText(input.canonicalText);
  const hash = hashContent(canonical);

  // Find prior active snapshot for the same slot. Review feedback
  // (StrongestAvengerStack on PR #11): omitting speciesId from the
  // dedupe key allowed two species in the same state/year/docType to
  // match each other's prior snapshot, corrupting the diff history
  // (e.g. a CO elk regs ingest could diff against the previous CO
  // mule deer regs row). Slot key is now
  // (state, species, docType, year, status). speciesId is nullable in
  // the schema — for state-wide docs we explicitly match IS NULL so
  // those still dedupe properly amongst themselves.
  const slotConditions = [
    eq(regulationSnapshots.stateId, input.stateId),
    eq(regulationSnapshots.docType, input.docType),
    eq(regulationSnapshots.year, input.year),
    eq(regulationSnapshots.status, "active"),
    input.speciesId
      ? eq(regulationSnapshots.speciesId, input.speciesId)
      : isNull(regulationSnapshots.speciesId),
  ];
  const [prior] = await db
    .select()
    .from(regulationSnapshots)
    .where(and(...slotConditions))
    .orderBy(desc(regulationSnapshots.snapshotAt))
    .limit(1);

  // Same content as last time — nothing to do.
  if (prior && prior.contentHash === hash) {
    console.log(
      `${LOG_PREFIX} hash unchanged for ${input.docType}/${input.year} state=${input.stateId} — skipping`
    );
    return { snapshotId: prior.id, isNew: false, changesDetected: 0 };
  }

  // Insert new snapshot (or first-ever snapshot for this slot).
  const [inserted] = await db
    .insert(regulationSnapshots)
    .values({
      stateId: input.stateId,
      speciesId: input.speciesId ?? null,
      year: input.year,
      docType: input.docType,
      title: input.title,
      url: input.url ?? null,
      sourceUrl: input.sourceUrl ?? null,
      contentHash: hash,
      contentLength: canonical.length,
      rawTextSnippet: canonical.slice(0, 10_000),
      extractedRules: input.extractedRules ?? {},
      sourceId: input.sourceId ?? null,
      previousSnapshotId: prior?.id ?? null,
      status: "active",
    })
    .returning();

  if (!inserted) {
    throw new Error("Failed to insert regulation snapshot");
  }
  const newSnapshot = inserted;

  // If there was a prior, mark it superseded and write diff records.
  let changesDetected = 0;
  if (prior) {
    await db
      .update(regulationSnapshots)
      .set({ status: "superseded" })
      .where(eq(regulationSnapshots.id, prior.id));

    const oldRules = (prior.extractedRules ?? {}) as Record<string, unknown>;
    const newRules = (input.extractedRules ?? {}) as Record<string, unknown>;
    const diffs = diffExtractedRules(oldRules, newRules);

    if (diffs.length > 0) {
      const rows = diffs.map((d) => {
        const { changeType, severity } = classifyDiff(
          d.fieldPath,
          d.oldValue,
          d.newValue
        );
        return {
          fromSnapshotId: prior.id,
          toSnapshotId: newSnapshot.id,
          stateId: input.stateId,
          speciesId: input.speciesId ?? null,
          changeType,
          severity,
          fieldPath: d.fieldPath,
          oldValue: d.oldValue ?? null,
          newValue: d.newValue ?? null,
          summary: summarizeDiff(d.fieldPath, d.oldValue, d.newValue),
          impact: null,
          affectsUnitCodes: extractAffectedUnits(d.fieldPath),
        };
      });

      await db.insert(regulationChanges).values(rows);
      changesDetected = rows.length;
    }
  }

  console.log(
    `${LOG_PREFIX} snapshotted ${input.docType}/${input.year} state=${input.stateId} hash=${hash.slice(0, 12)} changes=${changesDetected}`
  );

  return {
    snapshotId: newSnapshot.id,
    isNew: true,
    changesDetected,
  };
}

/**
 * Extract any `unit_NNN` style hunt unit codes from a diff field path so the
 * regulation_changes record can be filtered by affected unit downstream.
 */
function extractAffectedUnits(fieldPath: string): string[] {
  const matches = fieldPath.match(/unit[_-]?([A-Z0-9]+)/gi);
  if (!matches) return [];
  return matches.map((m) => m.replace(/unit[_-]?/i, "").toUpperCase());
}
