"use client";

import { useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonList } from "@/components/ui/Skeleton";
import { Target, MapPin, Search } from "lucide-react";

// =============================================================================
// Types
// =============================================================================

type Motivation = "trophy" | "meat" | "balanced" | "otl";
type WeaponFilter = "rifle" | "archery" | "muzzleloader" | "any";
type Tier = "A" | "B" | "C";

interface UnitResult {
  unitCode: string;
  drawRate: number | null;
  drawRatePct: string;
  minPointsDrawn: number | null;
  successRate: number | null;
  successRatePct: string;
  totalApplicants: number | null;
  totalTags: number | null;
  weaponType: string;
  score: number;
  tier: Tier;
  canDrawNow: boolean;
  recommendation: string;
  year: number;
}

interface ApiResponse {
  results: UnitResult[];
  meta: {
    stateCode: string;
    speciesSlug: string;
    motivation: string;
    year: number;
    totalUnitsEvaluated: number;
    message?: string;
  };
}

// =============================================================================
// Config
// =============================================================================

const STATE_OPTIONS = [
  { value: "NV", label: "Nevada" },
  { value: "CO", label: "Colorado" },
  { value: "AZ", label: "Arizona" },
  { value: "WY", label: "Wyoming" },
  { value: "UT", label: "Utah" },
  { value: "MT", label: "Montana" },
  { value: "NM", label: "New Mexico" },
  { value: "ID", label: "Idaho" },
  { value: "OR", label: "Oregon" },
] as const;

const SPECIES_OPTIONS = [
  { value: "mule_deer", label: "Mule Deer" },
  { value: "elk", label: "Elk" },
  { value: "antelope", label: "Antelope" },
  { value: "bighorn_sheep", label: "Bighorn Sheep" },
  { value: "mountain_goat", label: "Mountain Goat" },
  { value: "moose", label: "Moose" },
] as const;

const MOTIVATION_OPTIONS: { value: Motivation; label: string; icon: string }[] = [
  { value: "meat", label: "Meat", icon: "\u{1F9CA}" },
  { value: "trophy", label: "Trophy", icon: "\u{1F3C6}" },
  { value: "otl", label: "Once-in-Lifetime", icon: "\u{1F304}" },
  { value: "balanced", label: "Balanced", icon: "\u{2696}\u{FE0F}" },
];

const WEAPON_OPTIONS: { value: WeaponFilter; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "rifle", label: "Rifle" },
  { value: "archery", label: "Archery" },
  { value: "muzzleloader", label: "Muzzleloader" },
];

const TIER_STYLES: Record<Tier, { bg: string; text: string; border: string }> = {
  A: { bg: "bg-green-500/10", text: "text-green-700", border: "border-green-500/30" },
  B: { bg: "bg-amber-500/10", text: "text-amber-700", border: "border-amber-500/30" },
  C: { bg: "bg-gray-500/10", text: "text-gray-600", border: "border-gray-400/30" },
};

// =============================================================================
// Page Component
// =============================================================================

