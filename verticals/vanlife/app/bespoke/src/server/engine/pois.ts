import { and, eq, gte, inArray, lte, type Db } from "@elements/storage-sqlite-drizzle";
import type { PoiRegion } from "@elements/intake-poi-sources";
import { interestWeights, poiMarks, pois } from "../../db/schema.js";
import { discBbox, ellipseBbox, haversineMiles, withinDisc, withinEllipse, type LatLng } from "./geo.js";
import { INTEREST_CATEGORIES, byScoreThenId, popularityFallbacks, scorePoi } from "./scoring.js";

/** Optimistic corridor speed — pruning must never exclude a feasible place. */
const PRUNE_MPH = 70;

export interface CorridorPoi {
  id: number;
  name: string;
  category: string;
  lat: number;
  lng: number;
  source: string;
  url: string | null;
  popularity: number | null;
  score: number;
  pinned: boolean;
}

export interface CorridorPois {
  bbox: [number, number, number, number];
  /** Ranked side-quest pool (interest categories), capped. */
  sideQuests: CorridorPoi[];
  /** Per need-servicing category, ranked, capped. */
  byCategory: Map<string, CorridorPoi[]>;
  pinned: CorridorPoi[];
}

export async function loadInterestWeights(db: Db): Promise<Map<string, number>> {
  const rows = await db.select().from(interestWeights);
  return new Map(rows.map((r) => [r.category, r.weight]));
}

/**
 * Everything the candidate engine considers today: places inside the
 * remaining-budget ellipse from position to destination, scored and capped —
 * top 10 per interest category + top 60 overall for side-quests, top 20 per
 * needed service category. Rejected places are excluded before anything else.
 */
export async function corridorPois(
  db: Db,
  opts: {
    tripId: number;
    position: LatLng;
    dest: LatLng;
    budgetMinutes: number;
    serviceCategories: string[];
  },
): Promise<CorridorPois> {
  const maxSumMiles = (Math.max(30, opts.budgetMinutes) / 60) * PRUNE_MPH;
  const bbox = ellipseBbox(opts.position, opts.dest, maxSumMiles);

  const marks = await db.select().from(poiMarks).where(eq(poiMarks.tripId, opts.tripId));
  const rejected = new Set(marks.filter((m) => m.mark === "rejected").map((m) => m.poiId));
  const pinnedIds = new Set(marks.filter((m) => m.mark === "pinned").map((m) => m.poiId));

  const wantedCategories = [...new Set([...INTEREST_CATEGORIES, ...opts.serviceCategories])];
  const rows = await db
    .select()
    .from(pois)
    .where(
      and(
        gte(pois.lat, bbox[0]),
        lte(pois.lat, bbox[2]),
        gte(pois.lng, bbox[1]),
        lte(pois.lng, bbox[3]),
        inArray(pois.category, wantedCategories),
      ),
    );

  const inCorridor = rows.filter(
    (p) =>
      !rejected.has(p.id) &&
      withinEllipse({ lat: p.lat, lng: p.lng }, opts.position, opts.dest, maxSumMiles),
  );

  const weights = await loadInterestWeights(db);
  const fallbacks = popularityFallbacks(inCorridor);
  const scored: CorridorPoi[] = [];
  for (const p of inCorridor) {
    const score = scorePoi(p, weights, fallbacks);
    const pinned = pinnedIds.has(p.id);
    if (score === null && !pinned) continue;
    scored.push({
      id: p.id,
      name: p.name,
      category: p.category,
      lat: p.lat,
      lng: p.lng,
      source: p.source,
      url: p.url,
      popularity: p.popularity,
      score: score ?? 0,
      pinned,
    });
  }

  const interestSet = new Set<string>(INTEREST_CATEGORIES);
  const sideQuestAll = scored.filter((p) => interestSet.has(p.category)).sort(byScoreThenId);
  const perCategoryCapped: CorridorPoi[] = [];
  for (const cat of INTEREST_CATEGORIES) {
    perCategoryCapped.push(...sideQuestAll.filter((p) => p.category === cat).slice(0, 10));
  }
  const sideQuests = [...new Map(
    [...perCategoryCapped, ...sideQuestAll.slice(0, 60)].map((p) => [p.id, p]),
  ).values()].sort(byScoreThenId);

  const byCategory = new Map<string, CorridorPoi[]>();
  for (const cat of opts.serviceCategories) {
    byCategory.set(
      cat,
      scored.filter((p) => p.category === cat).sort(byScoreThenId).slice(0, 20),
    );
  }

  // Sorted like every other pool — iteration order must never depend on the
  // database's scan order (ROUTE-5 determinism).
  return { bbox, sideQuests, byCategory, pinned: scored.filter((p) => p.pinned).sort(byScoreThenId) };
}

