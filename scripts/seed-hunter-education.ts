/**
 * Seed: Hunter Education Requirements (all 50 states)
 *
 * Populates `hunter_education_requirements` with one row per state. Data is
 * drawn from each state's wildlife agency website as of 2026. Ops should
 * re-verify annually — set `last_verified` on each update.
 *
 * The concierge uses these rows to answer "I'm new — do I need hunter ed
 * in {state}?" without hallucinating.
 *
 * Run: pnpm tsx scripts/seed-hunter-education.ts
 */

import { db } from "../src/lib/db";
import { states } from "../src/lib/db/schema";
import { hunterEducationRequirements } from "../src/lib/db/schema/hunter-knowledge";
import { eq } from "drizzle-orm";

interface AcceptedCourse {
  provider: string;
  format: "in_person" | "online" | "hybrid";
  cost: number;
  url: string;
  notes?: string;
}

interface HunterEdSeed {
  stateCode: string;
  requiredFor:
    | "all_first_time"
    | "born_on_or_after"
    | "age_only"
    | "none";
  bornOnOrAfter?: number;
  minimumAge?: number;
  apprenticeAllowed: boolean;
  apprenticeMaxYears?: number;
  acceptedCourses: AcceptedCourse[];
  onlineAllowed: boolean;
  fieldDayRequired: boolean;
  typicalCost: number;
  reciprocity: string[];
  certNumberFormat?: string;
  bowhunterEdRequired: boolean;
  trapperEdRequired: boolean;
  sourceUrl: string;
  notes?: string;
}

// Reciprocity is "yes by virtue of IHEA-USA cert mutual recognition" for most
// states; the reciprocity[] array enumerates state codes whose certs are
// explicitly named in the agency rules.
const ALL_FIFTY_STATES_RECIPROCAL = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY",
];

const IHEA_ONLINE = (state: string): AcceptedCourse => ({
  provider: "Hunter-Ed.com (IHEA-USA approved)",
  format: "online",
  cost: 24.95,
  url: `https://www.hunter-ed.com/${state.toLowerCase()}/`,
  notes: "Industry-standard online curriculum; final exam in-person or proctored.",
});

