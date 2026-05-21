"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  Users,
  Plus,
  Mail,
  CheckCircle,
  Clock,
  ArrowLeft,
} from "lucide-react";
import Link from "next/link";
import { GroupStrategyView } from "@/components/groups/GroupStrategyView";

interface GroupMember {
  id: string;
  email: string;
  role: string;
  status: string;
  userId: string | null;
}

interface GroupPlan {
  id: string;
  stateCode: string;
  speciesSlug: string;
  unitCode: string | null;
  year: number;
  status: string;
  notes: string | null;
}

interface GroupDetail {
  id: string;
  name: string;
  description: string | null;
  targetYear: number | null;
  isOwner: boolean;
  members: GroupMember[];
  plans: GroupPlan[];
}

export default function GroupDetailPage() {
  const params = useParams();
  const router = useRouter();
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [showAddPlan, setShowAddPlan] = useState(false);
  const [planState, setPlanState] = useState("");
  const [planSpecies, setPlanSpecies] = useState("");
  const [planYear, setPlanYear] = useState(new Date().getFullYear() + 1);

  const fetchGroup = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/groups/${params.id}`);
      if (res.ok) {
        setGroup(await res.json());
      } else if (res.status === 404) {
        router.push("/groups");
      }
    } catch {
      // Silent fail
    } finally {
      setLoading(false);
    }
  }, [params.id, router]);

  useEffect(() => {
    fetchGroup();
  }, [fetchGroup]);

  const inviteMember = async () => {
    if (!inviteEmail) return;
    setInviting(true);
    try {
      await fetch(`/api/v1/groups/${params.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail }),
      });
      setInviteEmail("");
      fetchGroup();
    } catch {
      // Silent fail
    } finally {
      setInviting(false);
    }
  };

  const addPlan = async () => {
    if (!planState || !planSpecies) return;
    try {
      await fetch(`/api/v1/groups/${params.id}/plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stateCode: planState,
          speciesSlug: planSpecies,
          year: planYear,
        }),
      });
      setShowAddPlan(false);
      setPlanState("");
      setPlanSpecies("");
      fetchGroup();
    } catch {
      // Silent fail
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 rounded-lg bg-brand-sage/10 motion-safe:animate-pulse dark:bg-brand-sage/20" />
        <div className="h-40 rounded-xl bg-brand-sage/10 motion-safe:animate-pulse dark:bg-brand-sage/20" />
        <div className="h-40 rounded-xl bg-brand-sage/10 motion-safe:animate-pulse dark:bg-brand-sage/20" />
      </div>
    );
  }

  if (!group) return null;

  return (
    <div className="space-y-6">
      {/* Back + Header */}
      <div>
        <Link
          href="/groups"
          className="mb-3 flex items-center gap-1 text-sm text-brand-sage hover:text-brand-forest"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Groups
        </Link>
        <h1 className="text-2xl font-bold text-brand-bark dark:text-brand-cream">
          {group.name}
        </h1>
        {group.description && (
          <p className="mt-1 text-sm text-brand-sage">{group.description}</p>
        )}
        {group.targetYear && (
          <p className="mt-0.5 text-xs text-brand-sage">
            Target: {group.targetYear}
          </p>
        )}
      </div>

      {/* Members */}
      <div className="rounded-xl border border-brand-sage/10 bg-white p-5 shadow-sm dark:border-brand-sage/20 dark:bg-brand-bark">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-brand-bark dark:text-brand-cream">
            <Users className="h-4 w-4" />
            Members ({group.members.length})
          </h2>
        </div>

        <div className="space-y-2">
          {group.members.map((member) => (
            <div
              key={member.id}
              className="flex items-center justify-between rounded-lg px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-forest/10 text-xs font-bold text-brand-forest dark:bg-brand-sage/20 dark:text-brand-cream">
                  {member.email.charAt(0).toUpperCase()}
                </div>
                <div>
                  <p className="text-sm text-brand-bark dark:text-brand-cream">
                    {member.email}
                  </p>
                  <p className="text-xs text-brand-sage">{member.role}</p>
                </div>
              </div>
              <span
                className={cn(
                  "flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
                  member.status === "active"
                    ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                    : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                )}
              >
                {member.status === "active" ? (
                  <CheckCircle className="h-3 w-3" />
                ) : (
                  <Clock className="h-3 w-3" />
                )}
                {member.status}
              </span>
            </div>
          ))}
        </div>

        {/* Invite */}
        {group.isOwner && (
          <div className="mt-3 flex gap-2">
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="Invite by email..."
              className="min-h-[44px] flex-1 rounded-[10px] border border-brand-sage/20 bg-white px-3 py-2 text-sm text-brand-bark placeholder:text-brand-sage/50 dark:border-brand-sage/30 dark:bg-brand-bark/50 dark:text-brand-cream"
            />
            <button
              onClick={inviteMember}
              disabled={inviting || !inviteEmail}
              className="flex min-h-[44px] items-center gap-1.5 rounded-[8px] bg-gradient-cta px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              <Mail className="h-4 w-4" />
              {inviting ? "..." : "Invite"}
            </button>
          </div>
        )}
      </div>

      {/* Joint application strategy — pulls each active member's playbook,
         aggregates coverage, flags duplicates, suggests splits. */}
      <GroupStrategyView groupId={group.id} />

      {/* Plans */}
      <div className="rounded-xl border border-brand-sage/10 bg-white p-5 shadow-sm dark:border-brand-sage/20 dark:bg-brand-bark">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-brand-bark dark:text-brand-cream">
            Hunt Plans ({group.plans.length})
          </h2>
          <button
            onClick={() => setShowAddPlan(!showAddPlan)}
            className="flex min-h-[44px] items-center gap-1 rounded-[8px] border border-brand-sage/20 px-3 py-2 text-sm font-medium text-brand-sage transition-colors hover:bg-brand-sage/5 dark:border-brand-sage/30"
          >
            <Plus className="h-4 w-4" />
            Add Plan
          </button>
        </div>

        {showAddPlan && (
          <div className="mb-3 flex gap-2">
            <input
              type="text"
              value={planState}
              onChange={(e) => setPlanState(e.target.value)}
              placeholder="State (CO)"
              className="min-h-[44px] w-20 rounded-[10px] border border-brand-sage/20 bg-white px-3 py-2 text-sm text-brand-bark dark:border-brand-sage/30 dark:bg-brand-bark/50 dark:text-brand-cream"
            />
            <input
              type="text"
              value={planSpecies}
              onChange={(e) => setPlanSpecies(e.target.value)}
              placeholder="Species (elk)"
              className="min-h-[44px] flex-1 rounded-[10px] border border-brand-sage/20 bg-white px-3 py-2 text-sm text-brand-bark dark:border-brand-sage/30 dark:bg-brand-bark/50 dark:text-brand-cream"
            />
            <input
              type="number"
              value={planYear}
              onChange={(e) => setPlanYear(parseInt(e.target.value) || 0)}
              className="min-h-[44px] w-24 rounded-[10px] border border-brand-sage/20 bg-white px-3 py-2 text-sm text-brand-bark dark:border-brand-sage/30 dark:bg-brand-bark/50 dark:text-brand-cream"
            />
            <button
              onClick={addPlan}
              className="flex min-h-[44px] items-center rounded-[8px] bg-brand-forest px-4 py-2 text-sm font-semibold text-white"
            >
              Add
            </button>
          </div>
        )}

        {group.plans.length === 0 ? (
          <p className="text-sm text-brand-sage">No plans yet. Add a hunt to get started!</p>
        ) : (
          <div className="space-y-2">
            {group.plans.map((plan) => (
              <div
                key={plan.id}
                className="flex items-center justify-between rounded-lg border border-brand-sage/10 px-3 py-2 dark:border-brand-sage/20"
              >
                <div>
                  <p className="text-sm font-medium text-brand-bark dark:text-brand-cream">
                    {plan.stateCode} — {plan.speciesSlug}
                    {plan.unitCode && ` (Unit ${plan.unitCode})`}
                  </p>
                  <p className="text-xs text-brand-sage">{plan.year}</p>
                </div>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-xs font-medium",
                    plan.status === "confirmed"
                      ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                      : "bg-brand-sage/10 text-brand-sage"
                  )}
                >
                  {plan.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
