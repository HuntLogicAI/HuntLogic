"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { Card, CardHeader, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { PointCreepGraph } from "@/components/hunt/PointCreepGraph";
import { DrawOddsChart } from "@/components/hunt/DrawOddsChart";
import { SkeletonList } from "@/components/ui/Skeleton";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Sparkles,
  BarChart3,
} from "lucide-react";
import { fetchWithCache } from "@/lib/api/cache";

interface ForecastSelection {
  state: string;
  species: string;
}

interface ForecastData {
  pointCreep: {
    historicalData: { year: number; points: number }[];
    projectedData: { year: number; points: number }[];
    userPoints: number;
    estimatedDrawYear: number;
  };
  drawOdds: {
    atCurrentPoints: number;
    trend: { year: number; value: number }[];
  };
  roi: {
    recommendation: string;
    costPerOpportunity: number;
    /** null = unreachable (never going to draw at current trend). 0 = already eligible. */
    projectedYears: number | null;
    totalInvestment: number;
    explanation: string;
  };
  /** null = "not enough data" — the trend chip should be hidden. */
  trend: string | null;
}

/* ---- Raw API shapes (what the server actually returns) ---- */

interface RawForecastResponse {
  type: string;
  forecast?: {
    historicalData?: { year: number; value: number }[];
    projections?: { year: number; projected: number; lowerBound: number; upperBound: number }[];
    trend?: string;
    trendStrength?: number;
    confidence?: { score: number; label: string; basis: string };
    [key: string]: unknown;
  };
}

interface RawRoiResponse {
  type: string;
  assessment?: {
    verdict?: string;
    verdictRationale?: string;
    alternativeUse?: string;
    estimatedYearsToTag?: number | null;
    totalFutureInvestment?: number;
    breakEvenPointThreshold?: number | null;
    costPerOpportunity?: number;
    [key: string]: unknown;
  };
}

interface RawDrawOddsResponse {
  type: string;
  forecast?: {
    yearOne?: { probability: number; confidence: number };
    yearThree?: { probability: number; confidence: number };
    yearFive?: { probability: number; confidence: number };
    explanation?: string;
  };
}

const roiColors: Record<string, { variant: "success" | "info" | "warning" | "danger"; label: string }> = {
  continue: { variant: "success", label: "Continue" },
  strong_buy: { variant: "success", label: "Strong Buy" },
  buy: { variant: "success", label: "Buy" },
  hold: { variant: "warning", label: "Hold" },
  consider_exit: { variant: "danger", label: "Consider Exit" },
  exit: { variant: "danger", label: "Exit" },
};

const trendIcons: Record<string, typeof TrendingUp> = {
  rising: TrendingUp,
  stable: Minus,
  declining: TrendingDown,
};