export interface AnchorPois {
  bbox: [number, number, number, number];
  center: LatLng;
  radiusMiles: number;
  /** Ranked interest-category places inside the disc, capped. */
  suggestions: CorridorPoi[];
  /** Per need-servicing category, ranked, capped. */
  byCategory: Map<string, CorridorPoi[]>;
  pinned: CorridorPoi[];
}

/**
 * The same two-phase shape as corridorPois — SQL bbox prefilter then an in-JS
 * geometric refine — but scoped to one anchor's disc. Caps are tighter (8 per
 * interest category, 40 overall) because this list is read by a person in a
 * drill-down rather than consumed by the greedy filler.
 */
export async function anchorPois(
  db: Db,
  opts: {
    tripId: number;
    center: LatLng;
    radiusMiles: number;
    serviceCategories: string[];
  },
): Promise<AnchorPois> {
  const bbox = discBbox(opts.center, opts.radiusMiles);

  const marks = await db.select().from(poiMarks).where(eq(poiMarks.tripId, opts.tripId));
  const rejected = new Set(marks.filter((m) => m.mark === "rejected").map((m) => m.poiId));
  const pinnedIds = new Set(marks.filter((m) => m.mark === "pinned").map((m) => m.poiId));

  const wantedCategories = [...new Set([...INTEREST_CATEGORIES, ...opts.serviceCategories])];
  const rows = await db
    .select()
    .from(pois)
    .where(
      and(
        gte(pois.lat, bbox[0]),
        lte(pois.lat, bbox[2]),
        gte(pois.lng, bbox[1]),
        lte(pois.lng, bbox[3]),
        inArray(pois.category, wantedCategories),
      ),
    );

  const inDisc = rows.filter(
    (p) => !rejected.has(p.id) && withinDisc({ lat: p.lat, lng: p.lng }, opts.center, opts.radiusMiles),
  );

  const scored = scorePool(inDisc, await loadInterestWeights(db), pinnedIds);

  const interestSet = new Set<string>(INTEREST_CATEGORIES);
  const all = scored.filter((p) => interestSet.has(p.category)).sort(byScoreThenId);
  const perCategoryCapped: CorridorPoi[] = [];
  for (const cat of INTEREST_CATEGORIES) {
    perCategoryCapped.push(...all.filter((p) => p.category === cat).slice(0, 8));
  }
  const suggestions = [...new Map(
    [...perCategoryCapped, ...all.slice(0, 40)].map((p) => [p.id, p]),
  ).values()].sort(byScoreThenId);

  const byCategory = new Map<string, CorridorPoi[]>();
  for (const cat of opts.serviceCategories) {
    byCategory.set(cat, scored.filter((p) => p.category === cat).sort(byScoreThenId).slice(0, 20));
  }

  return {
    bbox,
    center: opts.center,
    radiusMiles: opts.radiusMiles,
    suggestions,
    byCategory,
    pinned: scored.filter((p) => p.pinned).sort(byScoreThenId),
  };
}

/**
 * Resolution pools for a whole anchor chain in one SQL pass, so building a plan
 * stays O(1) queries no matter how many anchors the trip has. A place inside two
 * nested discs lands in both pools — correct, since a child resolving to it is
 * exactly a narrowing of its parent.
 */
export async function anchorPoiPools(
  db: Db,
  opts: {
    tripId: number;
    anchors: { id: number; center: LatLng; radiusMiles: number }[];
    serviceCategories: string[];
  },
): Promise<Map<number, CorridorPoi[]>> {
  const pools = new Map<number, CorridorPoi[]>();
  const discs = opts.anchors.filter((a) => a.radiusMiles > 0);
  for (const a of opts.anchors) pools.set(a.id, []);
  if (discs.length === 0) return pools;

  const boxes = discs.map((a) => discBbox(a.center, a.radiusMiles));
  const union: [number, number, number, number] = [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];

  const marks = await db.select().from(poiMarks).where(eq(poiMarks.tripId, opts.tripId));
  const rejected = new Set(marks.filter((m) => m.mark === "rejected").map((m) => m.poiId));
  const pinnedIds = new Set(marks.filter((m) => m.mark === "pinned").map((m) => m.poiId));

  const wantedCategories = [...new Set([...INTEREST_CATEGORIES, ...opts.serviceCategories])];
  const rows = (
    await db
      .select()
      .from(pois)
      .where(
        and(
          gte(pois.lat, union[0]),
          lte(pois.lat, union[2]),
          gte(pois.lng, union[1]),
          lte(pois.lng, union[3]),
          inArray(pois.category, wantedCategories),
        ),
      )
  ).filter((p) => !rejected.has(p.id));

  const weights = await loadInterestWeights(db);
  for (const a of discs) {
    const inDisc = rows.filter((p) => withinDisc({ lat: p.lat, lng: p.lng }, a.center, a.radiusMiles));
    pools.set(a.id, scorePool(inDisc, weights, pinnedIds).sort(byScoreThenId));
  }
  return pools;
}

