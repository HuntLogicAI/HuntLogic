"use client";

import { memo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { User, ThumbsUp, ThumbsDown, Check } from "lucide-react";

interface ChatMessageProps {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  /** Persisted message id — when present, enables inline feedback controls. */
  messageId?: string | null;
}

export const ChatMessage = memo(function ChatMessage({
  role,
  content,
  isStreaming,
  messageId,
}: ChatMessageProps) {
  const isUser = role === "user";

  return (
    <div
      className={cn(
        "flex gap-3 px-4 py-3",
        isUser ? "flex-row-reverse" : "flex-row",
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          isUser
            ? "bg-brand-forest text-brand-cream"
            : "bg-brand-sage/20 dark:bg-brand-sage/30",
        )}
      >
        {isUser ? (
          <User className="h-4 w-4" />
        ) : (
          <span className="text-base">🐻</span>
        )}
      </div>

      {/* Message bubble */}
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm",
          isUser
            ? "bg-brand-forest text-white dark:bg-brand-sage"
            : "bg-brand-cream/75 text-brand-bark dark:bg-brand-bark/60 dark:text-brand-cream/90",
        )}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{content}</p>
        ) : (
          <div className="space-y-3">
            {renderAssistantContent(content, isStreaming)}
            {/* Inline feedback — only after the message has streamed in and
               we have a persisted id to attach feedback to. */}
            {!isStreaming && messageId && content.trim().length > 0 && (
              <MessageFeedback messageId={messageId} />
            )}
          </div>
        )}
      </div>
    </div>
  );
});

// =============================================================================
// Inline feedback — 👍 / 👎 with optional free-text reason capture
// =============================================================================

function MessageFeedback({ messageId }: { messageId: string }) {
  const [rating, setRating] = useState<"up" | "down" | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [showReason, setShowReason] = useState(false);

  const submit = async (next: "up" | "down", withReason?: string) => {
    if (submitting) return;
    setRating(next);
    setSubmitting(true);
    try {
      await fetch(`/api/v1/chat/messages/${messageId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rating: next,
          reason: withReason ?? null,
        }),
      });
      if (next === "up") {
        setDone(true);
      } else {
        // For thumbs-down we ask why
        setShowReason(true);
      }
    } catch (err) {
      console.error("[chat:feedback] failed:", err);
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <p className="flex items-center gap-1 text-xs text-brand-sage">
        <Check className="h-3.5 w-3.5" />
        Thanks — feedback recorded.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => submit("up")}
          disabled={submitting || rating !== null}
          aria-label="Helpful"
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md border border-brand-sage/20 text-brand-sage transition-colors hover:bg-brand-sage/10 disabled:opacity-50",
            rating === "up" && "bg-brand-forest/10 text-brand-forest",
          )}
        >
          <ThumbsUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => submit("down")}
          disabled={submitting || rating !== null}
          aria-label="Not helpful"
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md border border-brand-sage/20 text-brand-sage transition-colors hover:bg-brand-sage/10 disabled:opacity-50",
            rating === "down" && "bg-red-50 text-red-600",
          )}
        >
          <ThumbsDown className="h-3.5 w-3.5" />
        </button>
      </div>
      {showReason && rating === "down" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit("down", reason);
            setDone(true);
          }}
          className="flex flex-col gap-2"
        >
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, 500))}
            placeholder="What was wrong? (optional)"
            rows={2}
            className="resize-none rounded-md border border-brand-sage/20 bg-white/80 px-2 py-1 text-xs text-brand-bark placeholder:text-brand-sage/50 focus:border-brand-forest focus:outline-none focus:ring-1 focus:ring-brand-forest/30 dark:bg-brand-bark/50 dark:text-brand-cream"
          />
          <div className="flex items-center gap-2">
            <button
              type="submit"
              className="rounded-md bg-brand-forest px-2 py-1 text-xs font-medium text-white hover:bg-brand-forest/90"
            >
              Send
            </button>
            <button
              type="button"
              onClick={() => setDone(true)}
              className="text-xs text-brand-sage hover:text-brand-bark"
            >
              Skip
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function renderAssistantContent(
  content: string,
  isStreaming?: boolean,
): ReactNode[] {
  const trimmed = content.trim();

  if (!trimmed) {
    return isStreaming
      ? [
          <p key="streaming-placeholder">
            <span className="inline-block h-4 w-1 motion-safe:animate-pulse bg-brand-forest/60 align-middle dark:bg-brand-cream/60" />
          </p>,
        ]
      : [];
  }

  const blocks = trimmed.split(/\n\s*\n/);

  return blocks
    .map((block, index) => {
      const lines = block
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      if (lines.length === 0) return null;

      if (lines.every((line) => /^(?:[-*•])\s+/.test(line))) {
        return (
          <ul
            key={index}
            className="list-disc space-y-1.5 pl-5 marker:text-brand-forest dark:marker:text-brand-sage"
          >
            {lines.map((line, lineIndex) => (
              <li key={lineIndex}>
                {renderInlineFormatting(
                  line.replace(/^(?:[-*•])\s+/, ""),
                  isStreaming &&
                    index === blocks.length - 1 &&
                    lineIndex === lines.length - 1,
                )}
              </li>
            ))}
          </ul>
        );
      }

      if (lines.every((line) => /^\d+[.)]\s+/.test(line))) {
        return (
          <ol
            key={index}
            className="list-decimal space-y-1.5 pl-5 marker:font-semibold"
          >
            {lines.map((line, lineIndex) => (
              <li key={lineIndex}>
                {renderInlineFormatting(
                  line.replace(/^\d+[.)]\s+/, ""),
                  isStreaming &&
                    index === blocks.length - 1 &&
                    lineIndex === lines.length - 1,
                )}
              </li>
            ))}
          </ol>
        );
      }

      if (lines.length === 1 && /^[^.!?]{1,80}:$/.test(lines[0])) {
        return (
          <h3
            key={index}
            className="text-sm font-semibold text-brand-bark dark:text-brand-cream"
          >
            {renderInlineFormatting(
              lines[0].slice(0, -1),
              isStreaming && index === blocks.length - 1,
            )}
          </h3>
        );
      }

      return (
        <p key={index} className="whitespace-pre-wrap">
          {renderInlineFormatting(
            lines.join("\n"),
            isStreaming && index === blocks.length - 1,
          )}
        </p>
      );
    })
    .filter(Boolean) as ReactNode[];
}

function renderInlineFormatting(
  text: string,
  appendCursor = false,
): ReactNode[] {
  const nodes = text
    .split(/(\*\*[^*\n]+\*\*)/g)
    .filter(Boolean)
    .map((part, index) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return (
          <strong key={index} className="font-semibold">
            {part.slice(2, -2)}
          </strong>
        );
      }

      return <span key={index}>{part}</span>;
    });

  if (appendCursor) {
    nodes.push(
      <span
        key="streaming-cursor"
        className="ml-1 inline-block h-4 w-1 motion-safe:animate-pulse bg-brand-forest/60 align-middle dark:bg-brand-cream/60"
      />,
    );
  }

  return nodes;
}
