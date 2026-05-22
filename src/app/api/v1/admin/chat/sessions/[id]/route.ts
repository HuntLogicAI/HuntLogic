// =============================================================================
// GET /api/v1/admin/chat/sessions/[id]
// =============================================================================
// Full transcript for a single session — all messages + observability
// metadata. Used by the admin drill-down view.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { eq, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { aiChatSessions, aiChatMessages } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/is-admin";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireAdmin();
  if (!admin.ok) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id: sessionId } = await params;

  const [sessionRow] = await db
    .select()
    .from(aiChatSessions)
    .where(eq(aiChatSessions.id, sessionId))
    .limit(1);

  if (!sessionRow) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const messages = await db
    .select()
    .from(aiChatMessages)
    .where(eq(aiChatMessages.sessionId, sessionId))
    .orderBy(asc(aiChatMessages.createdAt));

  return NextResponse.json({ session: sessionRow, messages });
}