/** Shared scoring pass — pinned places survive even when their category is zeroed. */
function scorePool(
  rows: { id: number; name: string; category: string; lat: number; lng: number; source: string; url: string | null; popularity: number | null }[],
  weights: Map<string, number>,
  pinnedIds: Set<number>,
): CorridorPoi[] {
  const fallbacks = popularityFallbacks(rows);
  const out: CorridorPoi[] = [];
  for (const p of rows) {
    const score = scorePoi(p, weights, fallbacks);
    const pinned = pinnedIds.has(p.id);
    if (score === null && !pinned) continue;
    out.push({
      id: p.id,
      name: p.name,
      category: p.category,
      lat: p.lat,
      lng: p.lng,
      source: p.source,
      url: p.url,
      popularity: p.popularity,
      score: score ?? 0,
      pinned,
    });
  }
  return out;
}

/**
 * An anchor's disc split into fetch cells for the POI poller. Keys match
 * corridorRegionCells exactly so a cell claimed by both dedupes and shares one
 * freshness row.
 */
export function anchorRegionCells(center: LatLng, radiusMiles: number): PoiRegion[] {
  if (radiusMiles <= 0) return [];
  const [s, w, n, e] = discBbox(center, radiusMiles);
  const step = 1.5;
  const cells: PoiRegion[] = [];
  for (let lat = s; lat < n; lat += step) {
    for (let lng = w; lng < e; lng += step) {
      const cell: [number, number, number, number] = [
        round3(lat),
        round3(lng),
        round3(Math.min(lat + step, n)),
        round3(Math.min(lng + step, e)),
      ];
      const mid = { lat: (cell[0] + cell[2]) / 2, lng: (cell[1] + cell[3]) / 2 };
      if (haversineMiles(mid, center) <= radiusMiles + 60) {
        cells.push({ key: `${String(cell[0])},${String(cell[1])}`, bbox: cell });
      }
    }
  }
  return cells;
}

/** Nearest place of a category to a point, by great-circle distance. */
export function nearestOfCategory(
  pool: CorridorPoi[],
  point: LatLng,
  maxMiles: number,
): CorridorPoi | null {
  let best: { poi: CorridorPoi; miles: number } | null = null;
  for (const p of pool) {
    const miles = haversineMiles(point, { lat: p.lat, lng: p.lng });
    if (miles <= maxMiles && (!best || miles < best.miles || (miles === best.miles && p.id < best.poi.id))) {
      best = { poi: p, miles };
    }
  }
  return best?.poi ?? null;
}

/**
 * How much sightseeing sits next door to a point: the summed score of every
 * side-quest within `radiusMiles`. Summed score rather than a count, so one
 * strong hike outranks three forgettable ones. Order-independent, so it can
 * never move the plan on its own (ROUTE-5).
 */
export function sightAffinity(
  point: LatLng,
  sideQuests: CorridorPoi[],
  radiusMiles: number,
): number {
  let total = 0;
  for (const p of sideQuests) {
    if (haversineMiles(point, { lat: p.lat, lng: p.lng }) <= radiusMiles) total += p.score;
  }
  return total;
}

/**
 * Corridor split into fetch cells for the POI poller — ≤ ~1.5° per side so
 * Overpass queries and RIDB radius searches stay reasonably sized.
 */
export function corridorRegionCells(
  origin: LatLng,
  dest: LatLng,
  budgetMinutes: number,
): PoiRegion[] {
  const bbox = ellipseBbox(origin, dest, (Math.max(30, budgetMinutes) / 60) * PRUNE_MPH);
  const [s, w, n, e] = bbox;
  const step = 1.5;
  const cells: PoiRegion[] = [];
  for (let lat = s; lat < n; lat += step) {
    for (let lng = w; lng < e; lng += step) {
      const cell: [number, number, number, number] = [
        round3(lat),
        round3(lng),
        round3(Math.min(lat + step, n)),
        round3(Math.min(lng + step, e)),
      ];
      // Only cells the corridor actually passes through — corners of the
      // bbox can be far outside the ellipse.
      const center = { lat: (cell[0] + cell[2]) / 2, lng: (cell[1] + cell[3]) / 2 };
      if (withinEllipse(center, origin, dest, ((budgetMinutes / 60) * PRUNE_MPH) + 80)) {
        cells.push({ key: `${String(cell[0])},${String(cell[1])}`, bbox: cell });
      }
    }
  }
  return cells;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
