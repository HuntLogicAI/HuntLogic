// =============================================================================
// Chat API — Grizz Concierge via OpenClaw Gateway
// =============================================================================
// POST /api/v1/chat — Send message to Grizz, get response
//
// Routes through the OpenClaw gateway when available (local dev),
// or falls back to direct Anthropic SDK if ANTHROPIC_API_KEY is set.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  hunterPreferences,
  pointHoldings,
  recommendations,
  playbooks,
  states,
  species,
  huntUnits,
  stateRegulations,
} from "@/lib/db/schema";
import { config } from "@/lib/config";
import { assembleContext } from "@/lib/ai/rag";
import { buildKnowledgeContext } from "@/lib/ai/knowledge-packs";

export const runtime = "nodejs";
export const maxDuration = 60;

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "https://huntlogic.mysupertool.app";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_HISTORY_ITEMS = 10;
const MAX_HISTORY_CONTENT_LENGTH = 2_000;
const CHAT_SYSTEM_PROMPT = `You are ${config.app.aiAssistantName}, the AI concierge for ${config.app.brandName} — a national hunting guide powered by real state agency data.

Voice & persona (full guide: docs/grizz-persona-guide.md):
- Voice composite: Randy Newburg (primary — public-land-first, anti-trophy-arrogance, practical/operational), Steven Rinella (curiosity, ethics, willing to admit uncertainty), Remi Warren (technical, solo-hunter mindset), Cam Hanes (grit/discipline), Mark Kenyon (eastern-whitetail rigor).
- Lead with the answer. First sentence is the answer; justification follows. No "Great question!", no "Let me explain...", no "I want to make sure I understand..." preambles.
- Use real terminology hunters know: LE, OTC, general, leftover, NR/R, point creep, max-point pool, squared draw, bonus/preference/loyalty, antlerless, drake, etc. Translate briefly only if a casual user clearly needs it.
- Talk logistics, not just outcomes: drive time, public-land %, OTC vs draw vs lottery, tag cost, application + result deadlines, season window, realistic success rate.
- Stack-rank when asked "where should I apply" — top 3 with rationale. Format: "1. WY Area 124 cow elk — general license, 100% draw, ~25% success, $336 tag. Best fit for fill-freezer goal."
- Surface hard truths. If the math says it's not worth applying, say so directly (point creep / max-point pool / mortality). Tie to a verdict (continue / hold / exit) with a concrete alternative.
- Never promotional. Banned words: "epic," "legendary," "trophy of a lifetime," "world-class," "amazing journey," "incredible adventure."
- Never condescending. Trust hunter intelligence by default.
- Conservation/ethics: matter-of-fact, never preachy. Mention non-toxic shot, fair-chase, wanton-waste, CWD only when relevant.

Behavior rules:
- Answer the hunter's actual question first. Do not dodge into a different state or species before answering what they asked.
- When the hunter asks for best zones, units, or application strategy, give a ranked or tiered answer with tradeoffs.
- Separate official state-agency facts from hunter-consensus nuance. Label hunter-consensus guidance clearly.
- Use specific numbers only when they are present in the grounded context. Never invent draw odds or tag counts.
- If confidence is limited, say exactly what is uncertain.
- When the message includes an "Authoritative sources" block, cite the most relevant entries inline using their bracket numbers (e.g. "[1]") immediately after the claim they support. Do NOT add a long "Sources" footer of your own — the UI renders the structured list separately. Only cite sources that were actually provided; do not invent citation numbers.`;

let stateReferenceCache:
  | { id: string; code: string; name: string }[]
  | null = null;
