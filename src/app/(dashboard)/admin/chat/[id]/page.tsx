"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  ThumbsUp,
  ThumbsDown,
  Flag,
  Clock,
  Cpu,
} from "lucide-react";

interface AdminMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  feedbackRating: "up" | "down" | null;
  feedbackReason: string | null;
  flagged: boolean;
  flaggedReason: string | null;
  model: string | null;
  latencyMs: number | null;
  tokenCount: number | null;
  contextSummary: string | null;
}

interface AdminSession {
  id: string;
  userId: string;
  title: string | null;
  messageCount: number;
  createdAt: string;
}

export default function AdminChatDetailPage() {
  const params = useParams();
  const id = params?.id as string | undefined;
  const [session, setSession] = useState<AdminSession | null>(null);
  const [messages, setMessages] = useState<AdminMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(`/api/v1/admin/chat/sessions/${id}`);
        if (res.status === 403) {
          if (!cancelled) setForbidden(true);
          return;
        }
        const json = await res.json();
        if (cancelled) return;
        setSession(json.session);
        setMessages(json.messages ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (forbidden) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
        Forbidden.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Link
        href="/admin/chat"
        className="inline-flex items-center gap-1 text-sm text-brand-sage hover:text-brand-forest"
      >
        <ArrowLeft className="h-4 w-4" /> Back to sessions
      </Link>

      {loading || !session ? (
        <p className="text-sm text-brand-sage">Loading…</p>
      ) : (
        <>
          <div>
            <h1 className="text-xl font-bold text-brand-bark dark:text-brand-cream">
              {session.title ?? "(no title)"}
            </h1>
            <p className="mt-0.5 text-xs text-brand-sage">
              {messages.length} messages · user {session.userId.slice(0, 8)} ·
              opened {new Date(session.createdAt).toLocaleString()}
            </p>
          </div>

          <ol className="space-y-3">
            {messages.map((m) => (
              <li
                key={m.id}
                className={
                  m.role === "user"
                    ? "rounded-xl border border-brand-sage/15 bg-brand-sage/5 p-3 dark:bg-brand-sage/10"
                    : "rounded-xl border border-brand-sage/15 bg-white p-3 dark:bg-brand-bark"
                }
              >
                <div className="mb-1 flex items-center justify-between text-xs text-brand-sage">
                  <span className="font-medium uppercase">
                    {m.role === "user" ? "Hunter" : "Grizz"}
                  </span>
                  <span>{new Date(m.createdAt).toLocaleString()}</span>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-brand-bark dark:text-brand-cream">
                  {m.content}
                </p>
                {m.role === "assistant" && (
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-brand-sage">
                    {m.feedbackRating === "up" && (
                      <span className="flex items-center gap-1 text-brand-forest">
                        <ThumbsUp className="h-3 w-3" /> User thumbs-up
                      </span>
                    )}
                    {m.feedbackRating === "down" && (
                      <span className="flex items-center gap-1 text-red-600">
                        <ThumbsDown className="h-3 w-3" /> User thumbs-down
                      </span>
                    )}
                    {m.flagged && (
                      <span className="flex items-center gap-1 text-amber-600">
                        <Flag className="h-3 w-3" /> Flagged
                        {m.flaggedReason ? ` · ${m.flaggedReason}` : ""}
                      </span>
                    )}
                    {m.model && (
                      <span className="flex items-center gap-1">
                        <Cpu className="h-3 w-3" /> {m.model}
                      </span>
                    )}
                    {m.latencyMs != null && (
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" /> {m.latencyMs}ms
                      </span>
                    )}
                    {m.tokenCount != null && (
                      <span>~{m.tokenCount} tokens</span>
                    )}
                    {m.contextSummary && (
                      <span className="text-brand-sage/60">{m.contextSummary}</span>
                    )}
                  </div>
                )}
                {m.feedbackReason && (
                  <p className="mt-2 rounded bg-red-50 px-2 py-1.5 text-xs italic text-red-700 dark:bg-red-900/20 dark:text-red-400">
                    User reason: {m.feedbackReason}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