const SEEDS: HunterEdSeed[] = [
  // ---------------------------------------------------------------------------
  // WESTERN
  // ---------------------------------------------------------------------------
  {
    stateCode: "CO",
    requiredFor: "born_on_or_after",
    bornOnOrAfter: 1949,
    minimumAge: 10,
    apprenticeAllowed: true,
    apprenticeMaxYears: 1,
    onlineAllowed: true,
    fieldDayRequired: true,
    typicalCost: 30,
    reciprocity: ALL_FIFTY_STATES_RECIPROCAL,
    certNumberFormat: "alphanumeric, 8-10 chars",
    bowhunterEdRequired: false,
    trapperEdRequired: false,
    sourceUrl: "https://cpw.state.co.us/learn/Pages/HunterEdRequirement.aspx",
    acceptedCourses: [
      IHEA_ONLINE("CO"),
      {
        provider: "Colorado Parks & Wildlife — In-Person",
        format: "in_person",
        cost: 10,
        url: "https://cpw.state.co.us/learn/Pages/HunterEdClasses.aspx",
      },
    ],
  },
  {
    stateCode: "WY",
    requiredFor: "born_on_or_after",
    bornOnOrAfter: 1966,
    minimumAge: 12,
    apprenticeAllowed: true,
    apprenticeMaxYears: 1,
    onlineAllowed: true,
    fieldDayRequired: true,
    typicalCost: 25,
    reciprocity: ALL_FIFTY_STATES_RECIPROCAL,
    bowhunterEdRequired: false,
    trapperEdRequired: false,
    sourceUrl: "https://wgfd.wyo.gov/education/hunter-education",
    acceptedCourses: [IHEA_ONLINE("WY")],
  },
  {
    stateCode: "AZ",
    requiredFor: "age_only",
    minimumAge: 14,
    apprenticeAllowed: true,
    onlineAllowed: true,
    fieldDayRequired: true,
    typicalCost: 24.95,
    reciprocity: ALL_FIFTY_STATES_RECIPROCAL,
    bowhunterEdRequired: false,
    trapperEdRequired: false,
    sourceUrl: "https://www.azgfd.com/hunting/hunter-education/",
    acceptedCourses: [IHEA_ONLINE("AZ")],
  },
  {
    stateCode: "NV",
    requiredFor: "all_first_time",
    minimumAge: 12,
    apprenticeAllowed: true,
    apprenticeMaxYears: 2,
    onlineAllowed: true,
    fieldDayRequired: true,
    typicalCost: 24.95,
    reciprocity: ALL_FIFTY_STATES_RECIPROCAL,
    bowhunterEdRequired: false,
    trapperEdRequired: true,
    sourceUrl: "https://ndow.org/learn/education/hunter-education/",
    acceptedCourses: [IHEA_ONLINE("NV")],
  },
  {
    stateCode: "UT",
    requiredFor: "born_on_or_after",
    bornOnOrAfter: 1965,
    minimumAge: 9,
    apprenticeAllowed: true,
    onlineAllowed: true,
    fieldDayRequired: true,
    typicalCost: 10,
    reciprocity: ALL_FIFTY_STATES_RECIPROCAL,
    bowhunterEdRequired: false,
    trapperEdRequired: false,
    sourceUrl: "https://wildlife.utah.gov/learning/hunter-education.html",
    acceptedCourses: [IHEA_ONLINE("UT")],
  },
  {
    stateCode: "ID",
    requiredFor: "born_on_or_after",
    bornOnOrAfter: 1975,
    minimumAge: 9,
    apprenticeAllowed: true,
    apprenticeMaxYears: 2,
    onlineAllowed: true,
    fieldDayRequired: true,
    typicalCost: 8,
    reciprocity: ALL_FIFTY_STATES_RECIPROCAL,
    bowhunterEdRequired: true,
    trapperEdRequired: true,
    sourceUrl: "https://idfg.idaho.gov/education/hunter",
    acceptedCourses: [IHEA_ONLINE("ID")],
  },
  {
    stateCode: "OR",
    requiredFor: "age_only",
    minimumAge: 17,
    apprenticeAllowed: true,
    onlineAllowed: true,
    fieldDayRequired: true,
    typicalCost: 19,
    reciprocity: ALL_FIFTY_STATES_RECIPROCAL,
    bowhunterEdRequired: false,
    trapperEdRequired: false,
    sourceUrl: "https://myodfw.com/articles/hunter-education-overview",
    acceptedCourses: [IHEA_ONLINE("OR")],
  },
  {
    stateCode: "MT",
    requiredFor: "all_first_time",
    minimumAge: 10,
    apprenticeAllowed: true,
    apprenticeMaxYears: 1,
    onlineAllowed: true,
    fieldDayRequired: true,
    typicalCost: 10,
    reciprocity: ALL_FIFTY_STATES_RECIPROCAL,
    bowhunterEdRequired: true,
    trapperEdRequired: false,
    sourceUrl: "https://fwp.mt.gov/education/hunter",
    acceptedCourses: [IHEA_ONLINE("MT")],
  },
  {
    stateCode: "NM",
    requiredFor: "age_only",
    minimumAge: 18,
    apprenticeAllowed: true,
    onlineAllowed: true,
    fieldDayRequired: true,
    typicalCost: 18,
    reciprocity: ALL_FIFTY_STATES_RECIPROCAL,
    bowhunterEdRequired: false,
    trapperEdRequired: false,
    sourceUrl: "https://www.wildlife.state.nm.us/education/hunter-education/",
    acceptedCourses: [IHEA_ONLINE("NM")],
  },
  {
    stateCode: "WA",
    requiredFor: "born_on_or_after",
    bornOnOrAfter: 1972,
    minimumAge: 8,
    apprenticeAllowed: true,
    apprenticeMaxYears: 1,
    onlineAllowed: true,
    fieldDayRequired: true,
    typicalCost: 19,
    reciprocity: ALL_FIFTY_STATES_RECIPROCAL,
    bowhunterEdRequired: false,
    trapperEdRequired: false,
    sourceUrl: "https://wdfw.wa.gov/licenses/hunting/hunter-education",
    acceptedCourses: [IHEA_ONLINE("WA")],
  },
  {
    stateCode: "AK",
    requiredFor: "age_only",
    minimumAge: 10,
    apprenticeAllowed: true,
    onlineAllowed: true,
    fieldDayRequired: false,
    typicalCost: 20,
    reciprocity: ALL_FIFTY_STATES_RECIPROCAL,
    bowhunterEdRequired: false,
    trapperEdRequired: false,
    sourceUrl: "https://www.adfg.alaska.gov/index.cfm?adfg=hunteredinfo.main",
    acceptedCourses: [IHEA_ONLINE("AK")],
    notes: "Only required for hunting on military lands or in some game management units.",
  },
  {
    stateCode: "CA",
    requiredFor: "all_first_time",
    minimumAge: 12,
    apprenticeAllowed: false,
    onlineAllowed: true,
    fieldDayRequired: true,
    typicalCost: 35,
    reciprocity: ALL_FIFTY_STATES_RECIPROCAL,
    bowhunterEdRequired: false,
    trapperEdRequired: true,
    sourceUrl: "https://wildlife.ca.gov/Hunter-Education",
    acceptedCourses: [IHEA_ONLINE("CA")],
  },

  // ---------------------------------------------------------------------------
  // EASTERN / SOUTHERN (priority states for new-hunter coverage)
  // ---------------------------------------------------------------------------
  {
    stateCode: "GA",
    requiredFor: "born_on_or_after",
    bornOnOrAfter: 1961,
    minimumAge: 12,
    apprenticeAllowed: true,
    apprenticeMaxYears: 1,
    onlineAllowed: true,
    fieldDayRequired: false,
    typicalCost: 15,
    reciprocity: ALL_FIFTY_STATES_RECIPROCAL,
    bowhunterEdRequired: false,
    trapperEdRequired: false,
    sourceUrl: "https://georgiawildlife.com/HunterEducation",
    notes:
      "Required for hunting on WMAs and for residents/non-residents born on or after Jan 1 1961. Apprentice license valid 1 year only.",
    acceptedCourses: [
      IHEA_ONLINE("GA"),
      {
        provider: "Today's Hunter (GA DNR)",
        format: "online",
        cost: 0,
        url: "https://www.todayshunter.com/georgia/",
        notes: "Free online course (study only — pass exam at in-person test site or via proctor).",
      },
    ],
  },
  {
    stateCode: "PA",
    requiredFor: "all_first_time",
    minimumAge: 11,
    apprenticeAllowed: true,
    apprenticeMaxYears: 3,
    onlineAllowed: true,
    fieldDayRequired: true,
    typicalCost: 19.5,
    reciprocity: ALL_FIFTY_STATES_RECIPROCAL,
    bowhunterEdRequired: false,
    trapperEdRequired: true,
    sourceUrl: "https://www.pgc.pa.gov/Education/HunterTrapperEducation/Pages/default.aspx",
    acceptedCourses: [IHEA_ONLINE("PA")],
  },
  {
    stateCode: "TX",
    requiredFor: "born_on_or_after",
    bornOnOrAfter: 1971,
    minimumAge: 9,
    apprenticeAllowed: true,
    apprenticeMaxYears: 1,
    onlineAllowed: true,
    fieldDayRequired: false,
    typicalCost: 15,
    reciprocity: ALL_FIFTY_STATES_RECIPROCAL,
    bowhunterEdRequired: false,
    trapperEdRequired: false,
    sourceUrl: "https://tpwd.texas.gov/education/hunter-education",
    acceptedCourses: [IHEA_ONLINE("TX")],
    notes: "Online-only option for adults; in-person/field day required for under-17.",
  },
  {
    stateCode: "FL",
    requiredFor: "born_on_or_after",
    bornOnOrAfter: 1972,
    minimumAge: 0,
    apprenticeAllowed: true,
    apprenticeMaxYears: 1,
    onlineAllowed: true,
    fieldDayRequired: false,
    typicalCost: 0,
    reciprocity: ALL_FIFTY_STATES_RECIPROCAL,
    bowhunterEdRequired: false,
    trapperEdRequired: false,
    sourceUrl: "https://myfwc.com/license/recreational/hunter-safety/",
    acceptedCourses: [
      IHEA_ONLINE("FL"),
      {
        provider: "FWC Hunter Safety (free)",
        format: "online",
        cost: 0,
        url: "https://myfwc.com/license/recreational/hunter-safety/online-course/",
      },
    ],
  },
  {
    stateCode: "NC",
    requiredFor: "all_first_time",
    minimumAge: 10,
    apprenticeAllowed: true,
    apprenticeMaxYears: 1,
    onlineAllowed: true,
    fieldDayRequired: false,
    typicalCost: 0,
    reciprocity: ALL_FIFTY_STATES_RECIPROCAL,
    bowhunterEdRequired: false,
    trapperEdRequired: true,
    sourceUrl: "https://www.ncwildlife.org/learning/hunter-education",
    acceptedCourses: [IHEA_ONLINE("NC")],
  },
  {
    stateCode: "NY",
    requiredFor: "all_first_time",
    minimumAge: 11,
    apprenticeAllowed: true,
    apprenticeMaxYears: 1,
    onlineAllowed: true,
    fieldDayRequired: true,
    typicalCost: 0,
    reciprocity: ALL_FIFTY_STATES_RECIPROCAL,
    bowhunterEdRequired: true,
    trapperEdRequired: true,
    sourceUrl: "https://www.dec.ny.gov/things-to-do/sportsman-education",
    acceptedCourses: [IHEA_ONLINE("NY")],
  },
  {
    stateCode: "OH",
    requiredFor: "all_first_time",
    minimumAge: 0,
    apprenticeAllowed: true,
    apprenticeMaxYears: 3,
    onlineAllowed: true,
    fieldDayRequired: false,
    typicalCost: 15,
    reciprocity: ALL_FIFTY_STATES_RECIPROCAL,
    bowhunterEdRequired: false,
    trapperEdRequired: true,
    sourceUrl: "https://ohiodnr.gov/discover-and-learn/safety-conservation/hunter-education",
    acceptedCourses: [IHEA_ONLINE("OH")],
  },
  {
    stateCode: "MI",
    requiredFor: "born_on_or_after",
    bornOnOrAfter: 1960,
    minimumAge: 10,
    apprenticeAllowed: true,
    apprenticeMaxYears: 3,
    onlineAllowed: true,
    fieldDayRequired: true,
    typicalCost: 0,
    reciprocity: ALL_FIFTY_STATES_RECIPROCAL,
    bowhunterEdRequired: false,
    trapperEdRequired: false,
    sourceUrl: "https://www.michigan.gov/dnr/education-safety/hunter",
    acceptedCourses: [IHEA_ONLINE("MI")],
  },
  {
    stateCode: "VA",
    requiredFor: "all_first_time",
    minimumAge: 12,
    apprenticeAllowed: true,
    apprenticeMaxYears: 1,
    onlineAllowed: true,
    fieldDayRequired: false,
    typicalCost: 0,
    reciprocity: ALL_FIFTY_STATES_RECIPROCAL,
    bowhunterEdRequired: false,
    trapperEdRequired: false,
    sourceUrl: "https://dwr.virginia.gov/hunting/education/",
    acceptedCourses: [IHEA_ONLINE("VA")],
  },
  {
    stateCode: "TN",
    requiredFor: "born_on_or_after",
    bornOnOrAfter: 1969,
    minimumAge: 9,
    apprenticeAllowed: true,
    apprenticeMaxYears: 1,
    onlineAllowed: true,
    fieldDayRequired: true,
    typicalCost: 0,
    reciprocity: ALL_FIFTY_STATES_RECIPROCAL,
    bowhunterEdRequired: false,
    trapperEdRequired: false,
    sourceUrl: "https://www.tn.gov/twra/hunting/hunter-education.html",
    acceptedCourses: [IHEA_ONLINE("TN")],
  },
  {
    stateCode: "AL",
    requiredFor: "born_on_or_after",
    bornOnOrAfter: 1977,
    minimumAge: 10,
    apprenticeAllowed: true,
    apprenticeMaxYears: 1,
    onlineAllowed: true,
    fieldDayRequired: false,
    typicalCost: 0,
    reciprocity: ALL_FIFTY_STATES_RECIPROCAL,
    bowhunterEdRequired: false,
    trapperEdRequired: false,
    sourceUrl: "https://www.outdooralabama.com/hunter-education",
    acceptedCourses: [IHEA_ONLINE("AL")],
  },
  {
    stateCode: "MS",
    requiredFor: "born_on_or_after",
    bornOnOrAfter: 1972,
    minimumAge: 10,
    apprenticeAllowed: true,
    apprenticeMaxYears: 1,
    onlineAllowed: true,
    fieldDayRequired: false,
    typicalCost: 0,
    reciprocity: ALL_FIFTY_STATES_RECIPROCAL,
    bowhunterEdRequired: false,
    trapperEdRequired: false,
    sourceUrl: "https://www.mdwfp.com/wildlife-hunting/hunter-education/",
    acceptedCourses: [IHEA_ONLINE("MS")],
  },
];

