"use client";

import { useState, useEffect, useCallback } from "react";
import { AlertBanner } from "@/components/dashboard/AlertBanner";
import { ConciergeChatCard } from "@/components/dashboard/ConciergeChatCard";
import { StrategySnapshot } from "@/components/dashboard/StrategySnapshot";
import { DeadlineWidget } from "@/components/dashboard/DeadlineWidget";
import { ActionFeed } from "@/components/dashboard/ActionFeed";
import { WhatChanged } from "@/components/dashboard/WhatChanged";
import { SkeletonList } from "@/components/ui/Skeleton";
import { apiClient } from "@/lib/api/client";

interface DashboardData {
  userName: string;
  alerts: { id: string; type: "urgent" | "info" | "success"; message: string; ctaLabel?: string; ctaHref?: string }[];
  deadlines: { id: string; state: string; stateCode: string; title: string; date: string; type: string }[];
  actions: { id: string; title: string; description?: string; type: "deadline" | "application" | "points" | "general"; priority: "urgent" | "high" | "medium" | "low"; dueDate?: string; actionUrl?: string; completed?: boolean }[];
  strategy: {
    statesActive: number;
    speciesTracked: number;
    pointsBuilding: number;
    nextDeadline: string | null;
    playbookExists: boolean;
    playbookStale: boolean;
    lastUpdated: string | null;
  };
}

