# Western Agency Ingestion — Research Notes

**Last updated:** 2026-06-02
**Author:** Claude (overnight autonomous session)

This is a handoff document. It captures what was discovered about each remaining
Western state's data source so the next session can skip discovery and go
straight to building.

## Where we are

| State | Endpoint built | Data in prod DB | Notes |
|---|---|---|---|
| CO | ✓ `seed-cpw-draw-odds` | ✓ | Live |
| WY | ✓ `seed-wgfd-draw-odds` | ✓ | Live |
| UT | ✓ `seed-utdwr-draw-odds` | ✓ | Live |
| NM | ✓ `seed-nmdgf-draw-odds` | ✓ | Live |
| AZ | ✓ `seed-azgfd-draw-odds` | ✓ | Live |
| **ID** | ✓ `seed-idfg-draw-odds` | ✓ | Merged + run this session via PR #27. ~1k+ rows. |
| **NV** | ✓ `seed-ndow-draw-odds` (PR #30, open) | partial | New this session. **Draw odds + harvest stats from one Excel — see PR #30.** |
| MT | ✗ | ✗ | Portal form. Needs scrape. |
| OR | ✗ | ✗ | Per-species PDFs. Naming pattern partly known. |
| WA | ✗ | ✗ | Not researched. |
| CA | ✗ | ✗ | Not researched. |

## NV — the big win this session

NDOW publishes a single XLSX with both draw odds AND harvest stats in one row
per (hunt, unit-group, residency, weapon). PR #30 (`feat/ndow-draw-odds`)
populates `draw_odds` + `harvest_stats` in one pass. Once merged, run:

```
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "https://app-chi-rust-81.vercel.app/api/admin/seed-ndow-draw-odds"
```

Expect ~1,000 draw_odds rows + ~600 harvest_stats rows (some excel rows have
no quota/applicants → null).

## Per-state research

### MT — Montana FWP

- **Discovery portal:** https://myfwp.mt.gov/fwpPub/drawingStatistics
- **Form action:** `/fwpPub/drawingStatistics.action` (Struts 2 POST, HTML response — *not* JSON)
- **Filters available:** Species dropdown (Antelope, Elk, Goat, Moose, Nonresident Combination, Other, Sheep, White-tailed/Mule Deer). No year filter exposed in main form.
- **Columns returned in results table:** `LPT` (License/Permit Type), `# Applicants` (resident + NR 1st choice), `# Successful` (1st choice drawn), `% Successful`.
- **Static dumps:** Only 3 summary infographics on https://fwp.mt.gov/buyandapply/hunting-licenses/drawing-statistics — no row-level dumps.
- **Other useful URL:** https://fwp.mt.gov/binaries/content/assets/fwp/buyandapply/hunting/misc/drawing-statistics-reports.pdf (infographic only).

**Recommended next step:** POST to `drawingStatistics.action` per species with form fields discovered from the page source (download HTML, parse `<select>` options for species + any hidden inputs). Parse the HTML response with `cheerio` (already a dep) — pull the results table directly. Iterate species × year. **Effort: 1 focused day.**

### OR — Oregon ODFW

- **Per-species PDF naming pattern:**
  `https://www.dfw.state.or.us/resources/hunting/big_game/controlled_hunts/reports/docs/{YEAR}/{YEAR}%20Preference%20Point%20Draw%20Report%20{SPECIES}.pdf`
- **Confirmed 200s** (probed Jun 2 2026): `Buck Deer`, `Antlerless Deer`.
- **Confirmed 404s** (under that pattern): `Bull Elk`, `Antlerless Elk`, `Pronghorn Antelope`, `Bighorn Sheep`, `Rocky Mountain Goat`, `Cougar`.
- **Implication:** Elk, antelope, sheep, goat use a different filename — needs discovery (maybe "Rocky Mountain Elk" / "Roosevelt Elk" suffix? Or different report category?). Try:
  - `2024%20Rocky%20Mtn%20Bull%20Elk%20Draw%20Report.pdf`
  - `2024%20Bull%20Rocky%20Elk%20PP%20Draw.pdf`
  - Use Google site-search: `site:dfw.state.or.us 2024 elk preference point`
- **Aggregator portal:** https://odfw.huntfishoregon.com/reportdownloads is JS-rendered (empty HTML on raw curl). Use a headless browser (puppeteer) or inspect network requests if a real solution is needed.
- **PDF format:** the Buck Deer PDF (~158 KB) extracts column headers `Hunt Number | Hunt Name | Tags Authorized | Resident Apps | Resident Drawn | NR Apps | NR Drawn | ...` per the Google search snippet. Highly parseable.

**Recommended next step:** Confirm the elk PDF filename via one Google site-search call, then build a parser that iterates species × year using the known prefix. Same shape as `seed-cpw-draw-odds` / `seed-wgfd-draw-odds` (PDF text → regex tabular rows). **Effort: ~½ day.**

### WA — Washington WDFW

- **Not researched this session.** WDFW publishes Special Hunt Permit Statistics annually. Likely URLs to try:
  - `https://wdfw.wa.gov/hunting/management/special-hunts/statistics`
  - `https://wdfw.wa.gov/sites/default/files/publications/`
- **Recommended discovery:** WebSearch `Washington WDFW special hunt permit statistics 2024 PDF` then fetch the results page.

### CA — California CDFW

- **Not researched this session.** CDFW's big-game data is sparser (mostly deer zone reports). Likely URLs:
  - `https://wildlife.ca.gov/Hunting/Deer/Statistics`
  - `https://nrm.dfg.ca.gov/FileHandler.ashx?...` (their content portal)
- **Recommended discovery:** WebSearch `California CDFW deer harvest 2024 statistics PDF`. CA's value is lower than the others (fewer big-game opportunities), so deprioritize behind MT/OR/WA.

## Shape to mirror

All new endpoints should follow the existing pattern:
- `src/app/api/admin/seed-{agency}-draw-odds/route.ts`
- `runtime = "nodejs"`, `maxDuration = 300`
- `CRON_SECRET` Bearer auth
- `?debug=1` returns first ~12 parsed rows without insert
- Upsert into `hunt_units` (synthesize unit_code if multiple hunts share a unit — see PR #30)
- Insert into `draw_odds` (and `harvest_stats` when the same source has it)
- `rawData` jsonb preserves the original row for provenance

## Layer 3 (unit metadata) status

Not started for any state. Hunt-unit terrain/access/landmark metadata is its
own multi-week effort and depends on per-state landmark data sources (often
agency unit-boundary KML/GeoJSON + outside terrain rasters). Out of scope
for the draw-odds ingestion work.

## Roadmap entries this affects

Notion → Roadmap DB:
- "Run IDFG draw-odds seed after PR #27 merge" — **DONE this session**
- "Agency draw-odds ingestion — remaining states" — NV done (PR #30); MT/OR/WA/CA notes captured here
- "Hunt-unit landmark enrichment" — unchanged, not started
