// =============================================================================
// POST /api/v1/chat/messages/[id]/feedback
// =============================================================================
// Records a user's thumbs-up / thumbs-down (+ optional free-text reason) on
// a previously-persisted assistant chat message. The signed-in user must
// own the parent session — no cross-user rating.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { aiChatMessages, aiChatSessions } from "@/lib/db/schema";

interface FeedbackBody {
  rating: "up" | "down";
  reason?: string | null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: messageId } = await params;
  if (!messageId) {
    return NextResponse.json({ error: "messageId is required" }, { status: 400 });
  }

  let body: FeedbackBody;
  try {
    body = (await request.json()) as FeedbackBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.rating !== "up" && body.rating !== "down") {
    return NextResponse.json(
      { error: "rating must be 'up' or 'down'" },
      { status: 400 },
    );
  }

  // Look up the message and verify the user owns its session.
  const [msg] = await db
    .select({
      messageId: aiChatMessages.id,
      sessionId: aiChatMessages.sessionId,
      role: aiChatMessages.role,
      ownerUserId: aiChatSessions.userId,
    })
    .from(aiChatMessages)
    .innerJoin(
      aiChatSessions,
      eq(aiChatMessages.sessionId, aiChatSessions.id),
    )
    .where(eq(aiChatMessages.id, messageId))
    .limit(1);

  if (!msg) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }
  if (msg.ownerUserId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (msg.role !== "assistant") {
    return NextResponse.json(
      { error: "Only assistant messages can be rated" },
      { status: 400 },
    );
  }

  // Trim and length-cap the reason text — keep DB rows lean.
  const reasonClean =
    typeof body.reason === "string"
      ? body.reason.trim().slice(0, 500) || null
      : null;

  await db
    .update(aiChatMessages)
    .set({
      feedbackRating: body.rating,
      feedbackReason: reasonClean,
      feedbackAt: new Date(),
      // Auto-flag thumbs-down messages for the ops review queue so they
      // surface even without an explicit ops action.
      flagged: body.rating === "down" ? true : undefined,
      flaggedReason: body.rating === "down" ? "user_thumbs_down" : undefined,
    })
    .where(eq(aiChatMessages.id, messageId));

  return NextResponse.json({ success: true });
}
