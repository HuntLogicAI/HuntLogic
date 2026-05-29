// =============================================================================
// Chat API — Grizz Concierge (web SSE surface)
// =============================================================================
// POST /api/v1/chat — Send message to Grizz, stream the response over SSE.
//
// The reasoning core lives in src/lib/ai/grizz.ts (channel-agnostic), so the
// web chat here and the messaging webhooks (Telegram, etc.) share ONE brain.
// This route is just the web-specific SSE wrapper + auth.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { config } from "@/lib/config";
import {
  assembleGrizzMessage,
  runGrizzStreaming,
  MAX_MESSAGE_LENGTH,
  type ChatSource,
} from "@/lib/ai/grizz";

export const runtime = "nodejs";
// Vercel Pro allows up to 300s. Agentic loop with web_search can take
// 60-180s for multi-turn responses (preamble → search → DB query → final).
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { message, history = [] } = body as {
    message: string;
    history: { role: string; content: string }[];
  };

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return NextResponse.json({ error: "Message is required" }, { status: 400 });
  }

  const trimmedMessage = message.trim();
  if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json({ error: "Message is too long" }, { status: 400 });
  }

  const { fullMessage, sources } = await assembleGrizzMessage(
    session.user.id,
    trimmedMessage,
    history,
  );

  // Stream the response over SSE so the user sees tokens as they arrive,
  // not after the full agentic loop completes (30+ seconds).
  return streamAnthropicResponse(fullMessage, sources);
}

// =============================================================================
// SSE streaming response — emits text deltas as they arrive from Anthropic,
// runs the agentic tool loop in-stream, ends with a sources event + done.
// Event format (one line per event):
//   data: {"type":"text","delta":"..."}
//   data: {"type":"sources","sources":[...]}
//   data: {"type":"error","message":"..."}
//   data: {"type":"done"}
// =============================================================================

function streamAnthropicResponse(
  message: string,
  sources: ChatSource[],
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        await runGrizzStreaming(message, send);
        if (sources.length > 0) {
          send({ type: "sources", sources });
        }
        send({ type: "done" });
      } catch (err) {
        console.error("[chat:stream] error:", err);
        send({
          type: "error",
          message:
            err instanceof Error
              ? err.message
              : `${config.app.aiAssistantName} ran into an issue. Try again in a moment.`,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function GET() {
  return NextResponse.json({
    concierge: config.app.aiAssistantName,
    telegram: config.app.telegramBot,
    status: "online",
  });
}
