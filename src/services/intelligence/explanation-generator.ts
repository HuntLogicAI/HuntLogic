// =============================================================================
// Explanation Generator — Stage 4 of the Recommendation Pipeline
//
// Uses Claude to generate personalized, plain-English explanations for each
// recommendation and for the overall playbook strategy.
// =============================================================================

import { sendMessage, ADVANCED_MODEL } from "@/lib/ai/client";
import { assembleContext } from "@/lib/ai/rag";
import type { HunterProfile } from "@/services/profile/types";
import type { ScoredHunt, StrategyPlan } from "./types";

const LOG_PREFIX = "[intelligence]";

// =============================================================================
// Helpers
// =============================================================================

function buildProfileContext(profile: HunterProfile): string {
  const parts: string[] = [];

  parts.push(`Hunter: ${profile.displayName ?? "Anonymous"}`);
  parts.push(`Home State: ${getPreference(profile, "location", "home_state") ?? "Unknown"}`);

  const orientation = getPreference(profile, "hunt_orientation", "orientation");
  if (orientation) parts.push(`Orientation: ${orientation}`);

  const timeline = getPreference(profile, "timeline", "timeline");
  if (timeline) parts.push(`Timeline: ${timeline}`);

  const budget = getPreference(profile, "budget", "annual_budget");
  if (budget) parts.push(`Budget: ${budget}`);

  const physical = getPreference(profile, "physical", "physical_ability");
  if (physical) parts.push(`Physical Ability: ${physical}`);

  const travel = getPreference(profile, "travel", "travel_tolerance");
  if (travel) parts.push(`Travel Tolerance: ${travel}`);

  const weapon = getPreference(profile, "weapon", "weapon");
  if (weapon) parts.push(`Weapon: ${Array.isArray(weapon) ? weapon.join(", ") : weapon}`);

  // Species interests
  const speciesInterests = profile.preferences
    .filter((p) => p.category === "species_interest" && p.value === true)
    .map((p) => p.key);
  if (speciesInterests.length > 0) parts.push(`Species: ${speciesInterests.join(", ")}`);

  // Point holdings
  if (profile.pointHoldings.length > 0) {
    const holdings = profile.pointHoldings
      .map((h) => `${h.stateCode} ${h.speciesName}: ${h.points} ${h.pointType} pts`)
      .join("; ");
    parts.push(`Points: ${holdings}`);
  }

  return parts.join("\n");
}

function getPreference(
  profile: HunterProfile,
  category: string,
  key: string
): unknown | null {
  return (
    profile.preferences.find((p) => p.category === category && p.key === key)
      ?.value ?? null
  );
}

function buildHuntContext(hunt: ScoredHunt): string {
  const parts: string[] = [];

  parts.push(`State: ${hunt.stateName} (${hunt.stateCode})`);
  parts.push(`Species: ${hunt.speciesName}`);
  if (hunt.unitCode) parts.push(`Unit: ${hunt.unitCode}${hunt.unitName ? ` (${hunt.unitName})` : ""}`);
  parts.push(`Tag Type: ${hunt.tagType ?? "unknown"}`);
  parts.push(`Rec Type: ${hunt.recType}`);
  parts.push(`Timeline: ${hunt.timelineCategory}`);
  parts.push(`Composite Score: ${hunt.compositeScore.toFixed(3)}`);

  // Factor scores
  parts.push(`\nFactor Scores:`);
  parts.push(`  Draw Odds: ${hunt.factors.draw_odds_score.toFixed(2)}`);
  parts.push(`  Trophy Quality: ${hunt.factors.trophy_quality_score.toFixed(2)}`);
  parts.push(`  Success Rate: ${hunt.factors.success_rate_score.toFixed(2)}`);
  parts.push(`  Cost Efficiency: ${hunt.factors.cost_efficiency_score.toFixed(2)}`);
  parts.push(`  Access: ${hunt.factors.access_score.toFixed(2)}`);
  parts.push(`  Forecast: ${hunt.factors.forecast_score.toFixed(2)}`);
  parts.push(`  Personal Fit: ${hunt.factors.personal_fit_score.toFixed(2)}`);
  parts.push(`  Timeline Fit: ${hunt.factors.timeline_fit_score.toFixed(2)}`);

  // Cost estimate
  parts.push(`\nEstimated Cost: $${hunt.estimatedCost.total.toLocaleString()}`);
  parts.push(`  Tag: $${hunt.estimatedCost.tag}`);
  parts.push(`  License: $${hunt.estimatedCost.license}`);
  parts.push(`  Travel: $${hunt.estimatedCost.travel}`);

  // Draw data
  if (hunt.latestDrawRate !== null) {
    parts.push(`\nDraw Rate: ${(hunt.latestDrawRate * 100).toFixed(1)}%`);
  }
  if (hunt.latestMinPoints !== null) {
    parts.push(`Min Points Drawn: ${hunt.latestMinPoints}`);
  }
  if (hunt.latestSuccessRate !== null) {
    parts.push(`Success Rate: ${(hunt.latestSuccessRate * 100).toFixed(1)}%`);
  }
  if (hunt.publicLandPct !== null) {
    parts.push(`Public Land: ${hunt.publicLandPct}%`);
  }

  parts.push(`\nConfidence: ${hunt.confidence.label} (${hunt.confidence.basis})`);

  return parts.join("\n");
}

