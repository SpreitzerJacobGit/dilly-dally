/**
 * Anchors: the regions a trip's route must connect.
 *
 * A waypoint with a radius stops being a pin and becomes a disc — "route me
 * through the eastern Sierra somewhere". Anchors nest, so a broad intent can be
 * narrowed without losing the broad intent: Eastern Sierra ▸ Bishop ▸ the
 * Buttermilks. Routing always uses the leaf-most pending anchor of each branch,
 * so deleting a narrowing restores the broader choice.
 *
 * Resolution — turning a disc into the one concrete coordinate OSRM needs — is
 * deliberately NEVER persisted. planStateFingerprint hashes the whole waypoint
 * row, so writing a resolved point back would move the fingerprint as a
 * consequence of building the plan, and every replan would rebuild forever
 * (ROUTE-5). Only the operator's explicit pin is stored.
 *
 * Determinism, as everywhere in this engine: no clock, no randomness, every
 * sort tie-breaks on id.
 *
 * A note on the word. The UI and the tRPC surface call these Targets, and a
 * trip is now described to the operator as an Origin plus an ordered list of
 * Targets. This module keeps "anchor" on purpose: here the word names the
 * geometric object — a disc the route is constrained to cross — rather than
 * the operator's list item. The seam between the two vocabularies is
 * engine/targets.ts, which is the only place that should have to know both.
 */

import { asc, eq, type Db } from "@elements/storage-sqlite-drizzle";
import { waypoints } from "../../db/schema.js";
import {
  bearingDegrees,
  closestPointOnSegment,
  destinationPoint,
  detourEstimateMinutes,
  haversineMiles,
  withinDisc,
  type LatLng,
} from "./geo.js";
import type { CorridorPoi } from "./pois.js";

/**
 * How far a place inside a disc may pull the route *beyond the cheapest way
 * through that disc* before we ignore it.
 *
 * Two subtleties, both learned the hard way. The budget is measured against the
 * geometric pass-through, not against skipping the region: an anchor is a hard
 * constraint, so the route is going through there regardless and the only real
 * question is what a specific place costs over just clipping the edge. And the
 * cap scales with the radius — declaring a 110-mile region is declaring you will
 * wander at that scale, whereas inside a 15-mile one an hour's detour is absurd.
 * A fixed cap rejected the best place in a broad region and silently degraded it
 * to a nameless boundary point.
 */
export function anchorDetourCapMinutes(radiusMiles: number): number {
  const ROAD_FACTOR = 1.3;
  const AVG_MPH = 45;
  const acrossRadius = ((radiusMiles * ROAD_FACTOR) / AVG_MPH) * 60;
  return Math.min(240, Math.max(30, acrossRadius));
}

/** OSRM takes coordinates in the URL; anchors are cheap to create, so cap the chain. */
export const MAX_CHAIN_POINTS = 12;

export type AnchorStatus = "pending" | "visited" | "skipped";

export interface AnchorRow {
  id: number;
  parentId: number | null;
  name: string;
  kind: string;
  lat: number;
  lng: number;
  radiusMiles: number;
  orderIndex: number;
  depth: number;
  status: string;
  pinnedLat: number | null;
  pinnedLng: number | null;
  pinnedPoiId: number | null;
  arriveBy: string | null;
}

export interface AnchorNode {
  id: number;
  parentId: number | null;
  name: string;
  kind: string;
  center: LatLng;
  radiusMiles: number;
  orderIndex: number;
  depth: number;
  status: AnchorStatus;
  pinned: LatLng | null;
  pinnedPoiId: number | null;
  arriveBy: string | null;
  children: AnchorNode[];
}

/** How an anchor's concrete pass-through point was chosen. */
export type ResolutionVia = "point" | "pinned" | "poi" | "geometric";

export interface ResolvedAnchor {
  anchorId: number;
  name: string;
  point: LatLng;
  radiusMiles: number;
  via: ResolutionVia;
  poiId: number | null;
  poiName: string | null;
  /** Estimate only, for the honesty line — the router is always authoritative. */
  detourMinutes: number;
}

const MAX_DEPTH = 4;

/** Group rows into a forest, siblings ordered by (orderIndex, id). Orphans root themselves. */
export function buildAnchorTree(rows: AnchorRow[]): AnchorNode[] {
  const byId = new Map<number, AnchorNode>();
  for (const r of rows) {
    byId.set(r.id, {
      id: r.id,
      parentId: r.parentId,
      name: r.name,
      kind: r.kind,
      center: { lat: r.lat, lng: r.lng },
      radiusMiles: r.radiusMiles,
      orderIndex: r.orderIndex,
      depth: r.depth,
      status: (r.status === "visited" || r.status === "skipped" ? r.status : "pending"),
      pinned: r.pinnedLat !== null && r.pinnedLng !== null ? { lat: r.pinnedLat, lng: r.pinnedLng } : null,
      pinnedPoiId: r.pinnedPoiId,
      arriveBy: r.arriveBy,
      children: [],
    });
  }
  const roots: AnchorNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId === null ? null : byId.get(node.parentId);
    if (parent && parent.id !== node.id) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (list: AnchorNode[], depth: number): void => {
    list.sort((a, b) => a.orderIndex - b.orderIndex || a.id - b.id);
    if (depth >= MAX_DEPTH) {
      for (const n of list) n.children = [];
      return;
    }
    for (const n of list) sort(n.children, depth + 1);
  };
  sort(roots, 0);
  return roots;
}

