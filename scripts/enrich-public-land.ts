/**
 * Enrich Public Land — BLM + USFS → hunt_units + public_land_parcels
 *
 * For each western/eastern state in our DB, fetches the agency's public
 * land overlay (BLM Surface Management Agency, USFS National Forest
 * boundaries, NPS Park Service, state-managed WMAs where available),
 * intersects it with each hunt_unit's footprint, and writes:
 *
 *   1) one row per parcel into `public_land_parcels` with the list of
 *      hunt unit codes it overlaps
 *   2) a recomputed `hunt_units.public_land_pct` based on the aggregate
 *      acreage of overlapping public parcels divided by unit acreage
 *
 * Data sources (all free, ArcGIS REST or open GeoJSON):
 *   - BLM Surface Management Agency:
 *       https://gis.blm.gov/arcgis/rest/services/admin_boundaries/
 *       BLM_Natl_SMA_LimitedScale/MapServer/0/query
 *   - USFS National Forest System Boundaries:
 *       https://apps.fs.usda.gov/arcx/rest/services/EDW/
 *       EDW_AdministrativeForest_01/MapServer/0/query
 *   - NPS Boundaries:
 *       https://services.arcgis.com/T8oZ3RYDowFc4n7l/arcgis/rest/services/
 *       NPS_Park_Boundaries/FeatureServer/0/query
 *   - USFWS National Wildlife Refuges:
 *       https://gis.fws.gov/arcgis/rest/services/FWS_Refuge_Boundaries/
 *       MapServer/0/query
 *   - State-managed lands: per-state ArcGIS endpoints (e.g.
 *       CO: cpw.maps.arcgis.com; NV: gis-ndow.arcgis.com)
 *
 * IMPORTANT — this script is structured for the real workflow but the
 * actual spatial-join step requires PostGIS or a Turf.js polygon-intersect
 * pass. Without PostGIS available we keep a "fetch + persist parcel
 * metadata" pass that lays the data foundation; the spatial-intersect
 * upgrade is the follow-up step (tracked in TODO at bottom of file).
 *
 * Run: pnpm tsx scripts/enrich-public-land.ts [--state CO]
 */

import { db } from "../src/lib/db";
import {
  states,
  huntUnits,
} from "../src/lib/db/schema";
import { publicLandParcels } from "../src/lib/db/schema/hunter-knowledge";
import { eq } from "drizzle-orm";

interface ArcGisQueryOptions {
  url: string;
  where?: string;
  outFields?: string;
  returnGeometry?: boolean;
  inSR?: number;
  outSR?: number;
}

interface ArcGisFeature {
  attributes: Record<string, unknown>;
  geometry?: {
    rings?: number[][][];
    type?: string;
    spatialReference?: { wkid: number };
  };
}

interface ArcGisResponse {
  features: ArcGisFeature[];
  exceededTransferLimit?: boolean;
}

const AGENCY_ENDPOINTS = {
  BLM: "https://gis.blm.gov/arcgis/rest/services/admin_boundaries/BLM_Natl_SMA_LimitedScale/MapServer/0/query",
  USFS: "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_AdministrativeForest_01/MapServer/0/query",
  NPS: "https://services.arcgis.com/T8oZ3RYDowFc4n7l/arcgis/rest/services/NPS_Park_Boundaries/FeatureServer/0/query",
  USFWS: "https://gis.fws.gov/arcgis/rest/services/FWS_Refuge_Boundaries/MapServer/0/query",
} as const;

const LOG_PREFIX = "[enrich:public-land]";

/**
 * Page through an ArcGIS layer's features for a given WHERE clause,
 * respecting the server's transfer limit. Returns an array of features
 * with attribute payloads (geometry stripped after centroid extraction).
 */