let speciesReferenceCache:
  | { id: string; commonName: string; slug: string }[]
  | null = null;

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

  const sanitizedHistory = Array.isArray(history)
    ? history.slice(-MAX_HISTORY_ITEMS).map((item) => ({
        role: item?.role === "user" ? "user" : "assistant",
        content:
          typeof item?.content === "string"
            ? item.content.slice(0, MAX_HISTORY_CONTENT_LENGTH)
            : "",
      }))
    : [];

  // Load hunter profile context from DB
  const profileContext = await loadHunterProfileContext(session.user.id);

  // Build context from history
  const aiName = config.app.aiAssistantName;
  const contextLines = sanitizedHistory
    .map((m) => `${m.role === "user" ? "Hunter" : aiName}: ${m.content}`)
    .join("\n");

  const groundingContext = await buildGroundingContext(trimmedMessage);

  // Detect state + species so we can return clickable source links alongside
  // the answer. The same detection function is called inside
  // buildGroundingContext, but it's cheap enough to call again here and keeps
  // the source-collection contract narrow + testable.
  const detected = await detectStateAndSpecies(trimmedMessage);
  const sources = await collectSources({
    stateId: detected.stateId,
    speciesId: detected.speciesId,
  });

  // Assemble full message: profile context + grounding + sources + history + question.
  // Sources are inlined as well so the model can cite them in-line; the
  // structured `sources` array travels back in the response for the UI.
  const messageParts: string[] = [];
  if (profileContext) {
    messageParts.push(profileContext);
  }
  if (groundingContext) {
    messageParts.push(groundingContext);
  }
  if (sources.length > 0) {
    const sourcesBlock = sources
      .map((s, i) => `[${i + 1}] ${s.name}${s.url ? ` — ${s.url}` : ""}`)
      .join("\n");
    messageParts.push(
      `Authoritative sources (cite by [n] when you use them in the answer):\n${sourcesBlock}`,
    );
  }
  if (contextLines) {
    messageParts.push(`Previous conversation:\n${contextLines}`);
  }
  messageParts.push(`Hunter: ${trimmedMessage}`);

  const fullMessage = messageParts.join("\n\n");

  // Try OpenClaw gateway first, then fall back to Anthropic, Gemini, and OpenAI
  try {
    const reply = await callOpenClawGateway(fullMessage);
    return NextResponse.json({ text: reply, sources });
  } catch (gatewayErr) {
    console.warn(
      "[chat] OpenClaw gateway unavailable, trying direct providers:",
      gatewayErr instanceof Error ? gatewayErr.message : String(gatewayErr)
    );

    try {
      const reply = await callAnthropicDirect(fullMessage);
      return NextResponse.json({ text: reply, sources });
    } catch (anthropicErr) {
      console.warn(
        "[chat] Anthropic unavailable, trying Gemini:",
        anthropicErr instanceof Error ? anthropicErr.message : String(anthropicErr)
      );

      try {
        const reply = await callGeminiDirect(fullMessage);
        return NextResponse.json({ text: reply, sources });
      } catch (geminiErr) {
        console.warn(
          "[chat] Gemini unavailable, trying OpenAI:",
          geminiErr instanceof Error ? geminiErr.message : String(geminiErr)
        );

        try {
          const reply = await callOpenAIDirect(fullMessage);
          return NextResponse.json({ text: reply, sources });
        } catch (openaiErr) {
          console.error("[chat] All backends failed:", openaiErr);
          return NextResponse.json(
            { error: `${config.app.aiAssistantName} is currently unavailable. Try messaging him on Telegram: ${config.app.telegramBot}` },
            { status: 503 }
          );
        }
      }
    }
  }
}

// =============================================================================
// Source collection — collects citation candidates from authoritative tables
// (state agency URL, state regulation docs, regulation snapshots) keyed off
// the state/species detected in the user's message.
// =============================================================================

interface ChatSource {
  /** Short human-readable label, e.g. "Colorado Parks & Wildlife" */
  name: string;
  /** Canonical URL — null for sources we know the name of but not a URL */
  url: string | null;
  /** Where it came from: lets the UI render different chip styles */
  kind: "agency" | "regulation_doc" | "snapshot";
}

