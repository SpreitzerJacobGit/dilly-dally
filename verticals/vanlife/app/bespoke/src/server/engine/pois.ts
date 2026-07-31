import { and, eq, gte, inArray, lte, type Db } from "@elements/storage-sqlite-drizzle";
import type { PoiRegion } from "@elements/intake-poi-sources";
import { interestWeights, poiMarks, pois } from "../../db/schema.js";
import { ellipseBbox, haversineMiles, withinEllipse, type LatLng } from "./geo.js";
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
