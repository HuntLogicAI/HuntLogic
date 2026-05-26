# Portfolio Optimizer Spec

Design doc for the layer that goes on top of the portfolio engine (PR #23). Status: proposed, not implemented.

---

## The problem

The portfolio engine projects per-track draw probability independently. That's useful but stops short of the most-valuable user question:

> *"Given my 7 NV elk + 6 WY mule deer points + $8,000 annual budget, what should I apply for THIS year to maximize expected hunting outcomes?"*

The engine tells you "if you apply for X, here's your odds." The optimizer tells you "here's the ranked list of what to apply for, given constraints."

---

## Core math

Each application is a discrete decision with:
- **Cost** — application fee + tag-on-draw cost + travel-and-lodging-if-drawn
- **Expected value** — P(draw_this_year) × HunterUtility(specific tag)
- **Compound effect on future years** — applying maintains point count; skipping freezes or, in squared systems, widens the gap

Hunter utility depends on `HunterGoals.priority`:
- `trophy`: U(tag) = bull_quality_score × public_land_pct × access_quality
- `balanced`: U(tag) = 0.4×trophy_score + 0.4×success_rate + 0.2×cost_efficiency
- `annual_hunt`: U(tag) = P(any_harvest) × cost_efficiency

---

## Algorithm

### Phase 1: Marginal Value Ranking

For each existing track (each state × species the user holds points in):

```
marginal_value = expected_tags_within_horizon × hunter_utility(track)
                 - sum_of_application_fees_within_horizon
```

Rank tracks descending by `marginal_value / horizon_years`. Top of list = best ongoing portfolio members.

### Phase 2: Hypothetical Additions

For each state × species the user does NOT currently hold points in:

Simulate joining the queue starting at 0 points → compute their `marginal_value` at the goal horizon.

Compare against existing tracks. Surface any hypothetical addition whose `marginal_value` exceeds the lowest-ranked existing track's value (i.e. "you should start applying in AZ; it's a better use of resources than your stagnant CA position").

### Phase 3: Annual Application Slate

For the upcoming year specifically, output a ranked recommendation:

```
This year's recommended applications (in priority order):
  1. NV unit 10 mule deer — 23% draw odds at your 7 pts. EV $X.
  2. WY Hunt Area 100 elk — 8% odds, low cost, builds toward year-7 hit.
  3. AZ apply for points only (build year 1 of new track).
  4. NM Gila elk DIY — pure random 4-8% any-year shot, $300 NR app.
  5. CO archery elk OTC — annual hunt fallback, no points cost.
Skip: UT bighorn sheep (sub-1% at squared math, multi-decade arc — diverting points budget hurts).
```

### Phase 4: Budget Constraint

Greedy knapsack: starting from highest `marginal_value / cost`, fill until budget is exhausted. Surface what was cut and why.

If the user's expressed `payToBypassToleranceUsd` is high, also surface paid bypasses (NM EPLUS landowner tags, CO landowner vouchers, governor's tags) ranked by `(probability_uplift × hunter_utility) / cost`.

---

## API shape

```typescript
POST /api/v1/portfolio/optimize

{
  holdings: [...],                    // same as simulate
  goals: HunterGoals,
  horizonYears: 10,
  includeNewStates: boolean,          // simulate hypothetical additions?
  candidateStates?: string[],         // limit hypotheticals to specific states
}

Response: {
  ranked: PortfolioRecommendation[],  // ordered top-to-bottom
  hypotheticalAdditions: PortfolioRecommendation[],
  thisYearSlate: AnnualApplicationSlate,
  budgetAnalysis: {
    spent: number,
    cut: PortfolioRecommendation[],
    bypassOptions: BypassOption[],
  },
  disclaimers: string[],
}
```

---

## Implementation notes

- Reuse `engine.ts::simulatePortfolio()` heavily. The optimizer just calls it once per (real + hypothetical) track and ranks the results.
- Cost data: needs a per-state cost table (NR application fee, NR tag cost, point-only purchase cost). Can hand-curate; doesn't need to be dynamic.
- Hunter utility heuristics: start hand-tuned, no ML. Move to learned model only if hand-tuned proves brittle.
- Knapsack with stochastic outcomes is NP-hard in general, but with our scale (~20 tracks × 10 years × few residency variants) a greedy approximation gives 95%+ optimal solutions. Don't over-engineer.

---

## Risks / open questions

- **Cost data freshness:** state fees change yearly. How do we keep current?
- **Hunter utility is subjective:** "trophy" means different things to different hunters. Validate with at least 3-5 real users before launching.
- **Hypothetical additions might overwhelm:** if we surface every western state as a possible "you should start here" suggestion, the UI gets noisy. Cap at top-3 hypotheticals.
- **WY hybrid 75/25 split complicates the optimizer:** the same track has two effective draw paths. Worth modeling as two separate sub-tracks?
