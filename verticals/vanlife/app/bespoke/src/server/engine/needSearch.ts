import { and, asc, eq, gte, lte, type Db } from "@elements/storage-sqlite-drizzle";
import {
  daySelections,
  needs,
  poiMarks,
  pois,
  routeCandidates,
  routeLegs,
} from "../../db/schema.js";
import { currentPosition, planDateOf, type TripRow } from "./candidates.js";
import {
  bboxAround,
  detourEstimateMinutes,
  haversineMiles,
  pointToLineMiles,
  type LatLng,
  type LineCoords,
} from "./geo.js";
import { osrmTable, OsrmUnavailableError } from "./osrm.js";

/**
 * Route-through-needs, the on-demand half: given one need, the places that can
 * service it — how far each is from where the van is now, and how many minutes
 * it would add to today's chosen route.
 *
 * Everything is answered from the local place catalog, so this works with no
 * uplink (NEED-6). Real drive times come from one router matrix call; when the
 * router is down the geometric estimates stand in and say so rather than the
 * list going empty (OFF-3).
 */

/** Places whose category can service a need are never scored — only measured. */
export interface NeedFacilityOption {
  poiId: number;
  name: string;
  category: string;
  lat: number;
  lng: number;
  source: string;
  url: string | null;
  popularity: number | null;
  milesFromHere: number;
  /** Distance to today's route; null when no candidate could be resolved. */
  milesFromRoute: number | null;
  /** Added minutes vs today's route; null when no candidate could be resolved. */
  detourMinutes: number | null;
  pinned: boolean;
  /** Already a stop on the resolved candidate. */
  plannedToday: boolean;
}

export interface NeedFacilityResult {
  needId: number;
  needTitle: string;
  poiCategory: string | null;
  origin: { lat: number; lng: number; label: string };
  candidateId: number | null;
  /** How the added-time figures were produced — never silently mixed. */
  detourSource: "routed" | "estimated" | "none";
  message: string | null;
  options: NeedFacilityOption[];
}

/** Guard on the local scan; the radius filter does the real narrowing. */
const MAX_SCANNED = 1000;

function parseGeometry(raw: string): LineCoords {
  try {
    const parsed: unknown = JSON.parse(raw);
    const coords = (parsed as { coordinates?: unknown }).coordinates;
    if (!Array.isArray(coords)) return [];
    return coords.filter(
      (c): c is [number, number] =>
        Array.isArray(c) && c.length >= 2 && typeof c[0] === "number" && typeof c[1] === "number",
    );
  } catch {
    return [];
  }
}

/** Cheapest insertion of `p` anywhere along `points`, in estimated minutes. */
function estimatedDetour(points: LatLng[], p: LatLng): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length - 1; i++) {
    const detour = detourEstimateMinutes(points[i]!, p, points[i + 1]!);
    if (detour < best) best = detour;
  }
  return best;
}