async function fetchArcGisFeatures(
  opts: ArcGisQueryOptions
): Promise<ArcGisFeature[]> {
  const allFeatures: ArcGisFeature[] = [];
  let offset = 0;
  const pageSize = 1000;

  while (true) {
    const params = new URLSearchParams({
      where: opts.where ?? "1=1",
      outFields: opts.outFields ?? "*",
      returnGeometry: String(opts.returnGeometry ?? true),
      f: "json",
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
      ...(opts.inSR ? { inSR: String(opts.inSR) } : {}),
      ...(opts.outSR ? { outSR: String(opts.outSR ?? 4326) } : { outSR: "4326" }),
    });

    const url = `${opts.url}?${params.toString()}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "HuntLogic-Bot/1.0" },
    });
    if (!res.ok) {
      throw new Error(`ArcGIS fetch failed (${res.status}): ${url}`);
    }
    const json = (await res.json()) as ArcGisResponse;
    if (!json.features) break;
    allFeatures.push(...json.features);
    if (!json.exceededTransferLimit || json.features.length < pageSize) {
      break;
    }
    offset += json.features.length;
  }

  return allFeatures;
}

/**
 * Compute a rough centroid of a polygon's first ring. Acceptable accuracy
 * for "where is this parcel" purposes; not a substitute for PostGIS for
 * any real spatial-join work.
 */
function centroidOfRings(rings: number[][][] | undefined):
  | { lat: number; lon: number }
  | null {
  if (!rings || rings.length === 0) return null;
  const outer = rings[0];
  if (!outer || outer.length === 0) return null;
  let sumX = 0;
  let sumY = 0;
  for (const pt of outer) {
    sumX += pt[0]!;
    sumY += pt[1]!;
  }
  return { lon: sumX / outer.length, lat: sumY / outer.length };
}

function bboxOfRings(rings: number[][][] | undefined):
  | [number, number, number, number]
  | null {
  if (!rings || rings.length === 0) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lon === undefined || lat === undefined) continue;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return [minLon, minLat, maxLon, maxLat];
}

async function ingestAgencyForState(
  stateCode: string,
  stateId: string,
  agency: keyof typeof AGENCY_ENDPOINTS,
  whereClauseForState: string,
  parcelCodeField: string,
  nameField: string,
  acreageField: string
): Promise<number> {
  console.log(`${LOG_PREFIX}   ${agency}: querying for ${stateCode}...`);
  const features = await fetchArcGisFeatures({
    url: AGENCY_ENDPOINTS[agency],
    where: whereClauseForState,
    outFields: `${parcelCodeField},${nameField},${acreageField}`,
    returnGeometry: true,
  });
  console.log(`${LOG_PREFIX}     received ${features.length} features`);

  let inserted = 0;
  for (const feat of features) {
    const attrs = feat.attributes ?? {};
    const parcelCode = String(attrs[parcelCodeField] ?? "");
    const name = (attrs[nameField] as string | undefined) ?? null;
    const acreage =
      typeof attrs[acreageField] === "number"
        ? (attrs[acreageField] as number)
        : null;
    if (!parcelCode) continue;

    const centroid = centroidOfRings(feat.geometry?.rings);
    const bbox = bboxOfRings(feat.geometry?.rings);

    await db.insert(publicLandParcels).values({
      stateId,
      landAgency: agency,
      name,
      parcelCode,
      acreage,
      // Spatial join with hunt_units happens in a follow-up PostGIS pass;
      // we leave this empty for now and let the enrichment job populate
      // it once the geometry pipeline is wired.
      overlapsUnitCodes: [],
      huntingAllowed: agency === "NPS" ? false : true,
      accessNotes: null,
      sourceDataset: `${agency} (ArcGIS REST)`,
      sourceUrl: AGENCY_ENDPOINTS[agency],
      geomCentroid: centroid,
      boundsBbox: bbox,
      lastRefreshed: new Date(),
    });
    inserted++;
  }
  console.log(`${LOG_PREFIX}     persisted ${inserted} parcels`);
  return inserted;
}

async function enrichState(stateCode: string): Promise<void> {
  const [state] = await db
    .select()
    .from(states)
    .where(eq(states.code, stateCode))
    .limit(1);
  if (!state) {
    console.log(`${LOG_PREFIX} State not found: ${stateCode} — skipping`);
    return;
  }

  console.log(`${LOG_PREFIX} Enriching ${stateCode}...`);

  // ArcGIS field names + state-filter clauses (the BLM SMA layer uses
  // STATE_NAME; USFS uses ADMINFORESTID encoding; NPS uses STATE; USFWS
  // uses STATE_ADM). We hand-encode the right WHERE for each.
  try {
    await ingestAgencyForState(
      stateCode,
      state.id,
      "BLM",
      `ADMIN_ST='${stateCode}'`,
      "OBJECTID",
      "ADMIN_AGEN",
      "GIS_ACRES"
    );
  } catch (err) {
    console.error(`${LOG_PREFIX}   BLM error for ${stateCode}: ${err}`);
  }

  try {
    await ingestAgencyForState(
      stateCode,
      state.id,
      "USFS",
      // USFS state filter is more permissive — most regions use FORESTNAME
      // and aren't filtered by state directly; we leave WHERE open and
      // let the per-state spatial pass narrow it.
      "1=1",
      "FORESTORGCODE",
      "FORESTNAME",
      "GIS_ACRES"
    );
  } catch (err) {
    console.error(`${LOG_PREFIX}   USFS error for ${stateCode}: ${err}`);
  }

  try {
    await ingestAgencyForState(
      stateCode,
      state.id,
      "NPS",
      `STATE='${stateCode}'`,
      "UNIT_CODE",
      "UNIT_NAME",
      "GIS_ACRES"
    );
  } catch (err) {
    console.error(`${LOG_PREFIX}   NPS error for ${stateCode}: ${err}`);
  }

  try {
    await ingestAgencyForState(
      stateCode,
      state.id,
      "USFWS",
      `STATE_ADM='${stateCode}'`,
      "CMPLX_NAME",
      "ORGNAME",
      "ACRES"
    );
  } catch (err) {
    console.error(`${LOG_PREFIX}   USFWS error for ${stateCode}: ${err}`);
  }

  console.log(`${LOG_PREFIX} Done with ${stateCode}.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stateArg = args.find((a) => a.startsWith("--state="))?.split("=")[1];
  const stateFromShort = args.findIndex((a) => a === "--state");
  const explicitState =
    stateArg ?? (stateFromShort >= 0 ? args[stateFromShort + 1] : undefined);

  const targets = explicitState
    ? [explicitState.toUpperCase()]
    : ["CO", "WY", "AZ", "NV", "UT", "ID", "OR", "MT", "NM", "WA", "AK", "CA"];

  for (const code of targets) {
    try {
      await enrichState(code);
    } catch (err) {
      console.error(`${LOG_PREFIX} Fatal in ${code}: ${err}`);
    }
  }

  console.log(`${LOG_PREFIX} all done`);
  process.exit(0);

  // -------------------------------------------------------------------------
  // TODO (spatial-join upgrade): after PostGIS is enabled in the prod DB,
  // add an ST_Intersects pass that joins public_land_parcels.geom with
  // hunt_units.geom (when we backfill geometries from state GIS portals),
  // populates public_land_parcels.overlaps_unit_codes, and recomputes
  // hunt_units.public_land_pct from the sum of overlapping acreage.
  // -------------------------------------------------------------------------
  void huntUnits;
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
