// =============================================================================
// GET /api/v1/admin/chat/sessions
// =============================================================================
// Paginated list of chat sessions for the admin transcript browser.
// Supports a few cheap filters that read off the indexed columns we added
// in migration 0101.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { aiChatSessions, aiChatMessages } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/is-admin";

export async function GET(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin.ok) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const limit = Math.min(100, parseInt(searchParams.get("limit") ?? "50", 10));
  const offset = parseInt(searchParams.get("offset") ?? "0", 10);
  // Filters: ?flagged=1, ?rating=down, ?model=anthropic-direct
  const flaggedOnly = searchParams.get("flagged") === "1";
  const rating = searchParams.get("rating"); // 'up' | 'down'

  // Aggregate per-session metadata: feedback counts, flagged counts, models.
  const rows = await db
    .select({
      id: aiChatSessions.id,
      userId: aiChatSessions.userId,
      title: aiChatSessions.title,
      messageCount: aiChatSessions.messageCount,
      lastMessageAt: aiChatSessions.lastMessageAt,
      createdAt: aiChatSessions.createdAt,
      thumbsUp: sql<number>`(
        SELECT count(*)::int FROM ai_chat_messages
        WHERE ai_chat_messages.session_id = ${aiChatSessions.id}
          AND ai_chat_messages.feedback_rating = 'up'
      )`,
      thumbsDown: sql<number>`(
        SELECT count(*)::int FROM ai_chat_messages
        WHERE ai_chat_messages.session_id = ${aiChatSessions.id}
          AND ai_chat_messages.feedback_rating = 'down'
      )`,
      flaggedCount: sql<number>`(
        SELECT count(*)::int FROM ai_chat_messages
        WHERE ai_chat_messages.session_id = ${aiChatSessions.id}
          AND ai_chat_messages.flagged = true
      )`,
    })
    .from(aiChatSessions)
    .orderBy(desc(aiChatSessions.lastMessageAt))
    .limit(limit)
    .offset(offset);

  let filtered = rows;
  if (flaggedOnly) {
    filtered = filtered.filter((r) => r.flaggedCount > 0);
  }
  if (rating === "down") {
    filtered = filtered.filter((r) => r.thumbsDown > 0);
  } else if (rating === "up") {
    filtered = filtered.filter((r) => r.thumbsUp > 0);
  }

  void eq;
  void aiChatMessages;

  return NextResponse.json({ sessions: filtered, limit, offset });
}