// =============================================================================
// Explanation Generation
// =============================================================================

const EXPLANATION_SYSTEM_PROMPT = `You are HuntLogic's personalized hunting advisor. Your job is to explain WHY a specific hunt recommendation is a good fit for this particular hunter, in a conversational, trustworthy tone.

Rules:
- Write in second person ("you", "your")
- Reference the hunter's stated goals, preferences, and constraints
- Explain the key factors that make this a good (or reasonable) fit
- Mention the confidence level and what it's based on
- Note any caveats, assumptions, or risks
- Keep it to 2-4 sentences, conversational and direct
- Sound like a trusted advisor, not a data dump
- Never fabricate data — use the numbers provided
- If state agency data is provided, reference specific details (deadlines, regulation changes, draw statistics) to make your explanation more authoritative
- If confidence is low, be transparent about uncertainty`;

/**
 * Generate a personalized explanation for a single recommendation.
 */
export async function generateExplanation(
  hunt: ScoredHunt,
  profile: HunterProfile,
  strategy: StrategyPlan
): Promise<string> {
  console.log(
    `${LOG_PREFIX} generateExplanation: ${hunt.stateCode}/${hunt.speciesSlug}/${hunt.unitCode ?? "state"}`
  );

  try {
    // Retrieve relevant state/species documents for grounded explanations
    let ragContext = "";
    try {
      const ragQuery = `${hunt.stateCode} ${hunt.speciesName} draw odds regulations ${hunt.unitCode ?? ""}`.trim();
      ragContext = await assembleContext(ragQuery, 3, {
        stateId: hunt.stateId ?? undefined,
        speciesId: hunt.speciesId ?? undefined,
      });
    } catch (ragErr) {
      console.warn(`${LOG_PREFIX} RAG context unavailable: ${ragErr instanceof Error ? ragErr.message : String(ragErr)}`);
    }

    const prompt = `Given this hunter's profile and the following scored hunt recommendation, write a personalized explanation of why this hunt is recommended.

HUNTER PROFILE:
${buildProfileContext(profile)}

HUNT RECOMMENDATION:
${buildHuntContext(hunt)}

STRATEGY CONTEXT:
- Near-term hunts in plan: ${strategy.nearTerm.length}
- Mid-term hunts in plan: ${strategy.midTerm.length}
- Long-term hunts in plan: ${strategy.longTerm.length}
- Warnings: ${strategy.warnings.length > 0 ? strategy.warnings.join("; ") : "none"}
${ragContext ? `\nRELEVANT STATE AGENCY DATA:\n${ragContext}` : ""}
Write a conversational, 2-4 sentence explanation of why this hunt fits this hunter's goals. Reference specific data points and the hunter's stated preferences. If the state agency data above contains relevant details (deadlines, regulation changes, draw statistics), incorporate them naturally. Be honest about confidence level.`;

    const response = await sendMessage({
      messages: [{ role: "user", content: prompt }],
      systemPrompt: EXPLANATION_SYSTEM_PROMPT,
      model: ADVANCED_MODEL,
      maxTokens: 512,
      temperature: 0.6,
    });

    const text =
      response.content[0]?.type === "text" ? response.content[0].text : "";

    return text.trim();
  } catch (error) {
    console.error(`${LOG_PREFIX} generateExplanation: error`, error);
    // Fallback to a template-based explanation
    return buildFallbackExplanation(hunt, profile);
  }
}

/**
 * Generate a summary for the entire playbook.
 */
