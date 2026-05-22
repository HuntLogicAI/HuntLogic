// =============================================================================
// GET /api/v1/admin/chat/sessions
// =============================================================================
// Paginated list of chat sessions for the admin transcript browser.
// Supports a few cheap filters that read off the indexed columns we added
// in migration 0101.
//
// Filters are pushed into the SQL WHERE clause via EXISTS subqueries so
// that pagination (limit/offset) operates on the already-filtered set.
// Doing the filtering in JS after .limit() — the original implementation
// — produced short/missing pages when filters were active (review feedback
// PR #16).
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { desc, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { aiChatSessions } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/is-admin";

export async function GET(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin.ok) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const limit = Math.min(100, parseInt(searchParams.get("limit") ?? "50", 10));
  const offset = parseInt(searchParams.get("offset") ?? "0", 10);
  // Filters: ?flagged=1, ?rating=up|down
  const flaggedOnly = searchParams.get("flagged") === "1";
  const rating = searchParams.get("rating");

  // Build EXISTS subqueries for any active filters. Using EXISTS lets us
  // keep the per-session count subqueries below as-is while still
  // narrowing the parent set BEFORE limit/offset are applied.
  const whereClauses: SQL[] = [];
  if (flaggedOnly) {
    whereClauses.push(
      sql`EXISTS (
        SELECT 1 FROM ai_chat_messages
        WHERE ai_chat_messages.session_id = ${aiChatSessions.id}
          AND ai_chat_messages.flagged = true
      )`,
    );
  }
  if (rating === "down") {
    whereClauses.push(
      sql`EXISTS (
        SELECT 1 FROM ai_chat_messages
        WHERE ai_chat_messages.session_id = ${aiChatSessions.id}
          AND ai_chat_messages.feedback_rating = 'down'
      )`,
    );
  } else if (rating === "up") {
    whereClauses.push(
      sql`EXISTS (
        SELECT 1 FROM ai_chat_messages
        WHERE ai_chat_messages.session_id = ${aiChatSessions.id}
          AND ai_chat_messages.feedback_rating = 'up'
      )`,
    );
  }

  // Concatenate clauses with AND if multiple. Drizzle's `and()` would
  // also work; we use a manual SQL chain because the clauses are already
  // raw SQL fragments.
  const combinedWhere: SQL | undefined =
    whereClauses.length === 0
      ? undefined
      : whereClauses.length === 1
        ? whereClauses[0]
        : sql.join(whereClauses, sql` AND `);

  const baseQuery = db
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
    .$dynamic();

  const filteredQuery = combinedWhere
    ? baseQuery.where(combinedWhere)
    : baseQuery;

  const sessions = await filteredQuery
    .orderBy(desc(aiChatSessions.lastMessageAt))
    .limit(limit)
    .offset(offset);

  return NextResponse.json({ sessions, limit, offset });
}
