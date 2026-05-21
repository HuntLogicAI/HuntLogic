// =============================================================================
// GET    /api/v1/playbook     — Get active playbook for user
// POST   /api/v1/playbook     — Generate new playbook
// PATCH  /api/v1/playbook     — Update playbook (user modifications/notes)
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { playbooks } from "@/lib/db/schema";

import {
  generatePlaybook,
  getPlaybook,
} from "@/services/intelligence/playbook-generator";
import { getProfile } from "@/services/profile/profile-service";

const LOG_PREFIX = "[api:playbook]";

// =============================================================================
// GET — Get active playbook
// =============================================================================

export async function GET() {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    console.log(`${LOG_PREFIX} GET: userId=${userId}`);

    const playbook = await getPlaybook(userId);

    if (!playbook) {
      return NextResponse.json({
        playbook: null,
        message:
          "No active playbook found. Generate one by POST-ing to /api/v1/playbook.",
      });
    }

    return NextResponse.json({
      playbook,
    });
  } catch (error) {
    console.error(`${LOG_PREFIX} GET error:`, error);
    return NextResponse.json(
      { error: "Failed to fetch playbook" },
      { status: 500 }
    );
  }
}

// =============================================================================
// POST — Generate new playbook
// =============================================================================

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    console.log(`${LOG_PREFIX} POST: generating playbook for userId=${userId}`);

    // Check profile completeness first
    const profile = await getProfile(userId);
    if (profile.completeness.score < 60) {
      return NextResponse.json(
        {
          error: "Profile not complete enough to generate a playbook",
          completeness: profile.completeness.score,
          minimum: 60,
          missingCategories: profile.completeness.missingCategories,
          message:
            "Complete your profile to at least 60% before generating a playbook. " +
            `Missing: ${profile.completeness.missingCategories.join(", ")}.`,
        },
        { status: 422 }
      );
    }

    // Generate the playbook (this runs the full pipeline)
    const playbook = await generatePlaybook(userId);

    return NextResponse.json(
      {
        playbook,
        message: `Playbook v${playbook.version} generated with ${
          playbook.nearTerm.length + playbook.midTerm.length + playbook.longTerm.length
        } recommendations.`,
      },
      { status: 201 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const stack = error instanceof Error ? error.stack : undefined;
    console.error(`${LOG_PREFIX} POST error:`, message, stack);

    // Distinguish between validation errors and server errors
    if (
      message.includes("Profile completeness") ||
      message.includes("No hunt candidates")
    ) {
      return NextResponse.json(
        { error: message },
        { status: 422 }
      );
    }

    return NextResponse.json(
      {
        error: "Failed to generate playbook",
        detail: message,
      },
      { status: 500 }
    );
  }
}

// =============================================================================
// PATCH — Update playbook (user modifications/notes)
// =============================================================================

export async function PATCH(request: NextRequest) {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { playbookId, notes, goalsSummary } = body;

    if (!playbookId) {
      return NextResponse.json(
        { error: "playbookId is required" },
        { status: 400 }
      );
    }

    console.log(`${LOG_PREFIX} PATCH: updating playbook ${playbookId}`);

    // Verify ownership
    const existing = await db.query.playbooks.findFirst({
      where: and(eq(playbooks.id, playbookId), eq(playbooks.userId, userId)),
    });

    if (!existing) {
      return NextResponse.json(
        { error: "Playbook not found" },
        { status: 404 }
      );
    }

    // Build update payload
    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (goalsSummary) {
      const existingGoals = (existing.goalsSummary ?? {}) as Record<string, unknown>;
      updateData.goalsSummary = {
        ...existingGoals,
        ...(typeof goalsSummary === "string"
          ? { summary: goalsSummary }
          : goalsSummary),
      };
    }

    if (notes) {
      const existingStrategy = (existing.strategyData ?? {}) as Record<string, unknown>;
      updateData.strategyData = {
        ...existingStrategy,
        userNotes: notes,
      };
    }

    await db
      .update(playbooks)
      .set(updateData)
      .where(eq(playbooks.id, playbookId));

    return NextResponse.json({
      success: true,
      playbookId,
      message: "Playbook updated.",
    });
  } catch (error) {
    console.error(`${LOG_PREFIX} PATCH error:`, error);
    return NextResponse.json(
      { error: "Failed to update playbook" },
      { status: 500 }
    );
  }
}
