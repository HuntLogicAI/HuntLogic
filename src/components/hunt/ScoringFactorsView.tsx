"use client";

import { cn } from "@/lib/utils";
import type { ScoringFactors, ScoringWeights } from "@/services/intelligence/types";

interface ScoringFactorsViewProps {
  factors: ScoringFactors | null | undefined;
  weights: ScoringWeights | null | undefined;
  className?: string;
}

/**
 * Renders the scoring breakdown for a recommendation — answers the
 * common "why did we pick this?" question that the audit flagged as
 * a trust gap. Each factor shows:
 *   - the score (0.0-1.0) as a horizontal bar
 *   - the weight applied (0.0-1.0) as a small chip
 *   - the contribution (score × weight) on the right
 *
 * Top factor gets a "Driving factor" callout. Bottom factor gets a
 * "Weakest signal" callout when its contribution is meaningfully low.
 *
 * The component is render-only — it has no fetching or state of its
 * own; pass the factors + weights from the recommendation payload.
 */

const FACTOR_LABELS: Record<keyof ScoringFactors, { label: string; blurb: string }> = {
  draw_odds_score: {
    label: "Draw odds",
    blurb: "Likelihood you'd actually draw this tag at your point level.",
  },
  trophy_quality_score: {
    label: "Trophy quality",
    blurb: "B&C / age-class signals from harvest data.",
  },
  success_rate_score: {
    label: "Success rate",
    blurb: "Historical % of hunters that filled a tag in this unit.",
  },
  cost_efficiency_score: {
    label: "Cost efficiency",
    blurb: "$ per opportunity (tag + license + travel + gear).",
  },
  access_score: {
    label: "Access",
    blurb: "Public-land %, road access, and terrain difficulty.",
  },
  forecast_score: {
    label: "Forecast",
    blurb: "Point creep + applicant trend over the next 3-5 years.",
  },
  personal_fit_score: {
    label: "Personal fit",
    blurb: "Match against your stated weapon, hunt style, and species interests.",
  },
  timeline_fit_score: {
    label: "Timeline fit",
    blurb: "Match against your stated timeline (this year / 1-3 yrs / 5+).",
  },
};

const FACTOR_ORDER: (keyof ScoringFactors)[] = [
  "draw_odds_score",
  "success_rate_score",
  "personal_fit_score",
  "cost_efficiency_score",
  "access_score",
  "trophy_quality_score",
  "forecast_score",
  "timeline_fit_score",
];

function weightKeyForFactor(
  factorKey: keyof ScoringFactors,
): keyof ScoringWeights {
  // Factor field is `<weightKey>_score` — strip the suffix.
  return factorKey.replace(/_score$/, "") as keyof ScoringWeights;
}

export function ScoringFactorsView({
  factors,
  weights,
  className,
}: ScoringFactorsViewProps) {
  // Guard: factors come back as JSONB from the API and may be undefined
  // for legacy rows or recs that pre-date the scoring engine.
  if (!factors || typeof factors !== "object") {
    return (
      <p className={cn("text-xs text-brand-sage italic", className)}>
        Scoring factors aren&apos;t recorded for this recommendation yet.
      </p>
    );
  }

  const entries = FACTOR_ORDER.filter((k) => typeof factors[k] === "number").map(
    (k) => {
      const score = factors[k] as number;
      const weight = weights?.[weightKeyForFactor(k)] ?? 0;
      const contribution = score * weight;
      return {
        key: k,
        label: FACTOR_LABELS[k].label,
        blurb: FACTOR_LABELS[k].blurb,
        score,
        weight,
        contribution,
      };
    },
  );

  if (entries.length === 0) {
    return (
      <p className={cn("text-xs text-brand-sage italic", className)}>
        Scoring factors aren&apos;t recorded for this recommendation yet.
      </p>
    );
  }

  // Identify the top contributor + the weakest signal (if weak enough to call out).
  const byContribution = [...entries].sort((a, b) => b.contribution - a.contribution);
  const top = byContribution[0];
  const weakest = byContribution[byContribution.length - 1];
  const weakestIsNoteworthy = weakest && weakest.contribution < 0.05;

  return (
    <div className={cn("space-y-3", className)}>
      <div className="space-y-1.5">
        {entries.map((e) => {
          const pct = Math.round(e.score * 100);
          const contribPct = Math.round(e.contribution * 100);
          const isTop = top && e.key === top.key;
          return (
            <div key={e.key} className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    "flex items-center gap-1.5 text-brand-bark dark:text-brand-cream",
                    isTop && "font-semibold",
                  )}
                  title={e.blurb}
                >
                  {e.label}
                  {isTop && (
                    <span className="rounded bg-brand-forest/10 px-1 py-0.5 text-[9px] uppercase tracking-wider text-brand-forest dark:bg-brand-sage/20 dark:text-brand-sage">
                      Driving
                    </span>
                  )}
                </span>
                <span className="text-brand-sage tabular-nums">
                  {pct}%
                  <span className="ml-1 text-brand-sage/60">
                    × {(e.weight * 100).toFixed(0)}% = {contribPct}%
                  </span>
                </span>
              </div>
              <div className="mt-0.5 flex h-1.5 overflow-hidden rounded-full bg-brand-sage/10 dark:bg-brand-sage/20">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    isTop ? "bg-brand-forest" : "bg-brand-sage/70",
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {weakestIsNoteworthy && weakest && (
        <p className="rounded-md bg-brand-sage/5 px-2 py-1.5 text-[11px] italic text-brand-sage dark:bg-brand-sage/10">
          Weakest signal: <strong>{weakest.label}</strong> ({Math.round(weakest.score * 100)}%). {weakest.blurb}
        </p>
      )}
    </div>
  );
}
