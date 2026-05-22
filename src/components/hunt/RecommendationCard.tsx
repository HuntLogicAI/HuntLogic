"use client";

import { cn, formatCurrency } from "@/lib/utils";
import { useState, useRef } from "react";
import {
  Heart,
  X,
  ChevronDown,
  ChevronUp,
  Target,
  TrendingUp,
  DollarSign,
  Clock,
  Sparkles,
  Send,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { DrawOddsChart } from "./DrawOddsChart";
import { CostBreakdown } from "./CostBreakdown";
import { ScoringFactorsView } from "./ScoringFactorsView";
import type { RecommendationOutput } from "@/services/intelligence/types";

interface RecommendationCardProps {
  recommendation: RecommendationOutput;
  onSave?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onApplyForMe?: (recommendation: RecommendationOutput) => void;
  className?: string;
}

const orientationLabels: Record<string, { label: string; color: string }> = {
  trophy: { label: "Trophy", color: "text-brand-sunset" },
  opportunity: { label: "Opportunity", color: "text-brand-sky" },
  balanced: { label: "Balanced", color: "text-brand-sage" },
  meat: { label: "Meat", color: "text-brand-earth" },
  experience: { label: "Experience", color: "text-brand-forest" },
};

const confidenceVariants: Record<string, "success" | "warning" | "default"> = {
  high: "success",
  medium: "warning",
  low: "default",
};

export function RecommendationCard({
  recommendation,
  onSave,
  onDismiss,
  onApplyForMe,
  className,
}: RecommendationCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isSaved, setIsSaved] = useState(recommendation.status === "saved");
  const cardRef = useRef<HTMLDivElement>(null);
  const startX = useRef(0);
  const currentX = useRef(0);
  const swipeDisabled = useRef(false);

  const { hunt, rationale, costEstimate, confidence, orientation } = recommendation;
  const orientationInfo = orientationLabels[orientation] ?? orientationLabels.balanced!;

  const unitDisplay = hunt.unitCode
    ? `Unit ${hunt.unitCode} ${hunt.speciesName}`
    : hunt.speciesName;
  const locationDisplay = hunt.stateName;

  const handleTouchStart = (e: React.TouchEvent) => {
    // Disable swipe if touch starts on the scrollable metrics row
    const target = e.target as HTMLElement;
    swipeDisabled.current = !!target.closest("[data-metrics-row]");
    startX.current = e.touches[0]?.clientX ?? 0;
    currentX.current = startX.current;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (swipeDisabled.current) return;
    currentX.current = e.touches[0]?.clientX ?? 0;
    const diff = currentX.current - startX.current;
    if (cardRef.current && Math.abs(diff) > 10) {
      cardRef.current.style.transform = `translateX(${diff * 0.3}px)`;
      cardRef.current.style.opacity = `${1 - Math.abs(diff) / 400}`;
    }
  };

  const handleTouchEnd = () => {
    if (swipeDisabled.current) {
      swipeDisabled.current = false;
      return;
    }
    const diff = currentX.current - startX.current;
    if (cardRef.current) {
      cardRef.current.style.transform = "";
      cardRef.current.style.opacity = "";
    }

    if (diff > 80) {
      handleSave();
    } else if (diff < -80) {
      handleDismiss();
    }
  };

  const handleSave = () => {
    setIsSaved(!isSaved);
    onSave?.(recommendation.id ?? "");
  };

  const handleDismiss = () => {
    onDismiss?.(recommendation.id ?? "");
  };

  // Metrics for the horizontal row
  const metrics = [
    {
      label: "Draw Odds",
      value: hunt.latestDrawRate != null ? `${Math.round(hunt.latestDrawRate * 100)}%` : "N/A",
      icon: Target,
    },
    {
      label: "Success Rate",
      value: hunt.latestSuccessRate != null ? `${Math.round(hunt.latestSuccessRate * 100)}%` : "N/A",
      icon: TrendingUp,
    },
    {
      // Label as "Est. Cost" when fee data came from state-specific
      // tables; "Cost (est.)" when we had to fall back to defaults
      // (signals to the user that this is a rough planning number, not
      // a quote — fixes the prod bug where every card showed an
      // identical $1,820 fallback).
      label: costEstimate.isExact ? "Est. Cost" : "Cost (est.)",
      value: formatCurrency(costEstimate.total),
      icon: DollarSign,
    },
    {
      label: "Timeline",
      value: hunt.timelineCategory === "this_year"
        ? "This Year"
        : hunt.timelineCategory === "1-3_years"
          ? "1-3 Years"
          : hunt.timelineCategory === "3-5_years"
            ? "3-5 Years"
            : "5+ Years",
      icon: Clock,
    },
  ];

  return (
    <div
      ref={cardRef}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      className={cn("transition-transform", className)}
    >
      <Card variant="default" className="overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="info" size="sm">
              {hunt.stateCode}
            </Badge>
            <Badge variant="outline" size="sm">
              <span className={orientationInfo.color}>{orientationInfo.label}</span>
            </Badge>
          </div>
          <Badge variant={confidenceVariants[confidence.label] || "default"} size="sm">
            {confidence.label === "high" ? "High" : confidence.label === "medium" ? "Medium" : "Low"} Confidence
          </Badge>
        </div>

        {/* Title */}
        <h3 className="mt-3 text-lg font-bold text-brand-bark dark:text-brand-cream">
          {unitDisplay}
          <span className="text-brand-sage font-normal"> — {locationDisplay}</span>
        </h3>

        {/* Metrics row (horizontal scroll on mobile) */}
        <div data-metrics-row className="mt-3 flex gap-4 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-hide">
          {metrics.map((metric) => {
            const Icon = metric.icon;
            return (
              <div key={metric.label} className="shrink-0">
                <div className="flex items-center gap-1 text-brand-sage">
                  <Icon className="h-3.5 w-3.5" />
                  <span className="text-xs">{metric.label}</span>
                </div>
                <p className="mt-0.5 text-sm font-semibold text-brand-bark dark:text-brand-cream tabular-nums">
                  {metric.value}
                </p>
              </div>
            );
          })}
        </div>

        {/* Truncated rationale */}
        <p
          className={cn(
            "mt-3 text-sm text-brand-sage",
            !isExpanded && "line-clamp-2"
          )}
        >
          {rationale}
        </p>

        {/* Action buttons */}
        <div className="mt-3 flex items-center justify-between">
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              className={cn(
                "flex h-11 w-11 items-center justify-center rounded-full transition-colors",
                isSaved
                  ? "bg-brand-sunset/10 text-brand-sunset"
                  : "bg-brand-sage/10 text-brand-sage hover:bg-brand-sunset/10 hover:text-brand-sunset"
              )}
              aria-label={isSaved ? "Unsave" : "Save"}
            >
              <Heart className="h-5 w-5" fill={isSaved ? "currentColor" : "none"} />
            </button>

            <button
              onClick={handleDismiss}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-sage/10 text-brand-sage transition-colors hover:bg-danger/10 hover:text-danger"
              aria-label="Dismiss"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center gap-1 text-sm font-medium text-brand-sage hover:text-brand-forest transition-colors"
          >
            {isExpanded ? "Less" : "Details"}
            {isExpanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>
        </div>

        {/* Expanded details */}
        {isExpanded && (
          <div className="mt-4 space-y-4 border-t border-brand-sage/10 pt-4 motion-safe:animate-slide-down dark:border-brand-sage/20">
            {/* Full rationale */}
            <div>
              <h4 className="text-sm font-semibold text-brand-bark dark:text-brand-cream flex items-center gap-1">
                <Sparkles className="h-4 w-4 text-brand-sunset" />
                Why this fits you
              </h4>
              <p className="mt-1 text-sm text-brand-sage">{rationale}</p>
            </div>

            {/* Scoring breakdown — shows the per-factor scores and weights
               that produced this recommendation. Builds trust by showing
               our work; addresses the audit recommendation. */}
            <div>
              <h4 className="text-sm font-semibold text-brand-bark dark:text-brand-cream mb-2">
                How we scored it
              </h4>
              <ScoringFactorsView
                factors={hunt.factors}
                weights={hunt.weightsUsed}
              />
            </div>

            {/* Draw odds */}
            {hunt.latestDrawRate != null && (
              <div>
                <h4 className="text-sm font-semibold text-brand-bark dark:text-brand-cream mb-2">
                  Draw Odds
                </h4>
                <DrawOddsChart percentage={hunt.latestDrawRate * 100} />
              </div>
            )}

            {/* Cost breakdown */}
            <div>
              <h4 className="text-sm font-semibold text-brand-bark dark:text-brand-cream mb-2">
                Cost Breakdown
              </h4>
              <CostBreakdown costs={costEstimate} />
            </div>

            {/* Apply for Me CTA */}
            {onApplyForMe && (
              <button
                onClick={() => onApplyForMe(recommendation)}
                className="w-full rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 px-4 py-3 text-sm font-semibold text-white shadow-md transition-all hover:shadow-lg hover:brightness-110 active:scale-[0.98] flex items-center justify-center gap-2"
              >
                <Send className="h-4 w-4" />
                Apply for Me
              </button>
            )}

            {/* Point strategy note */}
            {hunt.hasPoints && hunt.latestAvgPoints != null && (
              <div className="rounded-lg bg-brand-sage/5 p-3 dark:bg-brand-sage/10">
                <p className="text-sm text-brand-sage">
                  <strong className="text-brand-bark dark:text-brand-cream">
                    Point Strategy:
                  </strong>{" "}
                  Average points to draw: {hunt.latestAvgPoints}. Consider{" "}
                  {hunt.latestAvgPoints > 5
                    ? "building points over time"
                    : "applying this year"}
                  .
                </p>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
