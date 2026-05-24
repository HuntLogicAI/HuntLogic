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
import { eq, and, sql } from "drizzle-orm";
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
- When the message includes an "Authoritative sources" block, cite the most relevant entries inline using their bracket numbers (e.g. "[1]") immediately after the claim they support. Do NOT add a long "Sources" footer of your own — the UI renders the structured list separately. Only cite sources that were actually provided; do not invent citation numbers.

CRITICAL anti-hallucination rules:
- If NO "Authoritative sources" block is present in the message, you have NO grounded data context. In that case, refuse to make state-specific factual claims (which states offer which species, draw odds, point thresholds, unit numbers, season dates, license costs, etc.). Instead say plainly: "I don't have current data on [state]'s [species] regulations loaded right now — please verify with the state agency. I can help with general strategy if useful."
- NEVER assert that a state does NOT have a given species, season, or tag without an explicit grounded fact saying so. Many states have surprising species distributions (e.g. Nevada DOES have elk; Iowa DOES have elk hunts; New Hampshire DOES have moose). Default to "I'd need to verify" rather than asserting absence.
- When in doubt, ask clarifying questions ("Which state are your points actually in?") instead of guessing across multiple states.

Tools available to you:
- query_hunting_database(state_code, species_slug): Returns structured data we have locally (hunt unit names, draw odds, harvest stats). USE THIS FIRST whenever the user asks a state+species-specific question. We currently have full data for NV. If it returns rowCount: 0, fall through to web_search.
- web_search(query): Live web search. Use for any state/species/unit data that query_hunting_database didn\'t return, or for current-year deadlines, rule changes, news. Prefer official state agency sites (.gov, ndow.org, cpw.state.co.us, wgfd.wyo.gov, azgfd.com, etc.) over hunter forums.

Rules for tool use:
- If the user mentions a state and species, ALWAYS try query_hunting_database first.
- If query_hunting_database returns rows, use those numbers in your answer and cite the state agency as the source.
- If query_hunting_database returns nothing, use web_search to find the data, then answer with citations.
- Never claim "I don\'t have data" without first trying both tools. The new rule is: search, then answer.
- After tools return data, cite it inline with [1], [2], etc. Match each fact to the source that backs it.

Response depth & strategy framing (CRITICAL):
For any question about WHERE to apply, WHICH UNITS, or strategic decisions ("I have X points, where should I apply", "best units for...", "strategy for..."), do NOT just dump a single sentence of data. Structure your answer as a full strategic brief:

1. REALITY CHECK (1-2 sentences): State the math plainly. "At 7 points in NV elk, you are sub-1% draw odds for any top-tier unit. Even with the squared bonus system, you are in 'lottery ticket' territory, not 'expected draw within 2 years' territory."

2. THE PLAN (3-5 sentences): Recommend a concrete strategy that respects the user's stated preferences. If they said "OK not drawing instead of drawing a non-trophy unit," validate that as a sound multi-year strategy: apply for the absolute top units every cycle, gain a point if you don't draw, and eventually you draw a primo tag. Spell out the logic so the user sees you understand their thinking.

3. RECOMMENDED UNITS (ranked, with rationale): List the top 3-5 units that match the user's goal, ranked. For each: unit code, draw rate at user's point level, bull quality / terrain / public-land %, why it made the list. Use the actual data from query_hunting_database. If web_search filled in gaps (e.g., bull-quality reputation), cite it.

4. WHAT TO DO RIGHT NOW (1-2 sentences): Concrete action. "Apply for Unit X as your first choice, Unit Y as backup. Application deadline is [date]. If you don't draw, you bank a point and reset for next year."

5. OPTIONAL: WHEN TO RE-EVALUATE: "If you're still pointless after 3 more years, revisit — point creep may have outrun you and a different strategy makes sense."