export async function needFacilityOptions(
  db: Db,
  opts: {
    trip: TripRow;
    needId: number;
    nowIso: string;
    candidateId?: number;
    radiusMiles: number;
    limit: number;
  },
): Promise<NeedFacilityResult> {
  const need = (await db.select().from(needs).where(eq(needs.id, opts.needId)))[0];
  if (!need) throw new Error(`No need with id ${String(opts.needId)}`);

  const position = await currentPosition(db, opts.trip);
  const origin = { lat: position.lat, lng: position.lng, label: position.label };
  const base = {
    needId: need.id,
    needTitle: need.title,
    poiCategory: need.poiCategory,
    origin,
  };

  // A checklist-only need never generates route stops (NEED-5).
  if (need.poiCategory === null) {
    return {
      ...base,
      candidateId: null,
      detourSource: "none",
      message: "This need is a checklist item — it never generates route stops.",
      options: [],
    };
  }

  // Today's route, if one has been picked. Named candidate wins, then the
  // day's selection; either way it must belong to this trip and this date.
  const planDate = planDateOf(opts.nowIso);
  const dayRows = await db
    .select()
    .from(routeCandidates)
    .where(and(eq(routeCandidates.tripId, opts.trip.id), eq(routeCandidates.planDate, planDate)));
  let candidate = opts.candidateId === undefined
    ? undefined
    : dayRows.find((c) => c.id === opts.candidateId);
  if (!candidate) {
    const sel = (
      await db
        .select()
        .from(daySelections)
        .where(and(eq(daySelections.tripId, opts.trip.id), eq(daySelections.planDate, planDate)))
    )[0];
    candidate = sel ? dayRows.find((c) => c.id === sel.candidateId) : undefined;
  }

  const geometry = candidate ? parseGeometry(candidate.geometry) : [];
  const legs = candidate
    ? await db
        .select()
        .from(routeLegs)
        .where(eq(routeLegs.candidateId, candidate.id))
        .orderBy(asc(routeLegs.orderIndex), asc(routeLegs.id))
    : [];
  // The same sequence the planner inserts into: where we are, then each stop.
  const points: LatLng[] = [origin, ...legs.map((l) => ({ lat: l.toLat, lng: l.toLng }))];
  const hasRoute = candidate !== undefined && points.length >= 2;

  const bbox = bboxAround(hasRoute ? points : [origin], opts.radiusMiles);
  const rows = await db
    .select()
    .from(pois)
    .where(
      and(
        eq(pois.category, need.poiCategory),
        gte(pois.lat, bbox[0]),
        lte(pois.lat, bbox[2]),
        gte(pois.lng, bbox[1]),
        lte(pois.lng, bbox[3]),
      ),
    )
    .limit(MAX_SCANNED);

  const marks = await db.select().from(poiMarks).where(eq(poiMarks.tripId, opts.trip.id));
  const rejected = new Set(marks.filter((m) => m.mark === "rejected").map((m) => m.poiId));
  const pinned = new Set(marks.filter((m) => m.mark === "pinned").map((m) => m.poiId));
  const plannedPoiIds = new Set(legs.map((l) => l.poiId).filter((id): id is number => id !== null));

  let options: NeedFacilityOption[] = [];
  for (const p of rows) {
    // A rejected place never reappears in suggestions for this trip (POI-4).
    if (rejected.has(p.id)) continue;
    const at = { lat: p.lat, lng: p.lng };
    const milesFromHere = haversineMiles(origin, at);
    const milesFromRoute = hasRoute ? pointToLineMiles(at, geometry) : null;
    const nearest = Math.min(milesFromHere, milesFromRoute ?? Number.POSITIVE_INFINITY);
    if (nearest > opts.radiusMiles) continue;
    options.push({
      poiId: p.id,
      name: p.name,
      category: p.category,
      lat: p.lat,
      lng: p.lng,
      source: p.source,
      url: p.url,
      popularity: p.popularity,
      milesFromHere: Math.round(milesFromHere * 10) / 10,
      milesFromRoute: milesFromRoute === null ? null : Math.round(milesFromRoute * 10) / 10,
      detourMinutes: hasRoute ? Math.round(estimatedDetour(points, at)) : null,
      pinned: pinned.has(p.id),
      plannedToday: plannedPoiIds.has(p.id),
    });
  }

  const byDetour = (a: NeedFacilityOption, b: NeedFacilityOption): number =>
    (a.detourMinutes ?? Number.POSITIVE_INFINITY) - (b.detourMinutes ?? Number.POSITIVE_INFINITY) ||
    a.poiId - b.poiId;
  const byDistance = (a: NeedFacilityOption, b: NeedFacilityOption): number =>
    a.milesFromHere - b.milesFromHere || a.poiId - b.poiId;

  if (!hasRoute) {
    options.sort(byDistance);
    return {
      ...base,
      candidateId: null,
      detourSource: "none",
      message: "No route picked for today yet — showing places near your current position.",
      options: options.slice(0, opts.limit),
    };
  }

  options.sort(byDetour);
  options = options.slice(0, opts.limit);

  // Refine the shortlist with real drive times: one matrix beats N routes, and
  // this is the call the matrix endpoint was kept around for.
  try {
    const coords = [...points, ...options.map((o) => ({ lat: o.lat, lng: o.lng }))];
    const table = await osrmTable(coords);
    const d = table.durations;
    for (const [i, option] of options.entries()) {
      const f = points.length + i;
      let best = Number.POSITIVE_INFINITY;
      for (let j = 0; j < points.length - 1; j++) {
        const detour = (d[j]?.[f] ?? 0) + (d[f]?.[j + 1] ?? 0) - (d[j]?.[j + 1] ?? 0);
        if (detour < best) best = detour;
      }
      if (Number.isFinite(best)) option.detourMinutes = Math.round(Math.max(0, best));
    }
    options.sort(byDetour);
    return {
      ...base,
      candidateId: candidate!.id,
      detourSource: "routed",
      message: null,
      options,
    };
  } catch (err) {
    if (!(err instanceof OsrmUnavailableError)) throw err;
    // Degrade visibly rather than going blank: the estimates still rank.
    return {
      ...base,
      candidateId: candidate!.id,
      detourSource: "estimated",
      message:
        "Route computation unavailable — added-time figures are straight-line estimates, not routed drive times.",
      options,
    };
  }
}