/**
 * The routing chain: depth-first in sibling order, emitting the leaf-most
 * pending anchor of each branch. An anchor with pending children contributes
 * those children instead of itself — that is what narrowing means. A
 * visited or skipped anchor drops out with its whole subtree.
 */
export function flattenPendingAnchors(tree: AnchorNode[]): AnchorNode[] {
  const out: AnchorNode[] = [];
  const walk = (nodes: AnchorNode[]): void => {
    for (const n of nodes) {
      if (n.status !== "pending") continue;
      const pendingKids = n.children.filter((c) => c.status === "pending");
      if (pendingKids.length > 0) walk(pendingKids);
      else out.push(n);
    }
  };
  walk(tree);
  return out;
}

/** Every pending anchor at every depth — for POI ingestion, which wants broad discs too. */
export function allPendingAnchors(tree: AnchorNode[]): AnchorNode[] {
  const out: AnchorNode[] = [];
  const walk = (nodes: AnchorNode[]): void => {
    for (const n of nodes) {
      if (n.status !== "pending") continue;
      out.push(n);
      walk(n.children);
    }
  };
  walk(tree);
  return out;
}

/**
 * One disc → one coordinate, in strict precedence:
 *   1. radius 0        → the center itself
 *   2. operator's pin  → always wins over any score
 *   3. best place      → highest value density inside the detour cap
 *   4. geometric       → the cheapest legal way through the disc
 */
export function resolveAnchor(
  anchor: AnchorNode,
  prev: LatLng,
  next: LatLng,
  pool: CorridorPoi[],
  capMinutes?: number,
): ResolvedAnchor {
  const base = { anchorId: anchor.id, name: anchor.name, radiusMiles: anchor.radiusMiles };

  if (anchor.radiusMiles <= 0) {
    return { ...base, point: anchor.center, via: "point", poiId: null, poiName: null, detourMinutes: 0 };
  }

  if (anchor.pinned) {
    return {
      ...base,
      point: anchor.pinned,
      via: "pinned",
      poiId: anchor.pinnedPoiId,
      poiName: null,
      detourMinutes: detourEstimateMinutes(prev, anchor.pinned, next),
    };
  }

  // The cheapest legal crossing, computed first because it is the baseline
  // every candidate place is judged against — we are going through this region
  // either way, so a place only has to justify what it costs *over* clipping it.
  const foot = closestPointOnSegment(prev, next, anchor.center).point;
  const geometricPoint = withinDisc(foot, anchor.center, anchor.radiusMiles)
    ? foot
    : destinationPoint(anchor.center, bearingDegrees(anchor.center, foot), anchor.radiusMiles);
  const geometricDetour = detourEstimateMinutes(prev, geometricPoint, next);

  const cap = capMinutes ?? anchorDetourCapMinutes(anchor.radiusMiles);

  // Value density, deliberately the same formula and tie-break as the
  // side-quest filler, so an anchor prefers what the day plan would prefer.
  // Places the operator pinned on the map sort ahead of everything else.
  let best: { poi: CorridorPoi; detour: number; extra: number; value: number } | null = null;
  for (const poi of pool) {
    const detour = detourEstimateMinutes(prev, { lat: poi.lat, lng: poi.lng }, next);
    const extra = Math.max(0, detour - geometricDetour);
    if (extra > cap) continue;
    const value = (poi.pinned ? Number.POSITIVE_INFINITY : poi.score) / Math.max(extra, 5);
    if (!best || value > best.value || (value === best.value && poi.id < best.poi.id)) {
      best = { poi, detour, extra, value };
    }
  }
  if (best) {
    return {
      ...base,
      point: { lat: best.poi.lat, lng: best.poi.lng },
      via: "poi",
      poiId: best.poi.id,
      poiName: best.poi.name,
      detourMinutes: best.detour,
    };
  }

  // Nothing known inside the disc, or everything too far off-path even by that
  // generous measure. Fall back to the crossing computed above.
  return {
    ...base,
    point: geometricPoint,
    via: "geometric",
    poiId: null,
    poiName: null,
    detourMinutes: geometricDetour,
  };
}

/**
 * Resolve a whole chain in one forward pass. Each anchor is resolved against
 * the previous resolved point and the *center* of the next anchor — close
 * enough, and it keeps the pass single and obviously terminating.
 */
