"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { ChatMessage, type ChatSource } from "./ChatMessage";
import { ChatInput } from "./ChatInput";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
}

type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "sources"; sources: ChatSource[] }
  | { type: "error"; message: string }
  | { type: "done" };

const aiName = process.env.NEXT_PUBLIC_AI_ASSISTANT_NAME || "Grizz";

const WELCOME_MESSAGE: Message = {
  id: "welcome",
  role: "assistant",
  content: `Hey, I'm ${aiName} — your personal hunting concierge. I know draw odds, point strategies, unit recommendations, season dates, and costs for all 50 states. Ask me anything about your next hunt.`,
};

export function ChatContainer() {
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
  const [isLoading, setIsLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      behavior: isLoading ? "auto" : "smooth",
      block: "end",
    });
  }, [isLoading, messages]);

  const sendMessage = useCallback(
    async (content: string) => {
      const assistantId = crypto.randomUUID();

      setMessages((prev) => {
        const userMsg: Message = {
          id: crypto.randomUUID(),
          role: "user",
          content,
        };

        return [
          ...prev,
          userMsg,
          { id: assistantId, role: "assistant", content: "" },
        ];
      });
      setIsLoading(true);

      try {
        const history = [
          ...messages
            .filter((m) => m.id !== "welcome")
            .map((m) => ({ role: m.role, content: m.content })),
          { role: "user" as const, content },
        ];

        const res = await fetch("/api/v1/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: content, history }),
        });

        if (!res.ok || !res.body) {
          let detail = `HTTP ${res.status}`;
          try {
            const errBody = await res.json();
            if (errBody && typeof errBody.error === "string") detail = errBody.error;
          } catch {}
          throw new Error(detail);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let accumulatedText = "";
        let streamError: string | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line.
          let frameEnd = buffer.indexOf("\n\n");
          while (frameEnd !== -1) {
            const frame = buffer.slice(0, frameEnd);
            buffer = buffer.slice(frameEnd + 2);
            frameEnd = buffer.indexOf("\n\n");

            const dataLine = frame
              .split("\n")
              .find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            let event: StreamEvent;
            try {
              event = JSON.parse(dataLine.slice(5).trim()) as StreamEvent;
            } catch {
              continue;
            }

            if (event.type === "text") {
              accumulatedText += event.delta;
              const snapshot = accumulatedText;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: snapshot } : m,
                ),
              );
            } else if (event.type === "sources") {
              const incoming = event.sources;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, sources: incoming } : m,
                ),
              );
            } else if (event.type === "error") {
              streamError = event.message;
            }
          }
        }

        if (streamError) {
          throw new Error(streamError);
        }

        if (!accumulatedText.trim()) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: "Sorry, I didn't get a response." }
                : m,
            ),
          );
        }
      } catch (err: unknown) {
        const errorMessage =
          err instanceof Error ? err.message : "Please try again.";
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  content: errorMessage.includes("Telegram:")
                    ? errorMessage
                    : `Sorry, I couldn't process that. ${errorMessage}`,
                }
              : m,
          ),
        );
      } finally {
        setIsLoading(false);
      }
    },
    [messages],
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-white/80 shadow-sm ring-1 ring-brand-sage/10 backdrop-blur-sm dark:bg-brand-bark/60 dark:ring-brand-sage/20 lg:rounded-3xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-brand-sage/10 px-4 py-3 dark:border-brand-sage/20">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-forest text-brand-cream text-lg">
            🐻
          </div>
          <div>
            <h2 className="text-sm font-semibold text-brand-bark dark:text-brand-cream">
              {aiName}
            </h2>
            <p className="text-xs text-brand-sage">Your AI hunting concierge</p>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-gradient-to-b from-transparent via-white/30 to-brand-cream/20 py-3 dark:via-brand-bark/20 dark:to-brand-forest/10">
        {messages.map((msg) => (
          <ChatMessage
            key={msg.id}
            role={msg.role}
            content={msg.content}
            isStreaming={
              isLoading &&
              msg.id === messages[messages.length - 1]?.id &&
              msg.role === "assistant"
            }
            sources={msg.sources}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <ChatInput onSend={sendMessage} disabled={isLoading} aiName={aiName} />
    </div>
  );
}