function ForecastsPageInner() {
  const searchParams = useSearchParams();
  const [availableStates, setAvailableStates] = useState<{ code: string; name: string }[]>([]);
  const [availableSpecies, setAvailableSpecies] = useState<{ slug: string; name: string }[]>([]);
  const [selection, setSelection] = useState<ForecastSelection>({
    state: searchParams.get("state") ?? "",
    species: searchParams.get("species") ?? "",
  });
  const [isLoading, setIsLoading] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [forecast, setForecast] = useState<ForecastData | null>(null);
  // Mitch April 30 review #11: forecasts must use the hunter's actual points to
  // produce a personalized "is it worth applying" verdict. Map keyed by
  // `${stateCode}|${speciesSlug}` (uppercased state).
  const [pointsByCombo, setPointsByCombo] = useState<Record<string, number>>(
    {},
  );
  const [hasLoadedPoints, setHasLoadedPoints] = useState(false);

  // Fetch the user's actual point holdings on mount so the ROI assessment is
  // personalized (estimatedYearsToTag, breakEvenPointThreshold, alternativeUse
  // all depend on current points).
  useEffect(() => {
    async function fetchHoldings() {
      try {
        const res = await fetchWithCache<{
          data?: Array<{
            stateCode: string;
            speciesSlug: string;
            points: number;
          }>;
        }>("/api/v1/profile/points", { staleMs: 60_000 });
        const map: Record<string, number> = {};
        for (const h of res.data ?? []) {
          map[`${h.stateCode.toUpperCase()}|${h.speciesSlug}`] = h.points;
        }
        setPointsByCombo(map);
      } catch (err) {
        console.error("[forecasts] Failed to load user points:", err);
      } finally {
        setHasLoadedPoints(true);
      }
    }
    fetchHoldings();
  }, []);

  // Fetch available states and species on mount (rarely changes — 120s stale)
  useEffect(() => {
    async function fetchOptions() {
      try {
        const [statesData, speciesData] = await Promise.all([
          fetchWithCache<{ states?: { code: string; name: string }[]; data?: { code: string; name: string }[] }>(
            "/api/v1/regulations",
            { staleMs: 120_000 }
          ),
          fetchWithCache<{ species?: { slug: string; name: string }[]; data?: { slug: string; name: string }[] }>(
            "/api/v1/species",
            { staleMs: 120_000 }
          ),
        ]);

        const statesList = statesData.states || statesData.data || [];
        setAvailableStates(statesList.map((s) => ({ code: s.code, name: s.name })));

        const speciesList = speciesData.species || speciesData.data || [];
        setAvailableSpecies(speciesList.map((s) => ({ slug: s.slug, name: s.name })));
      } catch (err) {
        console.error("[forecasts] Failed to fetch dropdown options:", err);
      } finally {
        setIsInitializing(false);
      }
    }
    fetchOptions();
  }, []);

  // Fetch forecast data when selection changes
  useEffect(() => {
    if (!selection.state || !selection.species) {
      setForecast(null);
      return;
    }

    if (!hasLoadedPoints) {
      return;
    }

    async function fetchForecast() {
      setIsLoading(true);
      try {
        const userPoints =
          pointsByCombo[
            `${selection.state.toUpperCase()}|${selection.species}`
          ] ?? 0;
        const [pointCreepData, drawOddsData, roiData] = await Promise.all([
          fetchWithCache<RawForecastResponse>(
            `/api/v1/forecasts?type=point-creep&state=${selection.state}&species=${selection.species}`,
            { staleMs: 60_000 }
          ),
          fetchWithCache<RawDrawOddsResponse>(
            `/api/v1/forecasts?type=draw-odds&state=${selection.state}&species=${selection.species}&points=${userPoints}`,
            { staleMs: 60_000 }
          ),
          fetchWithCache<RawRoiResponse>(
            `/api/v1/forecasts?type=roi&state=${selection.state}&species=${selection.species}&points=${userPoints}`,
            { staleMs: 60_000 }
          ),
        ]);

        const rawForecast = pointCreepData.forecast;
        const rawDrawOdds = drawOddsData.forecast;
        const rawAssessment = roiData.assessment;

        // Map API shape → component shape
        const historicalData = (rawForecast?.historicalData ?? []).map((d) => ({
          year: d.year,
          points: d.value,
        }));

        const projectedData = (rawForecast?.projections ?? []).map((d) => ({
          year: d.year,
          points: d.projected,
        }));

        // Estimate draw year: first projected year where user could plausibly draw
        const currentYear = new Date().getFullYear();
        const estimatedDrawYear =
          projectedData.length > 0
            ? projectedData[projectedData.length - 1]?.year ?? currentYear + 5
            : currentYear;

        const drawOddsTrend = [
          {
            year: currentYear + 1,
            value: (rawDrawOdds?.yearOne?.probability ?? 0) * 100,
          },
          {
            year: currentYear + 3,
            value: (rawDrawOdds?.yearThree?.probability ?? 0) * 100,
          },
          {
            year: currentYear + 5,
            value: (rawDrawOdds?.yearFive?.probability ?? 0) * 100,
          },
        ];

        // Bug fix: surface "we don't actually have enough data" vs. "we
        // measured a stable trend" as distinct states. Two historical
        // data points is the minimum the trend chart can meaningfully
        // render — below that we suppress the trend chip entirely.
        const hasEnoughForTrend = historicalData.length >= 2;

        // Bug fix: distinguish "already eligible" (0 years) from
        // "unreachable at current trend" (null). The previous code
        // collapsed both to 0, producing the contradictory "Yrs to
        // Draw ~0 / may never reach the threshold" combo.
        const rawYears = rawAssessment?.estimatedYearsToTag;
        const projectedYears: number | null =
          rawYears === null || rawYears === undefined ? null : rawYears;

        setForecast({
          pointCreep: {
            historicalData,
            projectedData,
            userPoints,
            estimatedDrawYear,
          },
          drawOdds: {
            atCurrentPoints: (rawDrawOdds?.yearOne?.probability ?? 0) * 100,
            trend: drawOddsTrend,
          },
          roi: {
            recommendation: rawAssessment?.verdict ?? "hold",
            costPerOpportunity: rawAssessment?.totalFutureInvestment
              ? Math.round(
                  rawAssessment.totalFutureInvestment /
                    Math.max(1, rawAssessment.estimatedYearsToTag ?? 1)
                )
              : 0,
            projectedYears,
            totalInvestment: rawAssessment?.totalFutureInvestment ?? 0,
            explanation: rawAssessment?.verdictRationale ?? "",
          },
          trend: hasEnoughForTrend ? (rawForecast?.trend ?? "stable") : null,
        });
      } catch (err) {
        console.error("[forecasts] Failed to fetch forecast:", err);
        setForecast(null);
      } finally {
        setIsLoading(false);
      }
    }

    fetchForecast();
  }, [selection.state, selection.species, pointsByCombo, hasLoadedPoints]);

  const handleSelectionChange = (field: keyof ForecastSelection, value: string) => {
    setSelection((prev) => ({ ...prev, [field]: value }));
  };

  // forecast.trend can be null when there isn't enough historical data to
  // judge a trend; the icon is only rendered when a non-null trend exists,
  // but keep the variable defined to satisfy the JSX below.
  const TrendIcon =
    forecast && forecast.trend ? (trendIcons[forecast.trend] || Minus) : Minus;
  const roiInfo = forecast ? (roiColors[forecast.roi.recommendation] ?? roiColors.hold!) : roiColors.hold!;

  if (isInitializing) {
    return (
      <div className="space-y-6">
        <div>
          <div className="h-7 w-40 motion-safe:animate-pulse rounded-lg bg-brand-sage/10" />
          <div className="mt-1 h-5 w-56 motion-safe:animate-pulse rounded-lg bg-brand-sage/10" />
        </div>
        <SkeletonList count={3} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-brand-bark dark:text-brand-cream">
          Forecasts
        </h1>
        <p className="mt-1 text-sm text-brand-sage">
          Draw odds predictions and trend analysis
        </p>
      </div>

      {/* Selection dropdowns */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-brand-bark dark:text-brand-cream mb-1.5">
            State
          </label>
          <select
            value={selection.state}
            onChange={(e) => handleSelectionChange("state", e.target.value)}
            className="w-full min-h-[44px] rounded-xl border border-brand-sage/20 bg-white px-4 py-2.5 text-base text-brand-bark focus:outline-none focus:ring-2 focus:ring-brand-forest dark:bg-brand-bark dark:text-brand-cream dark:border-brand-sage/30"
          >
            <option value="">Select state</option>
            {availableStates.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-brand-bark dark:text-brand-cream mb-1.5">
            Species
          </label>
          <select
            value={selection.species}
            onChange={(e) => handleSelectionChange("species", e.target.value)}
            className="w-full min-h-[44px] rounded-xl border border-brand-sage/20 bg-white px-4 py-2.5 text-base text-brand-bark focus:outline-none focus:ring-2 focus:ring-brand-forest dark:bg-brand-bark dark:text-brand-cream dark:border-brand-sage/30"
          >
            <option value="">Select species</option>
            {availableSpecies.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isLoading ? (
        <SkeletonList count={3} />
      ) : !forecast ? (
        <EmptyState
          icon={<BarChart3 className="h-8 w-8" />}
          title="No forecast data"
          description={
            !selection.state || !selection.species
              ? "Select a state and species to view draw odds forecasts."
              : "No forecast data is available for the selected state and species."
          }
        />
      ) : (
        <div className="space-y-4 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
          {/* Point Creep Trend */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-brand-bark dark:text-brand-cream">
                  Point Creep Trend
                </h3>
                {forecast.trend ? (
                  <div className="flex items-center gap-1">
                    <TrendIcon
                      className={cn(
                        "h-4 w-4",
                        forecast.trend === "rising"
                          ? "text-red-500"
                          : forecast.trend === "declining"
                            ? "text-green-500"
                            : "text-amber-500"
                      )}
                    />
                    <span
                      className={cn(
                        "text-xs font-medium capitalize",
                        forecast.trend === "rising"
                          ? "text-red-500"
                          : forecast.trend === "declining"
                            ? "text-green-500"
                            : "text-amber-500"
                      )}
                    >
                      {forecast.trend}
                    </span>
                  </div>
                ) : (
                  // Bug fix: previously rendered "Stable" alongside the
                  // PointCreepGraph's "Not enough data for trend" empty
                  // state. Suppress when we don't actually have a trend.
                  <span className="text-xs font-medium text-brand-sage italic">
                    pending data
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <PointCreepGraph
                historicalData={forecast.pointCreep.historicalData}
                projectedData={forecast.pointCreep.projectedData}
                userPoints={forecast.pointCreep.userPoints}
                estimatedDrawYear={forecast.pointCreep.estimatedDrawYear}
              />
            </CardContent>
          </Card>

          {/* Draw Odds at Your Point Level */}
          <Card>
            <CardHeader>
              <h3 className="font-semibold text-brand-bark dark:text-brand-cream">
                Draw Odds at Your Point Level
              </h3>
            </CardHeader>
            <CardContent>
              <DrawOddsChart
                percentage={forecast.drawOdds.atCurrentPoints}
                label={`With ${forecast.pointCreep.userPoints} preference points`}
                trend={forecast.drawOdds.trend}
              />
            </CardContent>
          </Card>

          {/* ROI Assessment */}
          <Card className="lg:col-span-2">
            <CardHeader>
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-brand-bark dark:text-brand-cream">
                  ROI Assessment
                </h3>
                <Badge variant={roiInfo.variant} size="md">
                  {roiInfo.label}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-2 mb-4">
                <div className="rounded-lg bg-brand-sage/5 p-2 text-center dark:bg-brand-sage/10">
                  <p className="text-[10px] leading-tight text-brand-sage">Cost/Opp.</p>
                  <p className="text-base font-bold text-brand-bark dark:text-brand-cream">
                    ${forecast.roi.costPerOpportunity.toLocaleString()}
                  </p>
                </div>
                <div className="rounded-lg bg-brand-sage/5 p-2 text-center dark:bg-brand-sage/10">
                  <p className="text-[10px] leading-tight text-brand-sage">Yrs to Draw</p>
                  <p className="text-base font-bold text-brand-bark dark:text-brand-cream">
                    {/* Bug fix: null = unreachable at current trend,
                       0 = already eligible. The previous code rendered
                       both as "~0", which contradicted the "may never
                       reach" rationale shown below. */}
                    {forecast.roi.projectedYears === null
                      ? "Unreachable"
                      : forecast.roi.projectedYears === 0
                        ? "Now"
                        : `~${forecast.roi.projectedYears}`}
                  </p>
                </div>
                <div className="rounded-lg bg-brand-sage/5 p-2 text-center dark:bg-brand-sage/10">
                  <p className="text-[10px] leading-tight text-brand-sage">Total Invest.</p>
                  <p className="text-base font-bold text-brand-bark dark:text-brand-cream">
                    ${forecast.roi.totalInvestment}
                  </p>
                </div>
              </div>

              {/* AI explanation */}
              {forecast.roi.explanation && (
                <div className="rounded-xl bg-brand-forest/5 p-4 dark:bg-brand-sage/10">
                  <h4 className="flex items-center gap-1.5 text-sm font-semibold text-brand-bark dark:text-brand-cream mb-2">
                    <Sparkles className="h-4 w-4 text-brand-sunset" />
                    What this means for you
                  </h4>
                  <p className="text-sm leading-relaxed text-brand-sage">
                    {forecast.roi.explanation}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

export default function ForecastsPage() {
  return (
    <Suspense>
      <ForecastsPageInner />
    </Suspense>
  );
}
