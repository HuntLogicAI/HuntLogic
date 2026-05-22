// =============================================================================
// GET /api/v1/groups/[id]/strategy
// =============================================================================
// "Joint application strategy" view for a hunt group.
//
// For each active group member with an active playbook, pull their top
// recommendations and aggregate them into:
//   1. coverage    — distinct (state, species) the group collectively targets
//   2. overlap     — hunts where 2+ members are applying for the SAME unit
//                    (redundant — these are wasted applications)
//   3. splits      — (state, species) pairs where members have overlapping
//                    interest but the group could spread across multiple
//                    units to maximize "someone draws"
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { eq, and, inArray } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  huntGroups,
  huntGroupMembers,
  playbooks,
  recommendations,
  states,
  species,
  huntUnits,
  users,
} from "@/lib/db/schema";

interface MemberRec {
  memberId: string;
  memberEmail: string;
  memberName: string;
  recId: string;
  stateCode: string;
  speciesSlug: string;
  speciesName: string;
  unitCode: string | null;
  recType: string;
  rank: number;
  score: number;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: groupId } = await params;

  // Verify the caller is in the group (or owns it).
  const [group] = await db
    .select()
    .from(huntGroups)
    .where(eq(huntGroups.id, groupId))
    .limit(1);
  if (!group) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  const callerMembership = await db
    .select()
    .from(huntGroupMembers)
    .where(
      and(
        eq(huntGroupMembers.groupId, groupId),
        eq(huntGroupMembers.userId, session.user.id),
      ),
    )
    .limit(1);

  if (
    callerMembership.length === 0 &&
    group.ownerId !== session.user.id
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Get active members (those who have accepted the invite + linked a user).
  const members = await db
    .select({
      memberId: huntGroupMembers.id,
      email: huntGroupMembers.email,
      userId: huntGroupMembers.userId,
      displayName: users.displayName,
    })
    .from(huntGroupMembers)
    .leftJoin(users, eq(huntGroupMembers.userId, users.id))
    .where(
      and(
        eq(huntGroupMembers.groupId, groupId),
        eq(huntGroupMembers.status, "active"),
      ),
    );

  // Active playbooks for those members.
  const memberUserIds = members
    .map((m) => m.userId)
    .filter((id): id is string => !!id);

  if (memberUserIds.length === 0) {
    return NextResponse.json({
      memberCount: 0,
      coverage: [],
      overlap: [],
      splitSuggestions: [],
      note: "No active members with linked accounts yet.",
    });
  }

  const activePlaybookRows = await db
    .select({
      playbookId: playbooks.id,
      userId: playbooks.userId,
    })
    .from(playbooks)
    .where(
      and(
        inArray(playbooks.userId, memberUserIds),
        eq(playbooks.status, "active"),
      ),
    );

  if (activePlaybookRows.length === 0) {
    return NextResponse.json({
      memberCount: members.length,
      coverage: [],
      overlap: [],
      splitSuggestions: [],
      note: "Members haven't generated playbooks yet.",
    });
  }

  const playbookIds = activePlaybookRows.map((p) => p.playbookId);
  const playbookOwner: Record<string, string> = {};
  for (const p of activePlaybookRows) {
    playbookOwner[p.playbookId] = p.userId;
  }

  // Pull every recommendation for the active playbooks, then enforce the
  // top-N-per-playbook cap in-memory. Review feedback (PR #21): the
  // original implementation said "Top 5 recommendations per playbook" but
  // the SQL had no rank cutoff, so coverage/overlap/split outputs were
  // inflated by long-tail recs that members weren't actually prioritizing.
  // Doing the cap in code keeps the SQL simple — we don't need to write a
  // window function — and the row volume is small (active playbooks ×
  // active members for one group).
  const TOP_N_PER_PLAYBOOK = 5;
  const allRecRows = await db
    .select({
      id: recommendations.id,
      playbookId: recommendations.playbookId,
      stateCode: states.code,
      speciesSlug: species.slug,
      speciesName: species.commonName,
      unitCode: huntUnits.unitCode,
      recType: recommendations.recType,
      rank: recommendations.rank,
      score: recommendations.score,
    })
    .from(recommendations)
    .innerJoin(states, eq(recommendations.stateId, states.id))
    .innerJoin(species, eq(recommendations.speciesId, species.id))
    .leftJoin(huntUnits, eq(recommendations.huntUnitId, huntUnits.id))
    .where(inArray(recommendations.playbookId, playbookIds));

  // Enforce the top-N-per-playbook cap. Lower `rank` integers = higher
  // priority; null ranks sink to the bottom so they only show up if a
  // playbook has fewer than N ranked recs.
  const recsByPlaybook = new Map<string, typeof allRecRows>();
  for (const r of allRecRows) {
    const bucket = recsByPlaybook.get(r.playbookId) ?? [];
    bucket.push(r);
    recsByPlaybook.set(r.playbookId, bucket);
  }
  const recRows: typeof allRecRows = [];
  for (const bucket of recsByPlaybook.values()) {
    bucket.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
    recRows.push(...bucket.slice(0, TOP_N_PER_PLAYBOOK));
  }

  // Map recs back to members with display names.
  const memberByUserId = new Map(
    members.map((m) => [
      m.userId ?? "_unknown",
      {
        email: m.email,
        name: m.displayName || m.email.split("@")[0],
      },
    ]),
  );

  const memberRecs: MemberRec[] = [];
  for (const r of recRows) {
    const ownerUserId = playbookOwner[r.playbookId];
    if (!ownerUserId) continue;
    const profile = memberByUserId.get(ownerUserId);
    if (!profile) continue;
    memberRecs.push({
      memberId: ownerUserId,
      memberEmail: profile.email,
      memberName: profile.name ?? profile.email,
      recId: r.id,
      stateCode: r.stateCode,
      speciesSlug: r.speciesSlug,
      speciesName: r.speciesName,
      unitCode: r.unitCode ?? null,
      recType: r.recType,
      rank: r.rank ?? 99,
      score: r.score ?? 0,
    });
  }

  // ── Coverage: distinct (state, species) ──────────────────────────────────
  type CoverageEntry = {
    stateCode: string;
    speciesSlug: string;
    speciesName: string;
    memberNames: string[];
  };
  const coverageMap = new Map<string, CoverageEntry>();
  for (const r of memberRecs) {
    const key = `${r.stateCode}|${r.speciesSlug}`;
    const existing = coverageMap.get(key);
    if (existing) {
      if (!existing.memberNames.includes(r.memberName)) {
        existing.memberNames.push(r.memberName);
      }
    } else {
      coverageMap.set(key, {
        stateCode: r.stateCode,
        speciesSlug: r.speciesSlug,
        speciesName: r.speciesName,
        memberNames: [r.memberName],
      });
    }
  }

  // ── Overlap: (state, species, unit) where 2+ members compete ─────────────
  type OverlapEntry = {
    stateCode: string;
    speciesSlug: string;
    speciesName: string;
    unitCode: string | null;
    members: string[];
  };
  const overlapMap = new Map<string, OverlapEntry>();
  for (const r of memberRecs) {
    if (!r.unitCode) continue; // can't detect unit-level overlap without a unit
    const key = `${r.stateCode}|${r.speciesSlug}|${r.unitCode}`;
    const existing = overlapMap.get(key);
    if (existing) {
      if (!existing.members.includes(r.memberName)) {
        existing.members.push(r.memberName);
      }
    } else {
      overlapMap.set(key, {
        stateCode: r.stateCode,
        speciesSlug: r.speciesSlug,
        speciesName: r.speciesName,
        unitCode: r.unitCode,
        members: [r.memberName],
      });
    }
  }
  const overlap = Array.from(overlapMap.values()).filter(
    (o) => o.members.length >= 2,
  );

  // ── Split suggestions: (state, species) where 2+ members all target the
  // same unit could instead spread across multiple units ───────────────────
  type SplitEntry = {
    stateCode: string;
    speciesSlug: string;
    speciesName: string;
    members: string[];
    currentUnit: string | null;
    suggestion: string;
  };
  const splitSuggestions: SplitEntry[] = overlap.map((o) => ({
    stateCode: o.stateCode,
    speciesSlug: o.speciesSlug,
    speciesName: o.speciesName,
    members: o.members,
    currentUnit: o.unitCode,
    suggestion:
      o.members.length === 2
        ? `Both ${o.members.join(" and ")} are applying for ${o.stateCode} ${o.speciesName} Unit ${o.unitCode}. Consider splitting across two units to double the group's chances — whoever draws hosts.`
        : `${o.members.length} members are all applying for ${o.stateCode} ${o.speciesName} Unit ${o.unitCode}. Spread across ${o.members.length} different units (one per member) for ${o.members.length}× the coverage.`,
  }));

  return NextResponse.json({
    memberCount: members.length,
    coverage: Array.from(coverageMap.values()).sort((a, b) =>
      a.stateCode.localeCompare(b.stateCode),
    ),
    overlap,
    splitSuggestions,
  });
}
