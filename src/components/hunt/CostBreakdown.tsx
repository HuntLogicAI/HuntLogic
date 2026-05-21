"use client";

import { cn, formatCurrency } from "@/lib/utils";
import type { CostEstimate } from "@/services/intelligence/types";

interface CostBreakdownProps {
  costs: CostEstimate;
  comparisonNote?: string;
  className?: string;
}

// Only the numeric category fields participate in the breakdown chart.
// `total` is shown separately and `isExact` is a metadata flag, not a
// dollar value.
type CostCategoryKey = "tag" | "license" | "points" | "travel" | "gear";

const categoryLabels: Record<CostCategoryKey, { label: string; color: string }> = {
  tag: { label: "Tag/Permit", color: "bg-brand-forest" },
  license: { label: "License", color: "bg-brand-sage" },
  points: { label: "Points", color: "bg-brand-sky" },
  travel: { label: "Travel", color: "bg-brand-earth" },
  gear: { label: "Gear", color: "bg-brand-sunset" },
};

export function CostBreakdown({
  costs,
  comparisonNote,
  className,
}: CostBreakdownProps) {
  const entries = (Object.keys(categoryLabels) as CostCategoryKey[])
    .map((key) => ({
      key,
      ...categoryLabels[key],
      amount: costs[key],
    }))
    .filter((e) => e.amount > 0);

  const total = costs.total;

  return (
    <div className={cn("w-full", className)}>
      {/* Stacked bar */}
      {total > 0 && (
        <div className="mb-4 flex h-4 overflow-hidden rounded-full bg-brand-sage/10 dark:bg-brand-sage/20">
          {entries.map((entry) => {
            const widthPct = (entry.amount / total) * 100;
            return (
              <div
                key={entry.key}
                className={cn("h-full", entry.color)}
                style={{ width: `${widthPct}%` }}
                title={`${entry.label}: ${formatCurrency(entry.amount)}`}
              />
            );
          })}
        </div>
      )}

      {/* Table */}
      <div className="space-y-2">
        {entries.map((entry) => (
          <div key={entry.key} className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className={cn("h-3 w-3 rounded-full", entry.color)} />
              <span className="text-sm text-brand-sage">{entry.label}</span>
            </div>
            <span className="text-sm font-medium text-brand-bark dark:text-brand-cream tabular-nums">
              {formatCurrency(entry.amount)}
            </span>
          </div>
        ))}

        {/* Total */}
        <div className="flex items-center justify-between border-t border-brand-sage/10 pt-2 dark:border-brand-sage/20">
          <span className="text-sm font-semibold text-brand-bark dark:text-brand-cream">
            Total
          </span>
          <span className="text-base font-bold text-brand-bark dark:text-brand-cream tabular-nums">
            {formatCurrency(total)}
          </span>
        </div>
      </div>

      {/* Comparison note */}
      {comparisonNote && (
        <p className="mt-3 text-xs text-brand-sage italic">{comparisonNote}</p>
      )}
    </div>
  );
}
