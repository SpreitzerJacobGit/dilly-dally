/**
 * Targets: what the operator sees.
 *
 * A trip is an Origin and an ordered list of Targets. The last Target is the
 * final destination; the ones before it are the regions and places the route
 * is required to pass through. That list is what the planning screen renders,
 * and this module is the only place that knows it is assembled from two
 * different things:
 *
 *   - the `waypoints` rows, which engine/anchors.ts calls anchors and treats
 *     as disc constraints on the route, and
 *   - the trip's own destName/destLat/destLng scalars.
 *
 * The destination deliberately stays a scalar rather than becoming a waypoint
 * row. Those columns are NOT NULL and load-bearing: the frozen deviation
 * baseline is the drive between exactly those two points, the corridor search
 * needs two ellipse foci, and the anchor chain uses the destination as its
 * direction hint. Making it deletable would turn five total functions into
 * partial ones for what is, from the operator's side, a presentational change.
 *
 * The consequence, stated rather than hidden: the final Target is always an
 * exact point. Arriving "somewhere around" a place is expressed by putting an
 * area Target immediately before it, which the chain already routes through.
 *
 * Resolution and pacing are computed per read and never stored — see
 * engine/anchors.ts for why that matters.
 */
import { circlePolygon } from "./geo.js";
import { anchorPoiPools } from "./pois.js";
import {
  anchorHorizons,
  flattenPendingAnchors,
  loadAnchorTree,
  resolveAnchorChain,
  type AnchorNode,
} from "./anchors.js";
import { loadNeedStates } from "./needs.js";

type Db = Parameters<typeof loadNeedStates>[0];

/**
 * The id of the synthesized final Target.
 *
 * It is negative because it is not a `waypoints` row and must never be passed
 * to a mutation that expects one. The map keys DOM markers by number, so a
 * sentinel is cheaper than making every id nullable.
 */
export const FINAL_TARGET_ID = -1;

export interface TargetView {
  id: number;
  parentId: number | null;
  name: string;
  kind: string;
  center: { lat: number; lng: number };
  radiusMiles: number;
  depth: number;
  orderIndex: number;
  /** 1-based position among top-level Targets; null for a nested narrowing. */
  ordinal: number | null;
  /** The trip's destination, surfaced as the last Target. Not a waypoints row. */
  final: boolean;
  status: string;
  arriveBy: string | null;
  notes: string | null;
  /** Pre-computed circle so the map never does geometry. Null for exact points. */
  ring: [number, number][] | null;
  /** Where the route actually goes through — null when a parent is superseded by its children. */
  resolved: {
    point: { lat: number; lng: number };
    via: string;
    poiId: number | null;
    poiName: string | null;
    detourMinutes: number;
  } | null;
  pinned: { lat: number; lng: number } | null;
  pacing: { etaDays: number; etaDate: string; horizon: string; behind: boolean } | null;
  children: TargetView[];
}

export interface TargetTrip {
  id: number;
  destName: string;
  destLat: number;
  destLng: number;
  dailyDriveHours: number;
}

/**
 * The Targets list: the anchor tree with resolution and pacing folded in, then
 * the trip's destination appended as the final entry.
 *
 * Assembling it here rather than in the client matters — if the two halves were
 * stitched together in the UI, "one list, one word" would be true in CSS and
 * false at the API boundary, and the next reader would have to discover that.
 */
export async function buildTargetViews(
  db: Db,
  trip: TargetTrip,
  position: { lat: number; lng: number },
  nowIso: string,
): Promise<TargetView[]> {
  const tree = await loadAnchorTree(db, trip.id);
  const chainAnchors = flattenPendingAnchors(tree);
  const dest = { lat: trip.destLat, lng: trip.destLng };
  const pools = await anchorPoiPools(db, {
    tripId: trip.id,
    anchors: chainAnchors.map((a) => ({ id: a.id, center: a.center, radiusMiles: a.radiusMiles })),
    serviceCategories: [],
  });
  const resolved = resolveAnchorChain(chainAnchors, position, dest, pools);
  const byAnchor = new Map(resolved.map((r) => [r.anchorId, r]));
  const pacing = new Map(
    anchorHorizons(resolved, chainAnchors, {
      start: position,
      dailyDriveHours: trip.dailyDriveHours,
      now: nowIso,
    }).map((p) => [p.anchorId, p]),
  );

  const toView = (n: AnchorNode, ordinal: number | null): TargetView => {
    const r = byAnchor.get(n.id) ?? null;
    const p = pacing.get(n.id) ?? null;
    return {
      id: n.id,
      parentId: n.parentId,
      name: n.name,
      kind: n.kind,
      center: n.center,
      radiusMiles: n.radiusMiles,
      depth: n.depth,
      orderIndex: n.orderIndex,
      ordinal,
      final: false,
      status: n.status,
      arriveBy: n.arriveBy,
      notes: null,
      ring: n.radiusMiles > 0 ? circlePolygon(n.center, n.radiusMiles) : null,
      resolved: r
        ? {
            point: r.point,
            via: r.via,
            poiId: r.poiId,
            poiName: r.poiName,
            detourMinutes: Math.round(r.detourMinutes),
          }
        : null,
      pinned: n.pinned,
      pacing: p ? { etaDays: p.etaDays, etaDate: p.etaDate, horizon: p.horizon, behind: p.behind } : null,
      // A narrowing is not numbered: it replaces its parent rather than being
      // another place along the way.
      children: n.children.map((c) => toView(c, null)),
    };
  };

  const views = tree.map((n, i) => toView(n, i + 1));
  return [...views, finalTargetView(trip, views.length)];
}

/** The trip's destination, shaped like every other row in the list. */
export function finalTargetView(trip: TargetTrip, precedingCount: number): TargetView {
  return {
    id: FINAL_TARGET_ID,
    parentId: null,
    name: trip.destName,
    kind: "destination",
    center: { lat: trip.destLat, lng: trip.destLng },
    radiusMiles: 0,
    depth: 0,
    orderIndex: precedingCount,
    ordinal: precedingCount + 1,
    final: true,
    status: "pending",
    arriveBy: null,
    notes: null,
    ring: null,
    // The destination is where the route ends, not something resolved along the
    // way, so it has no pass-through point and no pacing of its own.
    resolved: null,
    pinned: null,
    pacing: null,
    children: [],
  };
}
