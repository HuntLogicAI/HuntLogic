"use client";

import { useEffect, useState } from "react";
import { Compass, AlertTriangle, GitBranch } from "lucide-react";

interface CoverageEntry {
  stateCode: string;
  speciesSlug: string;
  speciesName: string;
  memberNames: string[];
}

interface OverlapEntry {
  stateCode: string;
  speciesSlug: string;
  speciesName: string;
  unitCode: string | null;
  members: string[];
}

interface SplitEntry {
  stateCode: string;
  speciesSlug: string;
  speciesName: string;
  members: string[];
  currentUnit: string | null;
  suggestion: string;
}

interface StrategyResponse {
  memberCount: number;
  coverage: CoverageEntry[];
  overlap: OverlapEntry[];
  splitSuggestions: SplitEntry[];
  note?: string;
}

/**
 * Renders the "joint application strategy" section on a hunt group's detail
 * page. Pulls the per-member playbook overlap analysis from the strategy
 * API and surfaces it as three distinct lenses:
 *
 *   1. Coverage — what hunts the group collectively targets
 *   2. Overlap  — duplicate applications (multiple members on the same unit)
 *   3. Splits   — actionable suggestions to spread across more units
 *
 * Self-contained: own loading + error states. Renders a friendly note
 * when members haven't generated playbooks yet (the most common empty
 * state for a brand-new group).
 */
export function GroupStrategyView({ groupId }: { groupId: string }) {
  const [data, setData] = useState<StrategyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(`/api/v1/groups/${groupId}/strategy`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = (await res.json()) as StrategyResponse;
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  if (loading) {
    return (
      <div className="rounded-xl border border-brand-sage/10 bg-white p-5 shadow-sm dark:border-brand-sage/20 dark:bg-brand-bark">
        <div className="h-5 w-40 motion-safe:animate-pulse rounded-lg bg-brand-sage/10" />
        <div className="mt-3 h-16 motion-safe:animate-pulse rounded-lg bg-brand-sage/10" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
        Failed to load joint strategy. {error}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-brand-sage/10 bg-white p-5 shadow-sm dark:border-brand-sage/20 dark:bg-brand-bark">
      <div className="mb-3 flex items-center gap-2">
        <Compass className="h-4 w-4 text-brand-forest" />
        <h2 className="text-sm font-semibold text-brand-bark dark:text-brand-cream">
          Joint application strategy
        </h2>
      </div>

      {data.note && (
        <p className="mb-3 rounded-md bg-brand-sage/5 px-3 py-2 text-xs italic text-brand-sage dark:bg-brand-sage/10">
          {data.note}
        </p>
      )}

      {/* Coverage */}
      <section className="mb-4">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-brand-sage">
          Coverage ({data.coverage.length} hunts)
        </h3>
        {data.coverage.length === 0 ? (
          <p className="text-sm text-brand-sage">
            Once members generate playbooks, the group&apos;s collective targets
            show up here.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {data.coverage.map((c) => (
              <li
                key={`${c.stateCode}-${c.speciesSlug}`}
                className="flex items-center gap-1 rounded-md border border-brand-sage/15 bg-brand-sage/5 px-2 py-0.5 text-xs text-brand-bark dark:border-brand-sage/25 dark:bg-brand-sage/10 dark:text-brand-cream"
                title={`Members: ${c.memberNames.join(", ")}`}
              >
                <span className="font-mono text-[10px] text-brand-sage">
                  {c.stateCode}
                </span>
                <span>{c.speciesName}</span>
                <span className="text-[10px] text-brand-sage/60">
                  ({c.memberNames.length})
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Overlap */}
      {data.overlap.length > 0 && (
        <section className="mb-4">
          <h3 className="mb-2 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-amber-700">
            <AlertTriangle className="h-3 w-3" />
            Duplicate applications ({data.overlap.length})
          </h3>
          <ul className="space-y-1.5">
            {data.overlap.map((o) => (
              <li
                key={`${o.stateCode}-${o.speciesSlug}-${o.unitCode}`}
                className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200"
              >
                <span className="font-mono text-[10px]">{o.stateCode}</span>{" "}
                {o.speciesName} Unit {o.unitCode} — {o.members.join(" and ")}{" "}
                applying for the same tag.
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Splits */}
      {data.splitSuggestions.length > 0 && (
        <section>
          <h3 className="mb-2 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-brand-forest">
            <GitBranch className="h-3 w-3" />
            Suggested splits ({data.splitSuggestions.length})
          </h3>
          <ul className="space-y-2">
            {data.splitSuggestions.map((s, i) => (
              <li
                key={`${s.stateCode}-${s.speciesSlug}-${i}`}
                className="rounded-md border border-brand-forest/20 bg-brand-forest/5 px-3 py-2 text-xs text-brand-bark dark:border-brand-sage/30 dark:bg-brand-sage/10 dark:text-brand-cream"
              >
                {s.suggestion}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