async function collectSources(opts: {
  stateId: string | null;
  speciesId: string | null;
}): Promise<ChatSource[]> {
  if (!opts.stateId) return [];

  const results: ChatSource[] = [];

  // 1) State agency homepage from `states.agencyName` + `states.agencyUrl`.
  try {
    const [state] = await db
      .select({
        name: states.name,
        agencyName: states.agencyName,
        agencyUrl: states.agencyUrl,
      })
      .from(states)
      .where(eq(states.id, opts.stateId))
      .limit(1);
    if (state && state.agencyUrl) {
      results.push({
        name: state.agencyName ?? `${state.name} Wildlife Agency`,
        url: state.agencyUrl,
        kind: "agency",
      });
    }
  } catch (err) {
    console.warn("[chat:sources] agency lookup failed:", err);
  }

  // 2) Up to two regulation docs (hunt planner / big game regs) for this state.
  try {
    const docs = await db
      .select({
        title: stateRegulations.title,
        url: stateRegulations.url,
      })
      .from(stateRegulations)
      .where(
        and(
          eq(stateRegulations.stateId, opts.stateId),
          eq(stateRegulations.enabled, true),
        ),
      )
      .limit(3);
    for (const doc of docs) {
      if (!doc.url) continue;
      results.push({
        name: doc.title,
        url: doc.url,
        kind: "regulation_doc",
      });
    }
  } catch (err) {
    console.warn("[chat:sources] regulation lookup failed:", err);
  }

  // 3) (Future) Once feat/data-layer-overhaul merges, also pull the active
  // regulation snapshot for the current year — that's the canonical
  // version-pinned regulation text and the strongest provenance signal.
  // Tracked separately to keep this PR independent of the schema migration.

  // De-duplicate by url; preserve insertion order so agency/regulation/snapshot
  // order is preserved.
  const seen = new Set<string>();
  return results.filter((s) => {
    const key = (s.url ?? s.name).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// =============================================================================
// Hunter Profile Context Loader
// =============================================================================

async function loadHunterProfileContext(userId: string): Promise<string> {
  try {
    const [prefs, points, activePlaybook] = await Promise.all([
      db
        .select({
          category: hunterPreferences.category,
          key: hunterPreferences.key,
          value: hunterPreferences.value,
        })
        .from(hunterPreferences)
        .where(eq(hunterPreferences.userId, userId)),
      db
        .select({
          stateCode: states.code,
          speciesName: species.commonName,
          points: pointHoldings.points,
          pointType: pointHoldings.pointType,
        })
        .from(pointHoldings)
        .innerJoin(states, eq(pointHoldings.stateId, states.id))
        .innerJoin(species, eq(pointHoldings.speciesId, species.id))
        .where(eq(pointHoldings.userId, userId)),
      db.query.playbooks.findFirst({
        where: and(eq(playbooks.userId, userId), eq(playbooks.status, "active")),
      }),
    ]);

    // --- 1. Hunter Preferences ---

    // Group preferences by category for readable formatting
    const speciesInterests: string[] = [];
    const stateInterests: string[] = [];
    let budget: string | null = null;
    let experience: string | null = null;
    let orientation: string | null = null;
    const otherPrefs: string[] = [];

    for (const p of prefs) {
      if (p.category === "species_interest") {
        speciesInterests.push(String(p.key).replace(/_/g, " "));
      } else if (p.category === "state_interest") {
        stateInterests.push(String(p.key).toUpperCase());
      } else if (p.category === "budget" && p.key === "annual_budget") {
        budget = String(p.value).replace(/_/g, " ");
      } else if (p.category === "experience" && p.key === "experience_level") {
        experience = String(p.value).replace(/_/g, " ");
      } else if (p.category === "hunt_orientation" && p.key === "orientation") {
        orientation = String(p.value).replace(/_/g, " ");
      } else if (
        p.category === "weapon" ||
        p.category === "travel" ||
        p.category === "physical" ||
        p.category === "timeline"
      ) {
        otherPrefs.push(`${p.key.replace(/_/g, " ")}: ${JSON.stringify(p.value)}`);
      }
    }

    // Build preferences line
    const prefParts: string[] = [];
    if (speciesInterests.length > 0) {
      // Attach state interests to species if both exist
      if (stateInterests.length > 0) {
        prefParts.push(
          `${speciesInterests.join(", ")} (${stateInterests.join(", ")})`
        );
      } else {
        prefParts.push(speciesInterests.join(", "));
      }
    } else if (stateInterests.length > 0) {
      prefParts.push(`states: ${stateInterests.join(", ")}`);
    }
    if (budget) prefParts.push(`budget: ${budget}`);
    if (experience) prefParts.push(`experience: ${experience}`);
    if (orientation) prefParts.push(`orientation: ${orientation}`);
    if (otherPrefs.length > 0) prefParts.push(...otherPrefs);

    // --- 2. Point Holdings + 3. Active Playbook loaded above in parallel ---

    let topRecs: {
      stateCode: string;
      speciesName: string;
      unitCode: string | null;
      score: number | null;
      rank: number | null;
    }[] = [];

    if (activePlaybook) {
      const recs = await db
        .select({
          stateCode: states.code,
          speciesName: species.commonName,
          unitCode: huntUnits.unitCode,
          score: recommendations.score,
          rank: recommendations.rank,
        })
        .from(recommendations)
        .innerJoin(states, eq(recommendations.stateId, states.id))
        .innerJoin(species, eq(recommendations.speciesId, species.id))
        .leftJoin(huntUnits, eq(recommendations.huntUnitId, huntUnits.id))
        .where(
          and(
            eq(recommendations.userId, userId),
            eq(recommendations.playbookId, activePlaybook.id),
            eq(recommendations.status, "active")
          )
        )
        .orderBy(recommendations.rank)
        .limit(3);

      topRecs = recs;
    }

    // --- Format the profile context block ---
    const lines: string[] = ["[Hunter Profile]"];

    if (prefParts.length > 0) {
      lines.push(`Preferences: ${prefParts.join(", ")}`);
    } else {
      lines.push("Preferences: (none set yet)");
    }

    if (points.length > 0) {
      const pointStrs = points.map(
        (p) => `${p.stateCode} ${p.speciesName} ${p.points}pts (${p.pointType})`
      );
      lines.push(`Points: ${pointStrs.join(", ")}`);
    } else {
      lines.push("Points: (none recorded)");
    }

    if (topRecs.length > 0) {
      const recStrs = topRecs.map((r, i) => {
        const unit = r.unitCode ? ` ${r.unitCode}` : "";
        const score = r.score != null ? ` (score: ${r.score.toFixed(2)})` : "";
        return `#${i + 1} ${r.stateCode}${unit} ${r.speciesName}${score}`;
      });
      lines.push(`Active Recommendations: ${recStrs.join(", ")}`);
    } else {
      lines.push("Active Recommendations: (none yet)");
    }

    return lines.join("\n");
  } catch (err) {
    console.warn(
      "[chat] Failed to load hunter profile context:",
      err instanceof Error ? err.message : String(err)
    );
    // Non-fatal — Grizz can still respond without profile context
    return "";
  }
}

// =============================================================================
// OpenClaw Gateway — local agent call
// =============================================================================

async function buildGroundingContext(message: string): Promise<string> {
  const parts: string[] = ["[Grounding Context]"];

  const [detected, knowledgeContext] = await Promise.all([
    detectStateAndSpecies(message),
    buildKnowledgeContext(message, 2).catch((error) => {
      console.warn(
        "[chat] Failed to load local knowledge packs:",
        error instanceof Error ? error.message : String(error)
      );
      return "";
    }),
  ]);

  try {
    const ragContext = await assembleContext(
      `${message} hunt strategy draw odds harvest access pressure regulations`,
      4,
      detected.stateId || detected.speciesId
        ? {
            stateId: detected.stateId ?? undefined,
            speciesId: detected.speciesId ?? undefined,
          }
        : undefined
    );

    if (ragContext) {
      parts.push(`Official data context:\n${ragContext}`);
    }
  } catch (error) {
    console.warn(
      "[chat] Failed to build RAG context:",
      error instanceof Error ? error.message : String(error)
    );
  }

  if (knowledgeContext) {
    parts.push(
      `Curated HuntLogic research context (label non-official consensus clearly):\n<context>\n${knowledgeContext}\n</context>`
    );
  }

  return parts.length > 1 ? parts.join("\n\n") : "";
}

async function detectStateAndSpecies(message: string): Promise<{ stateId: string | null; speciesId: string | null }> {
  const lowered = message.toLowerCase();

  const [stateRows, speciesRows] = await Promise.all([
    getStateReferenceRows(),
    getSpeciesReferenceRows(),
  ]);

  const matchedState = stateRows.find((state) => {
    const name = state.name.toLowerCase();
    if (lowered.includes(name)) return true;
    const safeCode = escapeRegExp(state.code.toLowerCase());
    const codePattern = new RegExp(`\\b${safeCode}\\b`, "i");
    return codePattern.test(message);
  });

  const matchedSpecies = speciesRows.find((sp) => {
    const common = sp.commonName.toLowerCase();
    const slug = sp.slug.replaceAll("_", " ").toLowerCase();
    return lowered.includes(common) || lowered.includes(slug);
  });

  return {
    stateId: matchedState?.id ?? null,
    speciesId: matchedSpecies?.id ?? null,
  };
}

async function getStateReferenceRows() {
  if (!stateReferenceCache) {
    stateReferenceCache = await db
      .select({ id: states.id, code: states.code, name: states.name })
      .from(states);
  }

  return stateReferenceCache;
}

async function getSpeciesReferenceRows() {
  if (!speciesReferenceCache) {
    speciesReferenceCache = await db
      .select({ id: species.id, commonName: species.commonName, slug: species.slug })
      .from(species);
  }

  return speciesReferenceCache;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function callOpenClawGateway(message: string): Promise<string> {
  const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      model: "openclaw:teddy",
      messages: [
        { role: "system", content: CHAT_SYSTEM_PROMPT },
        { role: "user", content: message },
      ],
      max_tokens: 4096,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`Gateway returned ${res.status}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";

  if (!text) {
    throw new Error("Empty response from gateway");
  }

  return text;
}

// =============================================================================
// Direct Anthropic SDK fallback
// =============================================================================

async function callAnthropicDirect(message: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("No ANTHROPIC_API_KEY configured");
  }

  // Dynamic import to avoid build errors when SDK isn't needed
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey, timeout: 20_000 });

  const response = await client.messages.create({
    model: config.ai.model,
    max_tokens: 4096,
    temperature: 0.7,
    system: CHAT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: message }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock?.text || "Sorry, I couldn't generate a response.";
}

async function callOpenAIDirect(message: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("No OPENAI_API_KEY configured");
  }

  const { OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey, timeout: 20_000 });

  const completion = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o",
    messages: [
      { role: "system", content: CHAT_SYSTEM_PROMPT },
      { role: "user", content: message },
    ],
    max_tokens: 4096,
    temperature: 0.7,
  });

  const text = completion.choices[0]?.message?.content || "";
  if (!text) {
    throw new Error("Empty response from OpenAI");
  }

  return text;
}

async function callGeminiDirect(message: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("No GEMINI_API_KEY configured");
  }

  const model = process.env.GEMINI_CHAT_MODEL || "gemini-2.5-flash";
  if (!/^[\w.-]+$/.test(model)) {
    throw new Error("Invalid GEMINI_CHAT_MODEL");
  }
  const systemPrompt = CHAT_SYSTEM_PROMPT;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: message }],
          },
        ],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 4096,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      signal: AbortSignal.timeout(20000),
    }
  );

  if (!res.ok) {
    throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part.text || "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Empty response from Gemini");
  }

  return text;
}

export async function GET() {
  return NextResponse.json({
    concierge: config.app.aiAssistantName,
    telegram: config.app.telegramBot,
    status: "online",
  });
}
