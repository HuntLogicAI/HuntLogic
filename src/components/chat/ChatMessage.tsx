"use client";

import { memo, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { User, ExternalLink } from "lucide-react";

export interface ChatSource {
  name: string;
  url: string | null;
  kind?: "agency" | "regulation_doc" | "snapshot";
}

interface ChatMessageProps {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  /** Source citations to render below the assistant's reply, if any. */
  sources?: ChatSource[];
}

export const ChatMessage = memo(function ChatMessage({
  role,
  content,
  isStreaming,
  sources,
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
            {/* Inline citations — agency URLs + regulation snapshots that
               were attached to the response payload. Only render after
               streaming so the chips don't flicker in mid-stream. */}
            {!isStreaming && sources && sources.length > 0 && (
              <SourcesRow sources={sources} />
            )}
          </div>
        )}
      </div>
    </div>
  );
});

function SourcesRow({ sources }: { sources: ChatSource[] }) {
  return (
    <div className="border-t border-brand-sage/15 pt-2 dark:border-brand-sage/25">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-brand-sage">
        Sources
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {sources.map((src, i) => {
          const inner = (
            <span className="flex items-center gap-1 text-[11px]">
              <span className="rounded-sm bg-brand-sage/10 px-1 py-0.5 font-mono text-[9px] text-brand-sage">
                [{i + 1}]
              </span>
              <span className="line-clamp-1 max-w-[180px]">{src.name}</span>
              {src.url && (
                <ExternalLink className="h-2.5 w-2.5 text-brand-sage" />
              )}
            </span>
          );
          if (src.url) {
            return (
              <li key={`${src.name}-${i}`}>
                <a
                  href={src.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center rounded-md border border-brand-sage/20 bg-white/60 px-2 py-0.5 transition-colors hover:border-brand-forest/30 hover:bg-brand-forest/5 dark:bg-brand-bark/40 dark:hover:bg-brand-forest/10"
                >
                  {inner}
                </a>
              </li>
            );
          }
          return (
            <li
              key={`${src.name}-${i}`}
              className="inline-flex items-center rounded-md border border-brand-sage/15 bg-brand-sage/5 px-2 py-0.5 text-brand-sage"
            >
              {inner}
            </li>
          );
        })}
      </ul>
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
          <div key="typing-indicator" className="space-y-2">
            <p className="text-brand-bark dark:text-brand-cream">
              Got it — give me a few seconds to research and report back...
            </p>
            <div className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-brand-forest/60 motion-safe:animate-bounce dark:bg-brand-cream/60" style={{ animationDelay: "0ms", animationDuration: "1s" }} />
              <span className="h-2 w-2 rounded-full bg-brand-forest/60 motion-safe:animate-bounce dark:bg-brand-cream/60" style={{ animationDelay: "150ms", animationDuration: "1s" }} />
              <span className="h-2 w-2 rounded-full bg-brand-forest/60 motion-safe:animate-bounce dark:bg-brand-cream/60" style={{ animationDelay: "300ms", animationDuration: "1s" }} />
            </div>
          </div>,
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