Length target: 200-400 words for strategy questions. Shorter only if the user asks something narrow ("what's the deadline?"). Always lead with the answer, but the "answer" to a strategy question is the plan, not a single stat.`;

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
  // the answer. Review feedback (PR #18): detecting only against the current
  // turn breaks follow-ups like "what about archery?" or "when's the
  // deadline?" — the state/species context lives in the previous turn but
  // gets dropped, so sources comes back empty. Fix: scan the current message
  // first (most specific), then walk back through recent turns until we
  // find a state OR species match. The current-turn match always wins when
  // it exists, so explicit topic changes ("now tell me about Wyoming
  // moose") still override stale context.
  const recentUserTurns = sanitizedHistory
    .filter((m) => m.role === "user")
    .slice(-4)
    .map((m) => m.content);
  const detectionCandidates: string[] = [trimmedMessage, ...recentUserTurns.reverse()];
  let detected: { stateId: string | null; speciesId: string | null } = {
    stateId: null,
    speciesId: null,
  };
  for (const candidate of detectionCandidates) {
    const partial = await detectStateAndSpecies(candidate);
    if (!detected.stateId && partial.stateId) detected.stateId = partial.stateId;
    if (!detected.speciesId && partial.speciesId)
      detected.speciesId = partial.speciesId;
    if (detected.stateId && detected.speciesId) break;
  }
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
  const client = new Anthropic({ apiKey, timeout: 60_000 });

  // ---------------------------------------------------------------------------
  // Agentic tool use: Claude can call web_search (Anthropic server tool) and
  // our custom query_hunting_database tool to get fresh data before answering.
  // ---------------------------------------------------------------------------
  const tools: import("@anthropic-ai/sdk/resources").Tool[] = [
    {
      // Custom tool: query our seeded structured data (hunt_units, draw_odds,
      // harvest_stats, state_regulations). Use this BEFORE web_search for
      // states/species we already have data for (currently: Nevada).
      name: "query_hunting_database",
      description:
        "Query the HuntLogic database for structured hunting data on a specific state and species. Returns hunt unit names, draw odds, harvest statistics, and any agency-published facts we have stored locally. Use this FIRST before web_search — it's faster and more authoritative than web results. Returns an empty result if we have no data for the requested state/species.",
      input_schema: {
        type: "object" as const,
        properties: {
          state_code: {
            type: "string",
            description: "Two-letter state code, e.g. 'NV' for Nevada, 'CO' for Colorado.",
          },
          species_slug: {
            type: "string",
            description:
              "Species slug (lowercase, underscored), e.g. 'elk', 'mule_deer', 'pronghorn', 'bighorn_sheep', 'mountain_goat'.",
          },
        },
        required: ["state_code", "species_slug"],
      },
    },
    {
      // Anthropic-provided server tool: web search.
      // Model executes the search server-side, no client work needed.
      type: "web_search_20250305" as const,
      name: "web_search",
      max_uses: 5,
    } as unknown as import("@anthropic-ai/sdk/resources").Tool,
  ];

  type MessageParam = import("@anthropic-ai/sdk/resources").MessageParam;
  const conversationMessages: MessageParam[] = [
    { role: "user", content: message },
  ];

  // Agentic loop — keep calling Claude until it returns a final text response
  // (stop_reason !== "tool_use"). Hard cap at 6 iterations to prevent runaway.
  let lastTextResponse = "";
  for (let iteration = 0; iteration < 6; iteration++) {
    const response = await client.messages.create({
      model: config.ai.model,
      max_tokens: 4096,
      temperature: 0.7,
      system: CHAT_SYSTEM_PROMPT,
      tools,
      messages: conversationMessages,
    });

    // Capture latest text in case the loop exits with tool_use stop_reason
    const textBlock = response.content.find((b) => b.type === "text");
    if (textBlock && "text" in textBlock) {
      lastTextResponse = textBlock.text;
    }

    if (response.stop_reason !== "tool_use") {
      // Final answer
      return lastTextResponse || "Sorry, I couldn't generate a response.";
    }

    // Add the assistant turn (containing tool_use blocks) to the conversation
    conversationMessages.push({
      role: "assistant",
      content: response.content,
    });

    // Execute every tool_use block in this turn (skip server tools — Anthropic
    // executes those itself; we only handle our custom client tools).
    const toolResults: import("@anthropic-ai/sdk/resources").ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      if (block.name === "query_hunting_database") {
        const args = block.input as { state_code?: string; species_slug?: string };
        const result = await executeQueryHuntingDatabase(
          args.state_code ?? "",
          args.species_slug ?? "",
        );
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
      }
      // Server tools (web_search) are handled by Anthropic — no client action
    }

    if (toolResults.length === 0) {
      // No client tools fired this turn (server tools only). Loop again so the
      // model can see the server-side results and continue or finalize.
      // The server tool results are already in `response.content`, so we just
      // need to give the model an empty user turn to continue. Actually the
      // model continues on its own — we should NOT add an empty turn. Break.
      break;
    }

    conversationMessages.push({ role: "user", content: toolResults });
  }

  return lastTextResponse || "Sorry, I couldn't generate a response after tool use.";
}

// ---------------------------------------------------------------------------
// Tool executor: query our seeded structured data for a state+species
// ---------------------------------------------------------------------------
async function executeQueryHuntingDatabase(
  stateCode: string,
  speciesSlug: string,
): Promise<string> {
  const normalizedState = stateCode.toUpperCase().trim();
  const normalizedSpecies = speciesSlug.toLowerCase().trim();

  if (!normalizedState || !normalizedSpecies) {
    return JSON.stringify({
      error: "Both state_code and species_slug are required.",
    });
  }

  try {
    const result = await db.execute(sql`
      SELECT
        hu.unit_code, hu.unit_name, hu.public_land_pct,
        do.year AS odds_year, do.residency, do.weapon, do.hunt_type,
        do.points_required, do.draw_rate, do.total_applicants, do.tags_issued,
        hs.year AS stats_year, hs.success_rate, hs.average_days,
        hs.total_hunters, hs.total_harvest
      FROM states s
      LEFT JOIN species sp ON sp.slug = ${normalizedSpecies}
      LEFT JOIN hunt_units hu ON hu.state_id = s.id AND hu.species_id = sp.id
      LEFT JOIN draw_odds do ON do.hunt_unit_id = hu.id
      LEFT JOIN harvest_stats hs ON hs.hunt_unit_id = hu.id
      WHERE s.code = ${normalizedState}
      ORDER BY hu.unit_code NULLS LAST, do.year DESC NULLS LAST
      LIMIT 200
    `);
    const rows = (result as unknown as { rows?: unknown[] }).rows ?? result;
    const count = Array.isArray(rows) ? rows.length : 0;
    if (count === 0) {
      return JSON.stringify({
        state: normalizedState,
        species: normalizedSpecies,
        rowCount: 0,
        note: "No structured data in HuntLogic database for this state+species. Recommend using web_search to look up current agency data.",
      });
    }
    return JSON.stringify({
      state: normalizedState,
      species: normalizedSpecies,
      rowCount: count,
      rows: rows,
      note: "Structured data from HuntLogic database (last seeded from official agency sources). Cite by state agency name.",
    });
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
      hint: "Database query failed. Consider using web_search as a fallback.",
    });
  }
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