export async function generatePlaybookSummary(
  strategy: StrategyPlan,
  profile: HunterProfile
): Promise<string> {
  console.log(`${LOG_PREFIX} generatePlaybookSummary: generating executive summary`);

  try {
    const nearTermSummary = strategy.nearTerm
      .map(
        (r) =>
          `${r.hunt.stateCode} ${r.hunt.speciesName} (${r.hunt.unitCode ?? "state"}) — ${r.hunt.recType}`
      )
      .join("\n  ");
    const midTermSummary = strategy.midTerm
      .map(
        (r) =>
          `${r.hunt.stateCode} ${r.hunt.speciesName} (${r.hunt.unitCode ?? "state"}) — ${r.hunt.recType}`
      )
      .join("\n  ");
    const longTermSummary = strategy.longTerm
      .map(
        (r) =>
          `${r.hunt.stateCode} ${r.hunt.speciesName} (${r.hunt.unitCode ?? "state"}) — ${r.hunt.recType}`
      )
      .join("\n  ");
    const pointStrategySummary = strategy.pointStrategy
      .map(
        (p) =>
          `${p.stateCode} ${p.speciesName}: ${p.currentPoints} pts → ${p.recommendation}`
      )
      .join("\n  ");

    // Gather RAG context from all states in the strategy
    let ragContext = "";
    try {
      const stateNames = new Set<string>();
      for (const r of [...strategy.nearTerm, ...strategy.midTerm, ...strategy.longTerm]) {
        stateNames.add(r.hunt.stateName);
      }
      const ragQuery = `hunting regulations draw odds seasons ${[...stateNames].join(" ")}`;
      ragContext = await assembleContext(ragQuery, 5);
    } catch (ragErr) {
      console.warn(`${LOG_PREFIX} RAG context unavailable for summary: ${ragErr instanceof Error ? ragErr.message : String(ragErr)}`);
    }

    const prompt = `Write an executive summary (2-3 paragraphs) for this hunter's personalized hunting playbook.

HUNTER PROFILE:
${buildProfileContext(profile)}

STRATEGY OVERVIEW:
Near-term (This Year):
  ${nearTermSummary || "None"}

Mid-term (2-4 Years):
  ${midTermSummary || "None"}

Long-term (5+ Years):
  ${longTermSummary || "None"}

Point Strategy:
  ${pointStrategySummary || "No point holdings"}

Budget: $${strategy.budgetAllocation.totalBudget.toLocaleString()}
Total Estimated Cost: $${strategy.totalEstimatedCost.toLocaleString()}
Warnings: ${strategy.warnings.length > 0 ? strategy.warnings.join("; ") : "None"}
${ragContext ? `\nSTATE AGENCY REFERENCE DATA:\n${ragContext}` : ""}
Write a warm, confident executive summary that:
1. Summarizes the hunter's goals and what this playbook does for them
2. Highlights the top 2-3 most exciting opportunities
3. Notes any key strategic decisions (point building, state focus, etc.)
4. Mentions budget fit and timeline
5. If the reference data above contains relevant deadlines or regulation details, weave them in naturally
Be conversational and encouraging, like a trusted advisor.`;

    const response = await sendMessage({
      messages: [{ role: "user", content: prompt }],
      systemPrompt:
        "You are HuntLogic's strategic hunting advisor. Write executive summaries for personalized hunting playbooks. Be conversational, data-driven, and trustworthy.",
      model: ADVANCED_MODEL,
      maxTokens: 1024,
      temperature: 0.6,
    });

    const text =
      response.content[0]?.type === "text" ? response.content[0].text : "";
    return text.trim();
  } catch (error) {
    console.error(`${LOG_PREFIX} generatePlaybookSummary: error`, error);
    return buildFallbackSummary(strategy, profile);
  }
}

/**
 * Generate a rationale for the overall strategy decisions.
 */