export default function UnitRankerPage() {
  const searchParams = useSearchParams();

  // Initialize from URL params (supports deep-linking from Playbook)
  const [stateCode, setStateCode] = useState(
    searchParams.get("state")?.toUpperCase() ?? "NV"
  );
  const [speciesSlug, setSpeciesSlug] = useState(
    searchParams.get("species") ?? "mule_deer"
  );
  const [motivation, setMotivation] = useState<Motivation>(
    (searchParams.get("motivation") as Motivation | null) ?? "balanced"
  );
  const [weaponType, setWeaponType] = useState<WeaponFilter>("any");
  const [currentPoints, setCurrentPoints] = useState<string>(
    searchParams.get("points") ?? "0"
  );

  const [results, setResults] = useState<UnitResult[]>([]);
  const [meta, setMeta] = useState<ApiResponse["meta"] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setHasSearched(true);

    try {
      const res = await fetch("/api/v1/unit-recommendations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stateCode,
          speciesSlug,
          motivation,
          weaponType,
          currentPoints: parseInt(currentPoints, 10) || 0,
          residentType: "nonresident",
        }),
      });

      if (!res.ok) {
        const errorBody = (await res.json()) as { error?: string };
        throw new Error(errorBody.error ?? `Request failed (${res.status})`);
      }

      const data = (await res.json()) as ApiResponse;
      setResults(data.results);
      setMeta(data.meta);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong";
      setError(message);
      setResults([]);
    } finally {
      setIsLoading(false);
    }
  }, [stateCode, speciesSlug, motivation, weaponType, currentPoints]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-brand-bark dark:text-brand-cream">
          Unit Recommendations
        </h1>
        <p className="mt-1 text-sm text-brand-sage">
          Find the right unit for your goals
        </p>
      </div>

      {/* Data coverage banner */}
      <div className="rounded-xl bg-brand-sky/10 px-4 py-3 text-sm text-brand-sky">
        Showing Nevada data. Utah coming soon.
      </div>

      {/* Filter bar */}
      <div className="space-y-4">
        {/* Row 1: State + Species */}
        <div className="flex gap-3">
          <div className="flex-1 min-w-0">
            <label className="block text-xs font-medium text-brand-sage mb-1">
              State
            </label>
            <select
              value={stateCode}
              onChange={(e) => setStateCode(e.target.value)}
              className="w-full rounded-xl border border-brand-sage/20 bg-white px-3 py-2.5 text-sm text-brand-bark dark:bg-brand-bark dark:text-brand-cream dark:border-brand-sage/30 min-h-[44px]"
            >
              {STATE_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex-1 min-w-0">
            <label className="block text-xs font-medium text-brand-sage mb-1">
              Species
            </label>
            <select
              value={speciesSlug}
              onChange={(e) => setSpeciesSlug(e.target.value)}
              className="w-full rounded-xl border border-brand-sage/20 bg-white px-3 py-2.5 text-sm text-brand-bark dark:bg-brand-bark dark:text-brand-cream dark:border-brand-sage/30 min-h-[44px]"
            >
              {SPECIES_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Row 2: Motivation chips */}
        <div>
          <label className="block text-xs font-medium text-brand-sage mb-1.5">
            Motivation
          </label>
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4 scrollbar-hide">
            {MOTIVATION_OPTIONS.map((m) => (
              <button
                key={m.value}
                onClick={() => setMotivation(m.value)}
                className={cn(
                  "shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-colors min-h-[44px]",
                  motivation === m.value
                    ? "bg-brand-forest text-brand-cream dark:bg-brand-sage"
                    : "bg-brand-sage/10 text-brand-sage hover:bg-brand-sage/20 dark:bg-brand-sage/20"
                )}
              >
                {m.icon} {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* Row 3: Weapon + Points */}
        <div className="flex gap-3">
          <div className="flex-1 min-w-0">
            <label className="block text-xs font-medium text-brand-sage mb-1">
              Weapon
            </label>
            <div className="flex gap-1.5 overflow-x-auto scrollbar-hide">
              {WEAPON_OPTIONS.map((w) => (
                <button
                  key={w.value}
                  onClick={() => setWeaponType(w.value)}
                  className={cn(
                    "shrink-0 rounded-lg px-3 py-2 text-xs font-medium transition-colors min-h-[36px]",
                    weaponType === w.value
                      ? "bg-brand-forest text-brand-cream dark:bg-brand-sage"
                      : "bg-brand-sage/10 text-brand-sage hover:bg-brand-sage/20"
                  )}
                >
                  {w.label}
                </button>
              ))}
            </div>
          </div>

          <div className="w-28 shrink-0">
            <label className="block text-xs font-medium text-brand-sage mb-1">
              My points
            </label>
            <input
              type="number"
              min={0}
              max={30}
              value={currentPoints}
              onChange={(e) => setCurrentPoints(e.target.value)}
              className="w-full rounded-xl border border-brand-sage/20 bg-white px-3 py-2.5 text-sm text-brand-bark tabular-nums dark:bg-brand-bark dark:text-brand-cream dark:border-brand-sage/30 min-h-[44px]"
              placeholder="0"
            />
          </div>
        </div>

        {/* Search button */}
        <button
          onClick={handleSearch}
          disabled={isLoading}
          className="w-full rounded-xl bg-brand-forest px-4 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:bg-brand-forest/90 active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2 min-h-[48px]"
        >
          <Search className="h-4 w-4" />
          {isLoading ? "Finding Units..." : "Find Units"}
        </button>
      </div>

      {/* Results */}
      {isLoading ? (
        <SkeletonList count={4} />
      ) : error ? (
        <div className="rounded-xl bg-danger/10 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : results.length > 0 ? (
        <div className="space-y-3">
          {meta && (
            <p className="text-xs text-brand-sage">
              {meta.totalUnitsEvaluated} units evaluated &middot; {meta.year} data &middot; Top {results.length} shown
            </p>
          )}

          {results.map((unit, idx) => (
            <UnitCard
              key={unit.unitCode}
              unit={unit}
              rank={idx + 1}
              userPoints={parseInt(currentPoints, 10) || 0}
            />
          ))}
        </div>
      ) : hasSearched ? (
        <EmptyState
          icon={<MapPin className="h-8 w-8" />}
          title="No units found"
          description="Try a different state, species, or weapon type."
        />
      ) : (
        <EmptyState
          icon={<Target className="h-8 w-8" />}
          title="Choose your parameters"
          description="Select a state, species, and motivation, then hit Find Units."
        />
      )}
    </div>
  );
}

// =============================================================================
// Unit Card Component
// =============================================================================

function UnitCard({
  unit,
  rank,
  userPoints,
}: {
  unit: UnitResult;
  rank: number;
  userPoints: number;
}) {
  const tierStyle = TIER_STYLES[unit.tier];
  const pointDeficit =
    unit.minPointsDrawn !== null && !unit.canDrawNow
      ? unit.minPointsDrawn - userPoints
      : 0;

  // Sanitize placeholder unit codes from the source data (e.g. literal
  // "Any Open Unit", "ANY", "*") — those are seed sentinels meant to mean
  // "statewide / no unit restriction", not real unit identifiers. Showing
  // "Unit Any Open Unit" is confusing.
  const placeholderCodes = new Set([
    "ANY",
    "ANY OPEN UNIT",
    "OPEN UNIT",
    "STATEWIDE",
    "*",
    "ALL",
  ]);
  const isPlaceholder = placeholderCodes.has(
    (unit.unitCode ?? "").trim().toUpperCase(),
  );
  const unitLabel = isPlaceholder ? "Statewide / no unit filter" : `Unit ${unit.unitCode}`;

  return (
    <Card variant="default" className="overflow-hidden">
      {/* Top row: tier badge + unit code + draw-now chip */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex h-7 w-7 items-center justify-center rounded-lg text-xs font-bold",
              tierStyle.bg,
              tierStyle.text
            )}
          >
            {unit.tier}
          </span>
          <span className="text-xs text-brand-sage font-medium">#{rank}</span>
          <h3 className="text-base font-bold text-brand-bark dark:text-brand-cream">
            {unitLabel}
          </h3>
        </div>

        <div className="flex items-center gap-2">
          {unit.canDrawNow ? (
            <Badge variant="success" size="sm">Can Draw Now</Badge>
          ) : pointDeficit > 0 ? (
            <Badge variant="warning" size="sm">
              Need {pointDeficit} more pt{pointDeficit === 1 ? "" : "s"}
            </Badge>
          ) : null}
          <Badge variant="outline" size="sm">
            NR {unit.year}
          </Badge>
        </div>
      </div>

      {/* Bars */}
      <div className="mt-3 space-y-2">
        <ProgressRow
          label="Draw Odds"
          value={unit.drawRate}
          display={unit.drawRatePct}
          color="bg-brand-sky"
        />
        <ProgressRow
          label="Success Rate"
          value={unit.successRate}
          display={unit.successRatePct}
          color="bg-brand-forest"
        />
      </div>

      {/* Stats row */}
      <div className="mt-3 flex gap-4 text-xs text-brand-sage overflow-x-auto scrollbar-hide">
        <div>
          <span className="font-medium">Min Pts:</span>{" "}
          <span className="text-brand-bark dark:text-brand-cream tabular-nums">
            {unit.minPointsDrawn ?? "N/A"}
          </span>
          {userPoints > 0 && (
            <span className="text-brand-sage">
              {" "}(you: {userPoints})
            </span>
          )}
        </div>
        <div>
          <span className="font-medium">Applicants/Tags:</span>{" "}
          <span className="text-brand-bark dark:text-brand-cream tabular-nums">
            {unit.totalApplicants ?? "?"}/{unit.totalTags ?? "?"}
          </span>
        </div>
        <div>
          <span className="font-medium">Weapon:</span>{" "}
          <span className="text-brand-bark dark:text-brand-cream capitalize">
            {(() => {
              // Source data sometimes carries placeholder weapon strings
              // ("unknown", "any", or — most confusingly — "Shotgun" on
              // big-game records where it really means "general firearm").
              // Surface "Any" rather than misleading specifics.
              const raw = (unit.weaponType ?? "").toLowerCase();
              if (!raw || raw === "unknown" || raw === "any") return "Any";
              return unit.weaponType;
            })()}
          </span>
        </div>
      </div>

      {/* Recommendation text */}
      <p className="mt-3 text-sm text-brand-sage leading-relaxed">
        {unit.recommendation}
      </p>

      {/* Score indicator */}
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-brand-sage">
          Score: <span className="font-semibold text-brand-bark dark:text-brand-cream tabular-nums">{unit.score.toFixed(3)}</span>
        </span>
      </div>
    </Card>
  );
}

// =============================================================================
// Progress Bar Component
// =============================================================================

function ProgressRow({
  label,
  value,
  display,
  color,
}: {
  label: string;
  value: number | null;
  display: string;
  color: string;
}) {
  const pct = value !== null ? Math.round(value * 100) : 0;

  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-xs text-brand-sage">{label}</span>
      <div className="flex-1 h-2 rounded-full bg-brand-sage/10 dark:bg-brand-sage/20 overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-500", color)}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <span className="w-12 shrink-0 text-right text-xs font-semibold text-brand-bark dark:text-brand-cream tabular-nums">
        {display}
      </span>
    </div>
  );
}
