"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  MessageSquare,
  ThumbsUp,
  ThumbsDown,
  Flag,
  TrendingUp,
  ChevronRight,
} from "lucide-react";

interface AdminSession {
  id: string;
  userId: string;
  title: string | null;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
  thumbsUp: number;
  thumbsDown: number;
  flaggedCount: number;
}

interface TopQuestion {
  key: string;
  example: string;
  count: number;
}

type Filter = "all" | "flagged" | "down" | "up";

export default function AdminChatPage() {
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [topQuestions, setTopQuestions] = useState<TopQuestion[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const qs = new URLSearchParams();
        if (filter === "flagged") qs.set("flagged", "1");
        else if (filter === "down") qs.set("rating", "down");
        else if (filter === "up") qs.set("rating", "up");
        const [sRes, qRes] = await Promise.all([
          fetch(`/api/v1/admin/chat/sessions?${qs.toString()}`),
          fetch(`/api/v1/admin/chat/top-questions?days=${days}`),
        ]);
        if (sRes.status === 403 || qRes.status === 403) {
          if (!cancelled) setForbidden(true);
          return;
        }
        const sJson = await sRes.json();
        const qJson = await qRes.json();
        if (cancelled) return;
        setSessions(sJson.sessions ?? []);
        setTopQuestions(qJson.top ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [filter, days]);

  if (forbidden) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-brand-bark dark:text-brand-cream">
          Admin
        </h1>
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          You don&apos;t have admin access. Ask the owner to add your email to
          the <code>ADMIN_EMAILS</code> env var.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-brand-bark dark:text-brand-cream">
          Chat observability
        </h1>
        <p className="mt-1 text-sm text-brand-sage">
          Transcript browser, scoring, and top-questions clustering.
        </p>
      </div>

      {/* Top questions */}
      <section className="rounded-xl border border-brand-sage/10 bg-white p-4 dark:border-brand-sage/20 dark:bg-brand-bark">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-brand-sunset" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-brand-sage">
              Top questions
            </h2>
          </div>
          <div className="flex items-center gap-2 text-xs">
            {[7, 14, 30].map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={
                  d === days
                    ? "rounded bg-brand-forest px-2 py-0.5 text-white"
                    : "rounded px-2 py-0.5 text-brand-sage hover:text-brand-bark"
                }
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
        {loading ? (
          <p className="text-sm text-brand-sage">Loading…</p>
        ) : topQuestions.length === 0 ? (
          <p className="text-sm text-brand-sage">No user questions in this window yet.</p>
        ) : (
          <ol className="space-y-1.5">
            {topQuestions.slice(0, 15).map((q) => (
              <li
                key={q.key}
                className="flex items-start justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-brand-sage/5"
              >
                <span className="line-clamp-2 text-sm text-brand-bark dark:text-brand-cream">
                  {q.example}
                </span>
                <span className="shrink-0 rounded-full bg-brand-sage/10 px-2 py-0.5 text-xs font-medium text-brand-sage">
                  ×{q.count}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Sessions */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-brand-forest" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-brand-sage">
              Recent sessions
            </h2>
          </div>
          <div className="flex items-center gap-2 text-xs">
            {(
              [
                { v: "all", label: "All" },
                { v: "flagged", label: "Flagged" },
                { v: "down", label: "Negative" },
                { v: "up", label: "Positive" },
              ] as { v: Filter; label: string }[]
            ).map((f) => (
              <button
                key={f.v}
                onClick={() => setFilter(f.v)}
                className={
                  f.v === filter
                    ? "rounded bg-brand-forest px-2 py-0.5 text-white"
                    : "rounded px-2 py-0.5 text-brand-sage hover:text-brand-bark"
                }
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        {loading ? (
          <p className="text-sm text-brand-sage">Loading…</p>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-brand-sage">
            No sessions match this filter yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {sessions.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/admin/chat/${s.id}`}
                  className="flex items-center justify-between gap-3 rounded-xl border border-brand-sage/10 bg-white px-4 py-3 transition-colors hover:bg-brand-sage/5 dark:border-brand-sage/20 dark:bg-brand-bark"
                >
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-1 text-sm font-medium text-brand-bark dark:text-brand-cream">
                      {s.title ?? "(no title)"}
                    </p>
                    <p className="mt-0.5 text-[11px] text-brand-sage">
                      {s.messageCount} msgs ·{" "}
                      {s.lastMessageAt
                        ? new Date(s.lastMessageAt).toLocaleString()
                        : "—"}{" "}
                      · user {s.userId.slice(0, 8)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-xs">
                    {s.thumbsUp > 0 && (
                      <span className="flex items-center gap-0.5 text-brand-forest">
                        <ThumbsUp className="h-3 w-3" />
                        {s.thumbsUp}
                      </span>
                    )}
                    {s.thumbsDown > 0 && (
                      <span className="flex items-center gap-0.5 text-red-600">
                        <ThumbsDown className="h-3 w-3" />
                        {s.thumbsDown}
                      </span>
                    )}
                    {s.flaggedCount > 0 && (
                      <span className="flex items-center gap-0.5 text-amber-600">
                        <Flag className="h-3 w-3" />
                        {s.flaggedCount}
                      </span>
                    )}
                    <ChevronRight className="h-4 w-4 text-brand-sage" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
