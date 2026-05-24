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

interface ChatResponse {
  text?: string;
  sources?: ChatSource[];
}

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

        const data: ChatResponse | { error?: string } | null = await res
          .json()
          .catch(() => null);

        if (!res.ok) {
          throw new Error(
            (data && "error" in data && data.error) || `HTTP ${res.status}`,
          );
        }

        // Update assistant message with Grizz's response and attach any
        // source citations the backend collected.
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  content:
                    data && "text" in data && data.text
                      ? data.text
                      : "Sorry, I didn't get a response.",
                  sources:
                    data && "sources" in data ? data.sources : undefined,
                }
              : m,
          ),
        );
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