export async function generateStrategyRationale(
  strategy: StrategyPlan,
  profile: HunterProfile
): Promise<string> {
  console.log(`${LOG_PREFIX} generateStrategyRationale`);

  try {
    // RAG context for state-level regulation intelligence
    let ragContext = "";
    try {
      const states = strategy.pointStrategy.map((p) => p.stateCode).join(" ");
      const ragQuery = `hunting application strategy point system draw odds ${states}`.trim();
      ragContext = await assembleContext(ragQuery, 3);
    } catch (ragErr) {
      console.warn(`${LOG_PREFIX} RAG context unavailable for rationale: ${ragErr instanceof Error ? ragErr.message : String(ragErr)}`);
    }

    const prompt = `Explain the strategic thinking behind this hunting plan in 2-3 sentences. Focus on:
- Why these states/species were chosen
- The balance between short-term and long-term
- Budget tradeoffs
- Any key point strategy decisions

HUNTER PROFILE:
${buildProfileContext(profile)}

Near-term: ${strategy.nearTerm.length} hunts
Mid-term: ${strategy.midTerm.length} hunts
Long-term: ${strategy.longTerm.length} hunts
Point states: ${strategy.pointStrategy.map((p) => `${p.stateCode} ${p.speciesName}`).join(", ") || "none"}
Budget: $${strategy.budgetAllocation.totalBudget.toLocaleString()}
Warnings: ${strategy.warnings.join("; ") || "none"}
${ragContext ? `\nSTATE AGENCY CONTEXT:\n${ragContext}` : ""}`;

    const response = await sendMessage({
      messages: [{ role: "user", content: prompt }],
      systemPrompt:
        "You are a strategic hunting advisor. Explain strategy rationale concisely.",
      model: ADVANCED_MODEL,
      maxTokens: 512,
      temperature: 0.5,
    });

    const text =
      response.content[0]?.type === "text" ? response.content[0].text : "";
    return text.trim();
  } catch (error) {
    console.error(`${LOG_PREFIX} generateStrategyRationale: error`, error);
    return "Strategy optimized for your stated preferences, balancing near-term opportunities with long-term investments.";
  }
}

// =============================================================================
// Fallback Explanations (when AI is unavailable)
// =============================================================================

function buildFallbackExplanation(
  hunt: ScoredHunt,
  profile: HunterProfile
): string {
  const parts: string[] = [];

  if (hunt.recType === "otc_opportunity") {
    parts.push(
      `${hunt.stateName} offers over-the-counter ${hunt.speciesName} tags, meaning you can hunt this year without a draw.`
    );
  } else if (hunt.recType === "apply_now" && hunt.latestDrawRate !== null) {
    parts.push(
      `With a ${(hunt.latestDrawRate * 100).toFixed(0)}% draw rate, ${hunt.stateCode} ${hunt.speciesName} in ${hunt.unitCode ?? "this area"} offers reasonable odds for this year's application cycle.`
    );
  } else if (hunt.recType === "build_points") {
    // Bug fix: when latestMinPoints is 0 or unknown the original copy read
    // "...toward the 0-point threshold" — incoherent (a 0-point threshold
    // means you're already eligible). Fall back to qualitative wording.
    const minPts = hunt.latestMinPoints;
    if (typeof minPts === "number" && minPts > 0) {
      parts.push(
        `${hunt.stateCode} ${hunt.speciesName} is a point-building opportunity. Continue accumulating points toward the ${minPts}-point threshold.`
      );
    } else {
      parts.push(
        `${hunt.stateCode} ${hunt.speciesName} is a point-building opportunity — historical draw-out points haven't been recorded yet, so the safest play is to keep banking points while we collect more data.`
      );
    }
  }

  // Bug fix: the original copy said "solid hunting opportunity" regardless
  // of the actual success rate, including 0%. Make the qualifier match the
  // number.
  if (hunt.latestSuccessRate !== null && hunt.latestSuccessRate > 0) {
    const rate = Math.round(hunt.latestSuccessRate * 100);
    const qualifier =
      rate >= 60
        ? "very strong"
        : rate >= 40
          ? "solid"
          : rate >= 20
            ? "modest"
            : "below-average";
    parts.push(
      `Historical success rate of ${rate}% — a ${qualifier} hunting opportunity.`
    );
  }

  parts.push(
    `Estimated total cost: $${hunt.estimatedCost.total.toLocaleString()}. Confidence: ${hunt.confidence.label}.`
  );

  return parts.join(" ");
}

function buildFallbackSummary(
  strategy: StrategyPlan,
  _profile: HunterProfile
): string {
  const totalHunts =
    strategy.nearTerm.length + strategy.midTerm.length + strategy.longTerm.length;

  return (
    `Your personalized playbook includes ${totalHunts} recommended hunts across ` +
    `${strategy.nearTerm.length} near-term, ${strategy.midTerm.length} mid-term, and ` +
    `${strategy.longTerm.length} long-term opportunities. ` +
    `Budget allocation targets $${strategy.budgetAllocation.totalBudget.toLocaleString()} ` +
    `across all planned activities. ${strategy.pointStrategy.length > 0 ? `Point strategy covers ${strategy.pointStrategy.length} state/species combination${strategy.pointStrategy.length > 1 ? "s" : ""}.` : ""}`
  );
}