export function resolveAnchorChain(
  anchors: AnchorNode[],
  start: LatLng,
  finalDest: LatLng,
  pools: Map<number, CorridorPoi[]>,
  capMinutes?: number,
): ResolvedAnchor[] {
  const out: ResolvedAnchor[] = [];
  let prev = start;
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!;
    const next = anchors[i + 1]?.center ?? finalDest;
    const resolved = resolveAnchor(a, prev, next, pools.get(a.id) ?? [], capMinutes);
    out.push(resolved);
    prev = resolved.point;
  }
  return out;
}

/**
 * Trim an over-long chain from the middle. The first anchors are what today's
 * leg is actually about and the last is nearest the destination, so the middle
 * is what a projected continuation can most afford to lose.
 */
export function capChain<T>(points: T[], max: number = MAX_CHAIN_POINTS): { kept: T[]; dropped: number } {
  if (points.length <= max) return { kept: points, dropped: 0 };
  const head = Math.ceil(max / 2);
  const tail = max - head;
  return { kept: [...points.slice(0, head), ...points.slice(points.length - tail)], dropped: points.length - max };
}

export type AnchorHorizon = "this-week" | "this-month" | "later";

export interface AnchorPacing {
  anchorId: number;
  etaDays: number;
  etaDate: string;
  horizon: AnchorHorizon;
  arriveBy: string | null;
  behind: boolean;
}

/**
 * Derived pacing for the anchor chain — never stored, so it can never go stale.
 * Distance is the great-circle chain at the engine's road factor; this is a
 * horizon label, not a promise, and the router remains authoritative.
 */
export function anchorHorizons(
  resolved: ResolvedAnchor[],
  anchors: AnchorNode[],
  opts: { start: LatLng; dailyDriveHours: number; now: string },
): AnchorPacing[] {
  const ROAD_FACTOR = 1.3;
  const AVG_MPH = 45;
  const dayMinutes = Math.max(1, opts.dailyDriveHours) * 60;
  const byId = new Map(anchors.map((a) => [a.id, a]));
  const startMs = Date.parse(opts.now);
  const out: AnchorPacing[] = [];
  let prev = opts.start;
  let cumMinutes = 0;
  for (const r of resolved) {
    cumMinutes += ((haversineMiles(prev, r.point) * ROAD_FACTOR) / AVG_MPH) * 60;
    prev = r.point;
    const etaDays = Math.max(1, Math.ceil(cumMinutes / dayMinutes));
    const etaMs = startMs + etaDays * 86_400_000;
    const etaDate = new Date(etaMs).toISOString().slice(0, 10);
    const arriveBy = byId.get(r.anchorId)?.arriveBy ?? null;
    out.push({
      anchorId: r.anchorId,
      etaDays,
      etaDate,
      horizon: etaDays <= 7 ? "this-week" : etaDays <= 31 ? "this-month" : "later",
      arriveBy,
      behind: arriveBy !== null && Date.parse(`${arriveBy}T00:00:00Z`) < etaMs,
    });
  }
  return out;
}

/** The only I/O in this module. */
export async function loadAnchorTree(db: Db, tripId: number): Promise<AnchorNode[]> {
  const rows = await db
    .select()
    .from(waypoints)
    .where(eq(waypoints.tripId, tripId))
    .orderBy(asc(waypoints.orderIndex), asc(waypoints.id));
  return buildAnchorTree(rows);
}

/** Siblings of a level, ordered — used by the reorder and insert-at-index paths. */
export async function loadSiblings(db: Db, tripId: number, parentId: number | null) {
  const rows = await db
    .select()
    .from(waypoints)
    .where(eq(waypoints.tripId, tripId))
    .orderBy(asc(waypoints.orderIndex), asc(waypoints.id));
  return rows.filter((r) => (r.parentId ?? null) === parentId);
}

/** Every descendant id of an anchor, for explicit subtree deletes. */
export function subtreeIds(node: AnchorNode): number[] {
  const out = [node.id];
  for (const c of node.children) out.push(...subtreeIds(c));
  return out;
}

/** Depth of the deepest node in a subtree, counting the root as 0. */
export function subtreeHeight(node: AnchorNode): number {
  return node.children.length === 0
    ? 0
    : 1 + Math.max(...node.children.map(subtreeHeight));
}

/**
 * New depths for a subtree moved to `newDepth`. Depth is denormalised so the
 * client can indent without recursive SQL, which means every move has to
 * rewrite it for the whole subtree, not just the node that moved.
 */
export function depthUpdates(node: AnchorNode, newDepth: number): { id: number; depth: number }[] {
  const out = [{ id: node.id, depth: newDepth }];
  for (const c of node.children) out.push(...depthUpdates(c, newDepth + 1));
  return out;
}

/** Walk up the parent chain — the cycle guard for reparenting. */
export function isDescendant(tree: AnchorNode[], candidateId: number, ofId: number): boolean {
  const node = findNode(tree, ofId);
  if (!node) return false;
  return subtreeIds(node).includes(candidateId);
}

export function findNode(tree: AnchorNode[], id: number): AnchorNode | null {
  for (const n of tree) {
    if (n.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return null;
}