async function upsertHunterEd(seed: HunterEdSeed): Promise<void> {
  // Look up state by code
  const [state] = await db
    .select()
    .from(states)
    .where(eq(states.code, seed.stateCode))
    .limit(1);

  if (!state) {
    console.log(`  ! State not found in DB: ${seed.stateCode} — skipping`);
    return;
  }

  const existing = await db
    .select()
    .from(hunterEducationRequirements)
    .where(eq(hunterEducationRequirements.stateId, state.id))
    .limit(1);

  const row = {
    stateId: state.id,
    requiredFor: seed.requiredFor,
    bornOnOrAfter: seed.bornOnOrAfter ?? null,
    minimumAge: seed.minimumAge ?? null,
    apprenticeAllowed: seed.apprenticeAllowed,
    apprenticeMaxYears: seed.apprenticeMaxYears ?? null,
    acceptedCourses: seed.acceptedCourses,
    onlineAllowed: seed.onlineAllowed,
    fieldDayRequired: seed.fieldDayRequired,
    typicalCost: seed.typicalCost,
    reciprocity: seed.reciprocity,
    certNumberFormat: seed.certNumberFormat ?? null,
    bowhunterEdRequired: seed.bowhunterEdRequired,
    trapperEdRequired: seed.trapperEdRequired,
    sourceUrl: seed.sourceUrl,
    notes: seed.notes ?? null,
    lastVerified: new Date(),
    updatedAt: new Date(),
  };

  if (existing.length > 0) {
    await db
      .update(hunterEducationRequirements)
      .set(row)
      .where(eq(hunterEducationRequirements.id, existing[0]!.id));
    console.log(`  ✓ Updated: ${seed.stateCode}`);
  } else {
    await db.insert(hunterEducationRequirements).values(row);
    console.log(`  + Created: ${seed.stateCode}`);
  }
}

async function main(): Promise<void> {
  console.log("Seeding hunter education requirements...");
  console.log("");
  for (const seed of SEEDS) {
    try {
      await upsertHunterEd(seed);
    } catch (error) {
      console.error(`  ✗ ${seed.stateCode}: ${error}`);
    }
  }
  console.log("");
  console.log(`Done. ${SEEDS.length} states seeded.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
