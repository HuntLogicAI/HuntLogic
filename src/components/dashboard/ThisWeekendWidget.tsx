"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Sparkles, ChevronRight } from "lucide-react";

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
  rationale: string;
}

/**
 * Dashboard activation widget: "What can I hunt this weekend?"
 *
 * Pulls OTC + open-season opportunities near the user's home state for the
 * upcoming 7-day window. Designed to convert "I forgot HuntLogic exists"
 * dormancy into a concrete action.
 *
 * The card silently renders nothing if the API returns no opportunities —
 * preferable to a noisy empty state on the dashboard.
 */
export function ThisWeekendWidget() {
  const [opportunities, setOpportunities] = useState<WeekendOpportunity[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/v1/dashboard/this-weekend");
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        setOpportunities(json.opportunities ?? []);
      } catch (err) {
        console.error("[this-weekend] load failed:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="rounded-xl border border-brand-sage/10 bg-white p-4 dark:border-brand-sage/20 dark:bg-brand-bark">
        <div className="h-5 w-48 motion-safe:animate-pulse rounded-lg bg-brand-sage/10" />
        <div className="mt-3 h-10 motion-safe:animate-pulse rounded-lg bg-brand-sage/10" />
      </div>
    );
  }

  if (opportunities.length === 0) {
    // Silent: no opportunities = no widget. Dashboard already has plenty
    // of widgets; don't add empty noise.
    return null;
  }

  return (
    <section className="rounded-xl border border-brand-sunset/20 bg-gradient-to-br from-brand-sunset/5 to-brand-sage/5 p-4 dark:border-brand-sunset/30 dark:from-brand-sunset/10 dark:to-brand-sage/10">
      <header className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-brand-sunset" />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-brand-sage">
            What you can hunt this weekend
          </h2>
        </div>
      </header>
      <ul className="space-y-2">
        {opportunities.map((opp) => {
          const href = `/forecasts?state=${encodeURIComponent(opp.stateCode)}&species=${encodeURIComponent(opp.speciesSlug)}`;
          return (
            <li key={`${opp.stateCode}-${opp.speciesSlug}-${opp.seasonName ?? ""}`}>
              <Link
                href={href}
                className="flex items-center justify-between gap-3 rounded-lg bg-white px-3 py-2.5 transition-colors hover:bg-brand-sage/5 dark:bg-brand-bark/40 dark:hover:bg-brand-sage/10"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <p className="text-sm font-medium text-brand-bark dark:text-brand-cream">
                      {opp.speciesName} — {opp.stateName}
                    </p>
                    {opp.isOtc && (
                      <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-green-800 dark:bg-green-900/40 dark:text-green-300">
                        OTC
                      </span>
                    )}
                    {opp.isHomeState && (
                      <span className="rounded bg-brand-forest/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand-forest dark:bg-brand-sage/20 dark:text-brand-sage">
                        Home
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-brand-sage">
                    {opp.rationale}
                    {opp.seasonName ? ` · ${opp.seasonName}` : ""}
                  </p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-brand-sage" />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
