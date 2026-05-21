"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { PlaybookView } from "@/components/hunt/PlaybookView";
import { SkeletonList } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { BookOpen, Pencil } from "lucide-react";
import type { PlaybookData } from "@/services/intelligence/types";
import { fetchWithCache, invalidateCache } from "@/lib/api/cache";

interface ProfileSummary {
  onboardingComplete?: boolean;
  completeness?: {
    score: number;
    missingCategories: string[];
    isPlaybookReady: boolean;
  };
}

const CATEGORY_LABELS: Record<string, string> = {
  species_interest: "species interests",
  state_interest: "state interests",
  hunt_orientation: "hunt goals",
  timeline: "timeline",
  budget: "budget",
  experience: "existing points",
  travel: "travel tolerance",
  hunt_style: "hunt style",
  weapon: "weapon preferences",
  physical: "physical ability",
  location: "home state",
  land_access: "land access",
};

function PlaybookHeader() {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold text-brand-bark dark:text-brand-cream">
          Playbook
        </h1>
        <p className="mt-1 text-sm text-brand-sage">
          Your personalized multi-year hunting strategy
        </p>
      </div>
      <Link
        href="/profile/preferences"
        className="inline-flex items-center gap-1.5 rounded-lg border border-brand-sage/20 bg-white px-3 py-2 text-sm font-medium text-brand-sage hover:bg-brand-sage/5 hover:text-brand-forest transition-colors dark:bg-brand-bark dark:border-brand-sage/30 dark:hover:bg-brand-sage/10"
      >
        <Pencil className="h-4 w-4" />
        Edit Profile
      </Link>
    </div>
  );
}

export default function PlaybookPage() {
  const [playbook, setPlaybook] = useState<PlaybookData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<ProfileSummary | null>(null);

  useEffect(() => {
    async function fetchPlaybook() {
      try {
        const playbookData = await fetchWithCache<{ playbook: PlaybookData | null }>(
          "/api/v1/playbook",
          { staleMs: 60_000 }
        );
        setPlaybook(playbookData.playbook ?? null);

        try {
          const profileData = await fetchWithCache<{ data?: ProfileSummary; meta?: { completeness?: ProfileSummary["completeness"] } }>(
            "/api/v1/profile",
            { staleMs: 60_000 }
          );
          setProfile({
            onboardingComplete: profileData.data?.onboardingComplete,
            completeness: profileData.meta?.completeness ?? profileData.data?.completeness,
          });
        } catch (profileErr) {
          console.error("[playbook] Failed to fetch profile context:", profileErr);
          setProfile(null);
        }
      } catch (err) {
        // fetchWithCache throws on non-ok responses; treat 404 as no playbook
        console.error("[playbook] Failed to fetch:", err);
        setPlaybook(null);
      } finally {
        setIsLoading(false);
      }
    }

    fetchPlaybook();
  }, []);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/playbook", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setPlaybook(data.playbook ?? null);
        invalidateCache("/api/v1/playbook");
      } else {
        const baseMsg = data.message || data.error || "Failed to generate playbook";
        setError(data.detail ? `${baseMsg}: ${data.detail}` : baseMsg);
      }
    } catch (err) {
      console.error("[playbook] Failed to refresh:", err);
      setError("Something went wrong. Please try again.");
    } finally {
      setIsRefreshing(false);
    }
  };

  if (isLoading) {
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

  const profileComplete = profile?.completeness?.isPlaybookReady ?? false;
  const missingLabels = profile?.completeness?.missingCategories
    ?.slice(0, 3)
    .map((category) => CATEGORY_LABELS[category] ?? category.replace(/_/g, " "))
    .join(", ");

  if (!playbook && profile && !profileComplete) {
    return (
      <div className="space-y-6">
        <PlaybookHeader />
        <EmptyState
          icon={<BookOpen className="h-8 w-8" />}
          title="We need a little more profile data first"
          description={`Your profile is ${profile.completeness?.score ?? 0}% complete. Finish ${missingLabels || "the missing sections"} so the playbook has enough information to build a real strategy.`}
          actionLabel={profile.onboardingComplete ? "Finish Hunt Profile" : "Continue Onboarding"}
          actionHref={profile.onboardingComplete ? "/profile/preferences" : "/onboarding"}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PlaybookHeader />

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          {error}
        </div>
      )}

      <PlaybookView
        playbook={playbook}
        onRefresh={handleRefresh}
        isRefreshing={isRefreshing}
      />
    </div>
  );
}
