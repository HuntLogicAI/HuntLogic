"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { Send, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface ConciergeChatCardProps {
  /** First-name greeting from session — shown in the empty-state line. */
  userName?: string;
  /**
   * Suggested prompts to seed the conversation. Pass profile-aware prompts
   * (e.g. "What's the deadline for my Wyoming elk app?") for best UX.
   */
  suggestedPrompts?: string[];
}

const DEFAULT_PROMPTS = [
  "Where should I apply this year for elk?",
  "Is it worth applying for Wyoming unit 100?",
  "What's a good first-elk hunt?",
];

export function ConciergeChatCard({
  userName,
  suggestedPrompts,
}: ConciergeChatCardProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmed,
    };
    const assistantId = crypto.randomUUID();
    const placeholder: Message = {
      id: assistantId,
      role: "assistant",
      content: "",
    };

    const next = [...messages, userMsg, placeholder];
    setMessages(next);
    setInput("");
    setIsLoading(true);

    try {
      const history = [...messages, userMsg].map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const res = await fetch("/api/v1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, history }),
      });
      const data: { text?: string; error?: string } | null = await res
        .json()
        .catch(() => null);

      if (!res.ok || !data) {
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: data.text ?? "Sorry, I didn't get a response." }
            : m,
        ),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Please try again.";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content: `Couldn't reach the concierge. ${msg}`,
              }
            : m,
        ),
      );
    } finally {
      setIsLoading(false);
    }
  };

  const prompts = suggestedPrompts ?? DEFAULT_PROMPTS;

  return (
    <div className="rounded-xl border border-brand-sage/10 bg-white p-4 shadow-sm dark:border-brand-sage/20 dark:bg-brand-bark">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-forest text-lg text-brand-cream">
            🐻
          </div>
          <div>
            <h2 className="text-sm font-semibold text-brand-bark dark:text-brand-cream">
              Talk to your concierge
            </h2>
            <p className="text-xs text-brand-sage">
              {userName
                ? `Tell ${userName === "Hunter" ? "me" : "me"} about your hunt this season — `
                : ""}
              draw odds, points, units, deadlines.
            </p>
          </div>
        </div>
        <Link
          href="/chat"
          className="hidden items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-brand-sage transition-colors hover:bg-brand-sage/10 hover:text-brand-bark dark:hover:text-brand-cream sm:inline-flex"
        >
          Open full chat <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      {/* Messages or empty-state with suggested prompts */}
      <div
        ref={bodyRef}
        className="mt-4 max-h-[280px] min-h-[112px] space-y-3 overflow-y-auto"
      >
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wide text-brand-sage">
              Try one of these
            </p>
            <div className="flex flex-wrap gap-2">
              {prompts.map((p) => (
                <button
                  key={p}
                  onClick={() => send(p)}
                  disabled={isLoading}
                  className="rounded-full border border-brand-sage/20 bg-brand-cream/30 px-3 py-1.5 text-xs font-medium text-brand-bark transition-colors hover:border-brand-forest/40 hover:bg-brand-forest/5 disabled:opacity-50 dark:border-brand-sage/30 dark:bg-brand-bark/40 dark:text-brand-cream dark:hover:bg-brand-forest/10"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={cn(
              "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed",
              msg.role === "user"
                ? "ml-auto rounded-br-sm bg-brand-forest text-white"
                : "mr-auto rounded-bl-sm border border-brand-sage/10 bg-brand-cream/40 text-brand-bark dark:border-brand-sage/20 dark:bg-brand-bark/50 dark:text-brand-cream",
            )}
          >
            {msg.content || (
              <span className="animate-pulse text-brand-sage">Thinking…</span>
            )}
          </div>
        ))}
      </div>

      {/* Input
         *
         * Form-level onSubmit covers native Enter-to-submit, but during prod
         * UX testing the form submission silently dropped some keystrokes
         * (likely a focus/timing issue with the suggested-prompt buttons that
         * unmount when messages.length === 0). Adding an explicit onKeyDown
         * fallback on the input guarantees Enter always sends a non-empty
         * trimmed message regardless of focus state.
         */}
      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          placeholder="Ask about points, units, deadlines…"
          className="min-h-[40px] flex-1 rounded-lg border border-brand-sage/20 bg-white px-3 py-2 text-sm text-brand-bark placeholder:text-brand-sage/60 focus:border-brand-forest focus:outline-none focus:ring-1 focus:ring-brand-forest/30 dark:border-brand-sage/30 dark:bg-brand-bark/40 dark:text-brand-cream"
          disabled={isLoading}
        />
        <button
          type="submit"
          disabled={!input.trim() || isLoading}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-forest text-white transition-colors hover:bg-brand-forest/90 disabled:opacity-40"
          aria-label="Send"
        >
          <Send className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}
