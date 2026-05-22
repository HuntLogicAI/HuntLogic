// =============================================================================
// GET /api/v1/admin/chat/top-questions
// =============================================================================
// Cheap top-questions aggregation — normalizes question text and counts
// occurrences over a configurable lookback window. Not embedding-based
// (yet); the substring-bucketing here is good enough to surface obvious
// patterns and seed prompt-improvement work. A future PR can swap this
// for an embedding-cluster pass using Gemini embeddings (we already have
// the index in `documents.embedding`).
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { eq, gte, and, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { aiChatMessages } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/is-admin";

export async function GET(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin.ok) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const days = Math.min(90, parseInt(searchParams.get("days") ?? "7", 10));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({ content: aiChatMessages.content })
    .from(aiChatMessages)
    .where(
      and(
        eq(aiChatMessages.role, "user"),
        gte(aiChatMessages.createdAt, since),
      ),
    );

  // Normalize: lowercase, strip punctuation, collapse whitespace, drop
  // very short questions (single words rarely cluster meaningfully).
  const buckets = new Map<string, { example: string; count: number }>();
  for (const r of rows) {
    const text = r.content.trim();
    if (text.length < 12) continue;
    const norm = text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    if (norm.length < 8) continue;
    const existing = buckets.get(norm);
    if (existing) {
      existing.count++;
    } else {
      buckets.set(norm, { example: text, count: 1 });
    }
  }

  const top = Array.from(buckets.entries())
    .map(([norm, v]) => ({ key: norm, example: v.example, count: v.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);

  void sql;
  return NextResponse.json({ window_days: days, top });
}