export default function DashboardPage() {
  const [isLoading, setIsLoading] = useState(true);
  const [data, setData] = useState<DashboardData | null>(null);

  const fetchDashboard = useCallback(async () => {
    try {
      // Fetch session first to get user name — use cache for data that doesn't change every second
      const [sessionRes, deadlinesRes, actionsRes, recsRes, profileRes] = await Promise.all([
        apiClient.getCached<{ authenticated: boolean; user?: { name?: string; id?: string } }>("/auth/session", { staleMs: 30_000 }),
        apiClient.getCached<{ deadlines: { id: string; stateName: string; stateCode: string; title: string; deadlineDate: string; deadlineType: string }[] }>("/deadlines?upcoming=true", { staleMs: 30_000 }),
        apiClient.getCached<{ actions: { id: string; title: string; description?: string; actionType: string; priority: string; dueDate?: string; metadata?: { actionUrl?: string }; status?: string }[] }>("/actions", { staleMs: 30_000 }),
        apiClient.getCached<{ recommendations: { id: string; stateCode?: string; speciesSlug?: string }[]; playbookId?: string }>("/recommendations", { staleMs: 30_000 }),
        apiClient.getCached<{ data: { pointHoldings?: { stateCode: string; points: number }[] } }>("/profile", { staleMs: 30_000 }),
      ]);

      const userName = sessionRes.data?.user?.name?.split(" ")[0] || "Hunter";

      // Map deadlines to component shape
      const deadlines = (deadlinesRes.data?.deadlines ?? []).map((d) => ({
        id: d.id,
        state: d.stateName ?? "",
        stateCode: d.stateCode ?? "",
        title: d.title,
        date: d.deadlineDate,
        type: d.deadlineType ?? "Application",
      }));

      // Generate alerts from upcoming deadlines (within 7 days = urgent)
      const now = Date.now();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      const alerts = deadlines
        .filter((d) => {
          const diff = new Date(d.date).getTime() - now;
          return diff > 0 && diff < sevenDays;
        })
        .map((d) => {
          // Deadline titles already begin with the state code (e.g. "WY Elk
          // Nonresident Draw Results"), so only prepend the state code when
          // it's missing — avoids "WY WY ..." double-prefix.
          const titleHasState = d.stateCode && d.title.startsWith(`${d.stateCode} `);
          const displayTitle = titleHasState ? d.title : `${d.stateCode} ${d.title}`.trim();
          return {
            id: `alert-${d.id}`,
            type: "urgent" as const,
            message: `${displayTitle} — deadline in ${Math.ceil((new Date(d.date).getTime() - now) / (24 * 60 * 60 * 1000))} days`,
            ctaLabel: "View",
            ctaHref: "/calendar",
          };
        });

      // Map actions to component shape
      const priorityMap: Record<string, "urgent" | "high" | "medium" | "low"> = {
        critical: "urgent",
        high: "high",
        medium: "medium",
        low: "low",
      };
      const typeMap: Record<string, "deadline" | "application" | "points" | "general"> = {
        apply: "application",
        buy_points: "points",
        complete_application: "application",
        verify_hunter_ed: "general",
        review_strategy: "general",
      };
      const actions = (actionsRes.data?.actions ?? []).map((a) => ({
        id: a.id,
        title: a.title,
        description: a.description,
        type: typeMap[a.actionType] ?? ("general" as const),
        priority: priorityMap[a.priority] ?? ("medium" as const),
        dueDate: a.dueDate ?? undefined,
        actionUrl: (a.metadata as Record<string, string> | undefined)?.actionUrl,
        completed: a.status === "completed",
      }));

      // Derive strategy snapshot
      const recs = recsRes.data?.recommendations ?? [];
      const uniqueStates = new Set(recs.map((r) => r.stateCode).filter(Boolean));
      const uniqueSpecies = new Set(recs.map((r) => r.speciesSlug).filter(Boolean));
      const pointHoldings = profileRes.data?.data?.pointHoldings ?? [];
      const totalPoints = Array.isArray(pointHoldings)
        ? pointHoldings.reduce((sum: number, p: { points: number }) => sum + (p.points ?? 0), 0)
        : 0;
      const nextDeadline = deadlines.length > 0 ? deadlines[0]!.date : null;

      setData({
        userName,
        alerts,
        deadlines,
        actions,
        strategy: {
          statesActive: uniqueStates.size,
          speciesTracked: uniqueSpecies.size,
          pointsBuilding: totalPoints,
          nextDeadline,
          playbookExists: !!recsRes.data?.playbookId,
          playbookStale: false,
          lastUpdated: null,
        },
      });
    } catch (error) {
      console.error("[dashboard] Failed to load:", error);
      // Graceful degradation — show empty state
      setData({
        userName: "Hunter",
        alerts: [],
        deadlines: [],
        actions: [],
        strategy: {
          statesActive: 0,
          speciesTracked: 0,
          pointsBuilding: 0,
          nextDeadline: null,
          playbookExists: false,
          playbookStale: false,
          lastUpdated: null,
        },
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  const handleCompleteAction = async (actionId: string) => {
    await apiClient.post("/actions", { actionId, status: "completed" });
    fetchDashboard();
  };

  const now = new Date();
  const greeting = now.getHours() < 12 ? "Good morning" : now.getHours() < 18 ? "Good afternoon" : "Good evening";
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  if (isLoading || !data) {
    return (
      <div className="space-y-6">
        <div>
          <div className="h-7 w-48 motion-safe:animate-pulse rounded-lg bg-brand-sage/10" />
          <div className="mt-1 h-5 w-32 motion-safe:animate-pulse rounded-lg bg-brand-sage/10" />
        </div>
        <SkeletonList count={3} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Greeting */}
      <div>
        <h1 className="text-2xl font-bold text-brand-bark dark:text-brand-cream">
          {greeting}, {data.userName}
        </h1>
        <p className="mt-0.5 text-sm text-brand-sage">{dateStr}</p>
      </div>

      {/* Alerts */}
      <AlertBanner alerts={data.alerts} />

      {/* Concierge chat — Mitch April 30 review #2: chat as a core dashboard feature. */}
      <ConciergeChatCard userName={data.userName} />

      {/* What Changed */}
      <WhatChanged />

      {/* Strategy + Deadlines grid */}
      <div className="grid gap-4 lg:grid-cols-2">
        <StrategySnapshot {...data.strategy} />
        <DeadlineWidget deadlines={data.deadlines} />
      </div>

      {/* Action Feed */}
      <ActionFeed actions={data.actions} onComplete={handleCompleteAction} />
    </div>
  );
}
