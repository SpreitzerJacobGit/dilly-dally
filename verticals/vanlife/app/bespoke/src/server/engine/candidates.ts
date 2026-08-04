import { createHash } from "node:crypto";
import { z } from "zod";
import { and, asc, count, desc, eq, inArray, type Db } from "@elements/storage-sqlite-drizzle";
import { deleteSetting, getSetting, setSetting } from "@elements/lifecycle-app-settings";
import {
  checkIns,
  daySelections,
  interestWeights,
  needRates,
  needs,
  poiMarks,
  pois,
  progressEvents,
  routeCandidates,
  routeLegs,
  stayAvailability,
  stayOptions,
  stayPlans,
  staySites,
  stayWeights,
  trips,
  waypoints,
} from "../../db/schema.js";
import { FULL_LEVEL } from "../../shared/levels.js";
import {
  detourEstimateMinutes,
  haversineMiles,
  pointAlongLine,
  withinMilesOfAny,
  type LatLng,
} from "./geo.js";
import { osrmRoute, type OsrmRoute } from "./osrm.js";
import {
  deadlineMilesAlongRoute,
  loadNeedStates,
  projectRunway,
  type NeedState,
} from "./needs.js";
import {
  anchorPoiPools,
  corridorPois,
  sightAffinity,
  type CorridorPoi,
  type CorridorPois,
} from "./pois.js";
import {
  capChain,
  flattenPendingAnchors,
  loadAnchorTree,
  resolveAnchorChain,
  type AnchorNode,
  type ResolvedAnchor,
} from "./anchors.js";
import {
  CLUSTER_BONUS,
  CLUSTER_RADIUS_MILES,
  CLUSTER_TIE_MINUTES,
  STICKY_BONUS,
} from "./scoring.js";
import {
  DEFAULT_MAX_STAY_DETOUR_MINUTES,
  PURPOSE_BY_STAY_KIND,
  chosenStay,
  evaluateStays,
  loadStayCandidates,
  loadStayWeights,
  noStayExplanation,
  staySettings,
  type EvaluatedStay,
} from "./stays.js";

/**
 * The tour engine: 3–5 day-leg candidates per day, from most-direct to
 * side-quest tier, every one verified against the router and honest about the
 * deviation budget and the needs it does or does not cover.
 *
 * Determinism: no randomness anywhere, all sorts tie-break on id, and "now"
 * is quantized to the hour before it feeds any projection — regenerating
 * without a new check-in, selection, or position change reproduces the same
 * candidates (ROUTE-5).
 *
 * Insertion ranking uses great-circle detour estimates; every emitted
 * candidate is then verified with a real routed drive and repaired (drop the
 * weakest side-quest, re-verify, at most twice) if the estimate lied. The
 * matrix endpoint stays available in osrm.ts if estimate quality ever needs
 * upgrading.
 */

export interface CandidateWarning {
  severity: "urgent" | "info";
  needKey?: string;
  message: string;
}

interface StopDraft {
  name: string;
  lat: number;
  lng: number;
  poiId: number | null;
  waypointId: number | null;
  needId: number | null;
  purpose: string;
  dwellMinutes: number;
  score: number;
}

export interface BuiltCandidate {
  tier: string;
  title: string;
  summary: string;
  score: number;
  durationMinutes: number;
  distanceMiles: number;
  remainingBudgetMinutes: number;
  geometry: string;
  projectedGeometry: string | null;
  warnings: CandidateWarning[];
  stops: (StopDraft & { etaMinutesFromStart: number; cumMiles: number })[];
  /**
   * Every stay this candidate weighed, winner and runners-up and ruled-out
   * alike. Persisted so a weight slider re-ranks them without routing, and so a
   * site that turns out to be full has its alternatives already to hand.
   */
  stayOptions: EvaluatedStay[];
}

const ROLES: { tier: string; detourFraction: number; label: string }[] = [
  { tier: "direct", detourFraction: 0.05, label: "Straight shot" },
  { tier: "balanced", detourFraction: 0.2, label: "Balanced" },
  { tier: "scenic", detourFraction: 0.4, label: "Scenic" },
  { tier: "side-quest", detourFraction: 0.6, label: "Side quest" },
];
const MAX_ROLE = { tier: "max", detourFraction: 0.8, label: "Full dilly-dally" };

const DWELL_BY_PURPOSE: Record<string, number> = {
  fuel: 15,
  water: 15,
  dump: 20,
  laundry: 90,
  resupply: 45,
  charge: 45,
  sight: 60,
  // The night's stay ends the leg, so its dwell is the night itself — not a
  // duration the day's drive budget has to carry.
  camp: 0,
  lodging: 0,
  park: 0,
  family: 120,
  drive: 0,
};

const PURPOSE_BY_CATEGORY: Record<string, string> = {
  fuel: "fuel",
  "water-fill": "water",
  "dump-station": "dump",
  laundry: "laundry",
  grocery: "resupply",
  "ev-charge": "charge",
  campground: "camp",
  dispersed: "camp",
  lodging: "lodging",
  parking: "park",
  family: "family",
  hike: "sight",
  boulder: "sight",
  bike: "sight",
  scenic: "sight",
  restroom: "drive",
  other: "sight",
};

const MAX_STOPS = 6;
const VERIFY_TOLERANCE = 1.15;

/**
 * What arriving at an anchor actually is. Previously every waypoint arrival was
 * labelled "family" regardless of its kind, which mislabelled the stop and gave
 * it a 120-minute dwell it had not earned.
 */
function anchorPurpose(anchor: AnchorNode | null, resolved: ResolvedAnchor | null): string {
  if (!anchor) return "drive";
  if (anchor.kind === "family") return "family";
  if (resolved?.via === "poi") return "sight";
  return anchor.radiusMiles > 0 ? "drive" : "sight";
}

export function hourQuantized(nowIso: string): string {
  const d = new Date(nowIso);
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

export function planDateOf(nowIso: string): string {
  return nowIso.slice(0, 10);
}

export interface TripRow {
  id: number;
  originName: string;
  originLat: number;
  originLng: number;
  destName: string;
  destLat: number;
  destLng: number;
  directDurationMinutes: number | null;
  deviationBudgetRatio: number;
  dailyDriveHours: number;
}

export async function currentPosition(db: Db, trip: TripRow): Promise<LatLng & { label: string }> {
  const latest = await db
    .select()
    .from(progressEvents)
    .where(eq(progressEvents.tripId, trip.id))
    .orderBy(desc(progressEvents.occurredAt), desc(progressEvents.id))
    .limit(1);
  const e = latest[0];
  if (e) return { lat: e.lat, lng: e.lng, label: "last recorded position" };
  return { lat: trip.originLat, lng: trip.originLng, label: trip.originName };
}

/** The frozen 1x baseline; computed once, on demand, then persisted. */
export async function ensureBaseline(db: Db, trip: TripRow): Promise<number> {
  if (trip.directDurationMinutes !== null) return trip.directDurationMinutes;
  const route = await osrmRoute(
    [
      { lat: trip.originLat, lng: trip.originLng },
      { lat: trip.destLat, lng: trip.destLng },
    ],
    { overview: "false" },
  );
  await db
    .update(trips)
    .set({ directDurationMinutes: route.durationMinutes, updatedAt: new Date().toISOString() })
    .where(eq(trips.id, trip.id));
  return route.durationMinutes;
}

export async function budgetUsage(db: Db, trip: TripRow) {
  const baseline = trip.directDurationMinutes;
  const events = await db
    .select({ driveSeconds: progressEvents.driveSeconds })
    .from(progressEvents)
    .where(eq(progressEvents.tripId, trip.id));
  const spentMinutes = events.reduce((sum, e) => sum + e.driveSeconds / 60, 0);
  const budgetMinutes = baseline === null ? null : baseline * trip.deviationBudgetRatio;
  return {
    baselineMinutes: baseline,
    budgetMinutes,
    spentMinutes: Math.round(spentMinutes),
    remainingMinutes: budgetMinutes === null ? null : Math.round(budgetMinutes - spentMinutes),
  };
}

/**
 * How many hours we intend to drive on one particular day.
 *
 * The trip's `dailyDriveHours` is the pace; this is the override for a single
 * date, because "today I feel like driving eight hours" is a statement about
 * today and not a change of plan. It is stored per trip and date rather than on
 * the trip so tomorrow reverts on its own, and it is deliberately read by the
 * day-leg builder ONLY — Target ETAs stay paced off the trip value, or one long
 * day would silently re-label every horizon down the line.
 */
export const DriveHoursSchema = z.object({ hours: z.number().min(1).max(12) });

const driveHoursKey = (tripId: number, planDate: string): string =>
  `drive-hours:${String(tripId)}:${planDate}`;

export interface DayDriveHours {
  /** What the day-leg builder should actually use. */
  effective: number;
  /** The override, or null when the day is running at the trip's pace. */
  override: number | null;
  tripHours: number;
}

export async function dayDriveHours(db: Db, trip: TripRow, planDate: string): Promise<DayDriveHours> {
  const rec = await getSetting(db, driveHoursKey(trip.id, planDate), DriveHoursSchema);
  const override = rec?.value.hours ?? null;
  return { effective: override ?? trip.dailyDriveHours, override, tripHours: trip.dailyDriveHours };
}

/** Set the day's override, or clear it with null to fall back to the trip's pace. */
export async function setDayDriveHours(
  db: Db,
  tripId: number,
  planDate: string,
  hours: number | null,
  updatedBy: string | null = null,
): Promise<void> {
  const key = driveHoursKey(tripId, planDate);
  if (hours === null) {
    await deleteSetting(db, key);
    return;
  }
  await setSetting(db, key, DriveHoursSchema, { hours }, updatedBy);
}

interface BuildContext {
  db: Db;
  trip: TripRow;
  nowIso: string;
  position: LatLng;
  needStates: NeedState[];
  pool: CorridorPois;
  stickyPoiIds: Set<number>;
  /**
   * Where today's leg aims: the first resolved anchor, or the destination when
   * none are pending. Named "steer" rather than "target" because the operator's
   * Targets are the whole ordered list — this is only the next one.
   */
  steer: { lat: number; lng: number; name: string; waypointId: number | null };
  chain: LatLng[];
  /** The full anchor forest, for naming and honesty warnings. */
  anchorTree: AnchorNode[];
  /** The leaf-most pending anchors, in routing order. */
  chainAnchors: AnchorNode[];
  /** Their resolved pass-through points, index-aligned with chainAnchors. */
  resolved: ResolvedAnchor[];
  /** Middle anchors dropped from the projected continuation to bound the OSRM URL. */
  droppedChainPoints: number;
  /** Per service place, how much sightseeing sits within CLUSTER_RADIUS_MILES. */
  clusterAffinity: Map<number, number>;
  remainingBudgetMinutes: number;
  /** The date the night belongs to — what availability and bookings are keyed on. */
  planDate: string;
  stayWeights: Map<string, number>;
  maxStayDetourMinutes: number;
}

async function loadContext(db: Db, trip: TripRow, nowIso: string): Promise<BuildContext> {
  const position = await currentPosition(db, trip);
  const baseline = await ensureBaseline(db, trip);
  const usage = await budgetUsage(db, { ...trip, directDurationMinutes: baseline });
  const needStates = await loadNeedStates(db, trip.id, nowIso);

  const stayWeightMap = await loadStayWeights(db, trip.id);
  const { maxDetourMinutes } = await staySettings(db);

  const serviceCategories = [
    ...new Set([
      "campground",
      ...needStates
        .filter((s) => s.need.routingDriver && s.need.poiCategory && s.rate.ratePerDay + s.rate.ratePerMile > 0)
        .map((s) => s.need.poiCategory!),
    ]),
  ];

  // Anchors: each pending region resolves to the one concrete coordinate the
  // router needs. Resolution is computed here and never written back — see the
  // header of engine/anchors.ts for why that matters to ROUTE-5.
  const anchorTree = await loadAnchorTree(db, trip.id);
  const chainAnchors = flattenPendingAnchors(anchorTree);
  const dest = { lat: trip.destLat, lng: trip.destLng };
  const anchorPools = await anchorPoiPools(db, {
    tripId: trip.id,
    anchors: chainAnchors.map((a) => ({ id: a.id, center: a.center, radiusMiles: a.radiusMiles })),
    serviceCategories,
  });
  const resolved = resolveAnchorChain(chainAnchors, position, dest, anchorPools);

  const first = resolved[0];
  const steer = first
    ? { lat: first.point.lat, lng: first.point.lng, name: first.name, waypointId: first.anchorId }
    : { ...dest, name: trip.destName, waypointId: null };
  const capped = capChain(resolved.slice(1));
  const chain: LatLng[] = [...capped.kept.map((r) => r.point), dest];
  const pool = await corridorPois(db, {
    tripId: trip.id,
    position,
    dest,
    budgetMinutes: usage.remainingMinutes ?? baseline * trip.deviationBudgetRatio,
    serviceCategories,
  });

  // Sticky: yesterday's selected candidate's unvisited stops get a bonus so
  // today's plan evolves from yesterday's instead of rebuilding from scratch.
  const stickyPoiIds = new Set<number>();
  const yesterday = planDateOf(new Date(Date.parse(nowIso) - 86_400_000).toISOString());
  const sel = await db
    .select()
    .from(daySelections)
    .where(and(eq(daySelections.tripId, trip.id), eq(daySelections.planDate, yesterday)));
  if (sel[0]) {
    const legs = await db.select().from(routeLegs).where(eq(routeLegs.candidateId, sel[0].candidateId));
    const visited = await db
      .select({ stopSeq: progressEvents.stopSeq })
      .from(progressEvents)
      .where(and(eq(progressEvents.tripId, trip.id), eq(progressEvents.kind, "stop-visited")));
    const visitedSeqs = new Set(visited.map((v) => v.stopSeq));
    for (const leg of legs) {
      if (leg.poiId !== null && !visitedSeqs.has(leg.orderIndex)) stickyPoiIds.add(leg.poiId);
    }
  }

  // Route-through-needs: how much sightseeing sits beside each service place,
  // computed once and shared by every role. Both pools are already sorted, so
  // this is a pure function of the corridor (ROUTE-5).
  const clusterAffinity = new Map<number, number>();
  for (const [, list] of pool.byCategory) {
    for (const p of list) {
      if (clusterAffinity.has(p.id)) continue;
      clusterAffinity.set(
        p.id,
        sightAffinity({ lat: p.lat, lng: p.lng }, pool.sideQuests, CLUSTER_RADIUS_MILES),
      );
    }
  }

  return {
    db,
    trip,
    nowIso,
    position,
    needStates,
    pool,
    stickyPoiIds,
    steer,
    chain,
    anchorTree,
    chainAnchors,
    resolved,
    droppedChainPoints: capped.dropped,
    clusterAffinity,
    remainingBudgetMinutes: usage.remainingMinutes ?? 0,
    planDate: planDateOf(nowIso),
    stayWeights: stayWeightMap,
    maxStayDetourMinutes: maxDetourMinutes,
  };
}

function cumulativeTable(
  route: OsrmRoute,
  stops: StopDraft[],
): { etaMinutesFromStart: number; cumMiles: number }[] {
  const out: { etaMinutesFromStart: number; cumMiles: number }[] = [];
  let eta = 0;
  let miles = 0;
  for (let i = 0; i < route.legs.length; i++) {
    eta += route.legs[i]!.durationMinutes;
    miles += route.legs[i]!.distanceMiles;
    out.push({ etaMinutesFromStart: Math.round(eta), cumMiles: Math.round(miles * 10) / 10 });
    eta += stops[i]?.dwellMinutes ?? 0;
  }
  return out;
}

function bestInsertion(
  stops: StopDraft[],
  start: LatLng,
  end: LatLng,
  p: LatLng,
): { index: number; detourMinutes: number } {
  let best = { index: 0, detourMinutes: Number.POSITIVE_INFINITY };
  const points: LatLng[] = [start, ...stops.map((s) => ({ lat: s.lat, lng: s.lng })), end];
  for (let i = 0; i < points.length - 1; i++) {
    const detour = detourEstimateMinutes(points[i]!, p, points[i + 1]!);
    if (detour < best.detourMinutes) best = { index: i, detourMinutes: detour };
  }
  return best;
}

async function buildRole(
  ctx: BuildContext,
  role: { tier: string; detourFraction: number; label: string },
  skeleton: OsrmRoute,
): Promise<BuiltCandidate | null> {
  const dayMinutes = ctx.trip.dailyDriveHours * 60;
  const progressMinutes = (1 - role.detourFraction) * dayMinutes;
  const warnings: CandidateWarning[] = [];
  const arrivesToday = skeleton.durationMinutes <= progressMinutes;

  // How far the day reaches with nothing chosen yet. This is a comparison
  // baseline, not a place: where we actually sleep is decided further down,
  // AFTER the day's stops are placed, because those stops move where the day
  // ends — sometimes by an hour. Picking the bed against a shape we had not
  // built yet was the old order, and it was backwards.
  const firstAnchor = ctx.chainAnchors[0] ?? null;
  const firstResolved = ctx.resolved[0] ?? null;
  let arrival: StopDraft | null = null;
  let idealEnd: LatLng;
  if (arrivesToday) {
    arrival = {
      // Say which concrete place an area resolved to, and admit when nothing
      // was known inside it — a bare region name would hide both.
      name:
        firstResolved?.via === "poi" && firstResolved.poiName
          ? `${firstResolved.poiName} (${ctx.steer.name})`
          : firstResolved?.via === "geometric"
            ? `${ctx.steer.name} (nearest point)`
            : ctx.steer.name,
      lat: ctx.steer.lat,
      lng: ctx.steer.lng,
      poiId: firstResolved?.poiId ?? null,
      waypointId: ctx.steer.waypointId,
      needId: null,
      purpose: anchorPurpose(firstAnchor, firstResolved),
      dwellMinutes: 0,
      score: 0,
    };
    idealEnd = { lat: ctx.steer.lat, lng: ctx.steer.lng };
    if (firstResolved?.via === "geometric" && (firstAnchor?.radiusMiles ?? 0) > 0) {
      warnings.push({
        severity: "info",
        message: `No known place inside "${ctx.steer.name}" — routing through the nearest point of the area.`,
      });
    }
  } else {
    idealEnd = pointAlongLine(skeleton.geometry, progressMinutes / skeleton.durationMinutes);
  }
  const endPoint = idealEnd;

  const stops: StopDraft[] = [];

  // Need stops first — constraints before treats. Deadlines are projected
  // over TODAY'S leg only (the day's drive to E), never the whole remaining
  // trip: a need that survives today is tomorrow's planning problem.
  const dayEstMinutes = Math.min(skeleton.durationMinutes, progressMinutes);
  const dayEstMiles =
    skeleton.durationMinutes > 0
      ? skeleton.distanceMiles * (dayEstMinutes / skeleton.durationMinutes)
      : 0;
  const dayTable = [{ etaMinutes: dayEstMinutes, cumMiles: dayEstMiles }];
  // A service stop may not cost more than the role's detour appetite (plus a
  // floor so the direct role can still make an essential stop).
  const needDetourCap = Math.max(90, role.detourFraction * dayMinutes * 1.5);
  for (const state of ctx.needStates) {
    const { need, rate } = state;
    if (!need.routingDriver || !need.poiCategory || rate.ratePerDay + rate.ratePerMile <= 0) continue;
    const warnFloor = FULL_LEVEL * need.warnRatio;
    const crossesToday = deadlineMilesAlongRoute(state.runway, rate, warnFloor, dayTable) !== null;
    const urgentSoon =
      state.deadlineAt !== null && Date.parse(state.deadlineAt) < Date.parse(ctx.nowIso) + 36 * 3_600_000;
    if (!crossesToday && !urgentSoon) continue;

    // Route-through-needs, direction 1: among the places that service this
    // need at near-equal cost, prefer the one with the most sightseeing next
    // door. Feasibility is still decided by the cheapest place in the whole
    // pool, and the near-tie band is clamped to the cap — so this can never
    // drop a service stop or spend a minute more than before (ROUTE-2).
    const pool = ctx.pool.byCategory.get(need.poiCategory) ?? [];
    const options = pool.map((poi) => {
      const ins = bestInsertion(stops, ctx.position, endPoint, { lat: poi.lat, lng: poi.lng });
      return { poi, index: ins.index, detourMinutes: ins.detourMinutes };
    });
    const minDetour = options.reduce(
      (m, o) => Math.min(m, o.detourMinutes),
      Number.POSITIVE_INFINITY,
    );
    if (options.length === 0 || minDetour > needDetourCap) {
      warnings.push({
        severity: urgentSoon || state.urgency === "urgent" ? "urgent" : "info",
        needKey: need.key,
        message:
          pool.length === 0
            ? `No known ${need.poiCategory} stop in the corridor can service "${need.title}".`
            : `No ${need.poiCategory} stop is reachable within today's plan for "${need.title}" (closest adds ${String(Math.round(minDetour))} min).`,
      });
      continue;
    }
    const band = Math.min(CLUSTER_TIE_MINUTES, needDetourCap - minDetour);
    const affinityOf = (poi: CorridorPoi): number => ctx.clusterAffinity.get(poi.id) ?? 0;
    let bestStop: { poi: CorridorPoi; index: number; detourMinutes: number } | null = null;
    for (const o of options) {
      if (o.detourMinutes > minDetour + band) continue;
      if (
        !bestStop ||
        affinityOf(o.poi) > affinityOf(bestStop.poi) ||
        (affinityOf(o.poi) === affinityOf(bestStop.poi) && o.detourMinutes < bestStop.detourMinutes)
      ) {
        bestStop = o;
      }
    }
    if (!bestStop) continue;
    const purpose = PURPOSE_BY_CATEGORY[need.poiCategory] ?? "resupply";
    stops.splice(bestStop.index, 0, {
      name: bestStop.poi.name,
      lat: bestStop.poi.lat,
      lng: bestStop.poi.lng,
      poiId: bestStop.poi.id,
      waypointId: null,
      needId: need.id,
      purpose,
      dwellMinutes: DWELL_BY_PURPOSE[purpose] ?? 30,
      score: 0,
    });
  }

  // Route-through-needs, direction 2: the stops we are already committed to
  // making. A sight beside one of them is the same errand — including beside
  // tonight's campground, since that is where the evening is spent anyway.
  // Where the evening is spent is still an anchor for this, but tonight's stay
  // is not chosen yet — so the day's reach stands in for it. That is the same
  // neighbourhood the stay will be picked from, and unlike the stay itself it is
  // known before the greedy fill runs.
  const clusterAnchors: LatLng[] = [
    ...stops.filter((s) => s.needId !== null).map((s) => ({ lat: s.lat, lng: s.lng })),
    idealEnd,
  ];

  // Side-quest greedy fill, by value density inside the role's detour budget.
  let detourBudget = role.detourFraction * dayMinutes;
  const used = new Set(stops.map((s) => s.poiId).filter((id): id is number => id !== null));
  if (arrival?.poiId != null) used.add(arrival.poiId);
  const pinnedFirst = [
    ...ctx.pool.pinned.filter((p) => !used.has(p.id)),
    ...ctx.pool.sideQuests.filter((p) => !p.pinned && !used.has(p.id)),
  ];
  for (;;) {
    if (stops.length >= MAX_STOPS) break;
    let best: { poi: CorridorPoi; index: number; cost: number; value: number } | null = null;
    for (const poi of pinnedFirst) {
      if (used.has(poi.id)) continue;
      const ins = bestInsertion(stops, ctx.position, endPoint, { lat: poi.lat, lng: poi.lng });
      const dwell = DWELL_BY_PURPOSE[PURPOSE_BY_CATEGORY[poi.category] ?? "sight"] ?? 60;
      const cost = ins.detourMinutes + dwell;
      if (ins.detourMinutes > detourBudget) continue;
      const sticky = ctx.stickyPoiIds.has(poi.id) ? STICKY_BONUS : 1;
      // Reorders preference inside the detour budget; never enlarges it.
      const cluster = withinMilesOfAny(
        { lat: poi.lat, lng: poi.lng },
        clusterAnchors,
        CLUSTER_RADIUS_MILES,
      )
        ? CLUSTER_BONUS
        : 1;
      const value = poi.pinned
        ? Number.POSITIVE_INFINITY
        : (poi.score * sticky * cluster) / Math.max(cost, 5);
      if (!best || value > best.value || (value === best.value && poi.id < best.poi.id)) {
        best = { poi, index: ins.index, cost, value };
      }
    }
    if (!best || (best.value !== Number.POSITIVE_INFINITY && best.value <= 0)) break;
    const purpose = PURPOSE_BY_CATEGORY[best.poi.category] ?? "sight";
    stops.splice(best.index, 0, {
      name: best.poi.name,
      lat: best.poi.lat,
      lng: best.poi.lng,
      poiId: best.poi.id,
      waypointId: null,
      needId: null,
      purpose,
      dwellMinutes: DWELL_BY_PURPOSE[purpose] ?? 60,
      score: best.poi.score,
    });
    used.add(best.poi.id);
    detourBudget -= best.poi.pinned ? 0 : best.cost;
  }

  // Verify with the real router; repair by dropping the weakest side-quest.
  const allowed = dayMinutes * VERIFY_TOLERANCE;
  let route: OsrmRoute | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const coords = [ctx.position, ...stops.map((s) => ({ lat: s.lat, lng: s.lng })), endPoint];
    route = await osrmRoute(coords, { overview: "full" });
    if (route.durationMinutes <= allowed) break;
    const droppable = stops
      .map((s, i) => ({ s, i }))
      .filter((x) => x.s.needId === null && x.s.poiId !== null && !ctx.pool.pinned.some((p) => p.id === x.s.poiId));
    const weakest = droppable.sort((a, b) => a.s.score - b.s.score || a.i - b.i)[0];
    if (!weakest) break;
    stops.splice(weakest.i, 1);
    route = null;
  }
  if (!route) {
    const coords = [ctx.position, ...stops.map((s) => ({ lat: s.lat, lng: s.lng })), endPoint];
    route = await osrmRoute(coords, { overview: "full" });
  }

  // ---- The night ------------------------------------------------------------
  // Now that the day has a shape, choose where it ends. The cost of a stay is
  // measured against carrying on to `idealEnd` and resuming toward the chain
  // tomorrow — not as an out-and-back detour, because tomorrow starts from
  // wherever we slept. A stay further along the route can therefore cost less
  // than nothing.
  const nextPoint = ctx.chain[0] ?? idealEnd;
  const lastStop = stops[stops.length - 1];
  const lastPoint: LatLng = arrivesToday
    ? idealEnd
    : lastStop
      ? { lat: lastStop.lat, lng: lastStop.lng }
      : ctx.position;
  const dwellSoFar = stops.reduce((sum, s) => sum + s.dwellMinutes, 0);
  const minutesToLastPoint = arrivesToday
    ? route.durationMinutes + dwellSoFar
    : stops.reduce((sum, s, i) => sum + (route!.legs[i]?.durationMinutes ?? 0) + s.dwellMinutes, 0);

  const stayCandidates = await loadStayCandidates(ctx.db, {
    tripId: ctx.trip.id,
    planDate: ctx.planDate,
    near: idealEnd,
  });
  const rankedStays =
    stayCandidates.length === 0
      ? []
      : await evaluateStays({
          candidates: stayCandidates,
          lastPoint,
          nextPoint,
          departureIso: ctx.nowIso,
          minutesToLastPoint,
          weights: ctx.stayWeights,
          maxDetourMinutes: ctx.maxStayDetourMinutes,
          needStates: ctx.needStates,
          sideQuests: ctx.pool.sideQuests,
        });
  const stay = chosenStay(rankedStays);

  const tail: StopDraft[] = [];
  if (arrival) tail.push(arrival);
  if (stay) {
    // A place cannot be both a stop along the way and the place we sleep; when
    // the greedy fill already picked it, it becomes the endpoint instead of
    // appearing twice in the same day.
    const dupIdx = stops.findIndex((s) => s.poiId === stay.poiId);
    if (dupIdx >= 0) stops.splice(dupIdx, 1);
    tail.push({
      name: stay.name,
      lat: stay.lat,
      lng: stay.lng,
      poiId: stay.poiId,
      waypointId: null,
      needId: null,
      purpose: PURPOSE_BY_STAY_KIND[stay.stayKind],
      dwellMinutes: 0,
      score: 0,
    });
  } else {
    warnings.push({ severity: "urgent", message: noStayExplanation(rankedStays) });
    if (!arrival) {
      // The leg still has to end at a coordinate, but that coordinate is not a
      // place and must never read as one. The old "End of day's drive" was a
      // point on a road wearing the name of a destination — the one thing this
      // application otherwise never does.
      tail.push({
        name: "Day's drive runs out here — no stay found",
        lat: idealEnd.lat,
        lng: idealEnd.lng,
        poiId: null,
        waypointId: null,
        needId: null,
        purpose: "drive",
        dwellMinutes: 0,
        score: 0,
      });
    }
  }

  const finalEnd = tail[tail.length - 1]!;
  const finalPoint: LatLng = { lat: finalEnd.lat, lng: finalEnd.lng };
  // Re-route only when the night actually moved the leg — an arrival-day with no
  // stay ends exactly where we already routed to.
  const finalCoords = [
    ctx.position,
    ...stops.map((s) => ({ lat: s.lat, lng: s.lng })),
    ...tail.map((s) => ({ lat: s.lat, lng: s.lng })),
  ];
  const routedCoords = [ctx.position, ...stops.map((s) => ({ lat: s.lat, lng: s.lng })), endPoint];
  if (JSON.stringify(finalCoords) !== JSON.stringify(routedCoords)) {
    route = await osrmRoute(finalCoords, { overview: "full" });
  }

  // Continuation to the anchor through the remaining chain, from where we slept.
  const continuation = await osrmRoute([finalPoint, ...ctx.chain], { overview: "simplified" });

  // Global budget honesty.
  const remainingAfter = ctx.remainingBudgetMinutes - route.durationMinutes - continuation.durationMinutes;
  if (remainingAfter < 0) {
    if (role.tier !== "direct") return null;
    warnings.push({
      severity: "urgent",
      message: "Over budget: even the direct plan exceeds the remaining deviation budget.",
    });
  }

  // Post-verify need honesty against the routed timeline.
  const allStops = [...stops, ...tail];
  const table = cumulativeTable(route, allStops);
  for (const state of ctx.needStates) {
    const { need, rate } = state;
    if (!need.routingDriver || rate.ratePerDay + rate.ratePerMile <= 0) continue;
    const serviceIdx = allStops.findIndex((s) => s.needId === need.id);
    const horizon = serviceIdx >= 0 ? table[serviceIdx]! : table[table.length - 1]!;
    const projected = projectRunway(state.runway, rate, horizon.etaMinutesFromStart, horizon.cumMiles);
    if (projected <= 0) {
      warnings.push({
        severity: "urgent",
        needKey: need.key,
        message:
          serviceIdx >= 0
            ? `"${need.title}" is projected to run out before reaching its planned stop.`
            : `"${need.title}" is projected to run out along this route with no planned stop.`,
      });
    }
  }

  const sights = allStops.filter((s) => s.purpose === "sight" || s.purpose === "family");
  const headline = sights.sort((a, b) => b.score - a.score)[0]?.name;
  // "Direct" means most PROGRESS, not fewest minutes: a side-quest day drives
  // fewer miles toward the anchor while spending the same hours. Saying how
  // far from the anchor each candidate ends makes the spectrum legible.
  const finalDest = ctx.chain[ctx.chain.length - 1]!;
  const endsToGo = Math.round(haversineMiles(finalPoint, finalDest));
  const summaryBits = [
    `${(route.durationMinutes / 60).toFixed(1)}h drive`,
    `${String(Math.round(route.distanceMiles))} mi`,
    `${String(allStops.length)} stops`,
    ...(arrivesToday ? [`arrives at ${ctx.steer.name}`] : []),
    stay ? `overnight at ${stay.name}` : "nowhere to stay found",
    `ends ${String(endsToGo)} mi from ${ctx.trip.destName}`,
  ];

  return {
    tier: role.tier,
    title: headline ? `${role.label} — ${headline}` : role.label,
    summary: summaryBits.join(" · "),
    score: Math.round(allStops.reduce((sum, s) => sum + s.score, 0) * 100) / 100,
    durationMinutes: Math.round(route.durationMinutes),
    distanceMiles: Math.round(route.distanceMiles * 10) / 10,
    remainingBudgetMinutes: Math.round(remainingAfter),
    geometry: JSON.stringify({ type: "LineString", coordinates: route.geometry }),
    projectedGeometry: JSON.stringify({ type: "LineString", coordinates: continuation.geometry }),
    warnings,
    stops: allStops.map((s, i) => ({ ...s, ...table[i]! })),
    stayOptions: rankedStays,
  };
}

/** Build, dedupe, and return the day's candidates (not yet persisted). */
export async function buildDailyCandidates(
  db: Db,
  trip: TripRow,
  nowIso: string,
): Promise<BuiltCandidate[]> {
  const quantized = hourQuantized(nowIso);
  // The day's override, if one is set, is the pace for this build alone — every
  // caller (today, replan, the digest) comes through here, so this is the only
  // place it has to be applied.
  const pace = await dayDriveHours(db, trip, planDateOf(nowIso));
  const ctx = await loadContext(db, { ...trip, dailyDriveHours: pace.effective }, quantized);
  const skeleton = await osrmRoute([ctx.position, { lat: ctx.steer.lat, lng: ctx.steer.lng }], {
    overview: "full",
  });

  const roles = [...ROLES];
  const directNow = skeleton.durationMinutes;
  if (ctx.remainingBudgetMinutes > 1.5 * directNow) roles.push(MAX_ROLE);

  const built: BuiltCandidate[] = [];
  for (const role of roles) {
    const candidate = await buildRole(ctx, role, skeleton);
    if (candidate) built.push(candidate);
  }
  // Dedupe genuinely identical plans (identical stop sequences AND endpoints —
  // raw end-of-day points at different coordinates are different plans).
  const seen = new Set<string>();
  return built.filter((c) => {
    const sig = c.stops
      .map((s) => `${String(s.poiId)}:${s.name}:${s.lat.toFixed(2)},${s.lng.toFixed(2)}`)
      .join("|");
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

const PlanFingerprintSchema = z.object({ hash: z.string() });

/**
 * Bump by hand whenever a change to this engine should reach plans that were
 * already built. It is an input to the plan-state fingerprint, so bumping it
 * makes the next replan rebuild once instead of serving the older engine's
 * work forever.
 */
const ENGINE_REVISION = "2026-08-04-stays";

const fingerprintKey = (tripId: number, planDate: string): string =>
  `plan-fingerprint:${String(tripId)}:${planDate}`;

/**
 * ROUTE-5: a digest of every input the candidate builder reads — trip config,
 * waypoints, needs and rates, the check-in and driving logs, selections, POI
 * marks, interest weights, and the POI catalog — everything EXCEPT the clock.
 * A replan whose current fingerprint matches the persisted build's must serve
 * that build untouched; wall time alone never reshuffles the candidates.
 */
export async function planStateFingerprint(
  db: Db,
  tripId: number,
  planDate?: string,
): Promise<string> {
  const trip = (await db.select().from(trips).where(eq(trips.id, tripId)))[0];
  const wps = await db
    .select()
    .from(waypoints)
    .where(eq(waypoints.tripId, tripId))
    .orderBy(asc(waypoints.id));
  const needRows = await db.select().from(needs).orderBy(asc(needs.id));
  const weights = await db.select().from(interestWeights).orderBy(asc(interestWeights.category));
  const marks = await db
    .select({ poiId: poiMarks.poiId, mark: poiMarks.mark })
    .from(poiMarks)
    .where(eq(poiMarks.tripId, tripId))
    .orderBy(asc(poiMarks.poiId));
  const selections = await db
    .select({ planDate: daySelections.planDate, candidateId: daySelections.candidateId })
    .from(daySelections)
    .where(eq(daySelections.tripId, tripId))
    .orderBy(asc(daySelections.planDate));
  // Append-mostly logs and the (large) POI catalog fingerprint as counts plus
  // high-water marks — a new row, an undo, or a poller refresh all move one.
  const checkinLast = (await db.select({ id: checkIns.id }).from(checkIns).orderBy(desc(checkIns.id)).limit(1))[0];
  const checkinCount = (await db.select({ n: count() }).from(checkIns))[0];
  const progressLast = (
    await db
      .select({ id: progressEvents.id })
      .from(progressEvents)
      .where(eq(progressEvents.tripId, tripId))
      .orderBy(desc(progressEvents.id))
      .limit(1)
  )[0];
  const progressCount = (
    await db.select({ n: count() }).from(progressEvents).where(eq(progressEvents.tripId, tripId))
  )[0];
  const rateLast = (await db.select({ id: needRates.id }).from(needRates).orderBy(desc(needRates.id)).limit(1))[0];
  const poiLast = (await db.select({ id: pois.id }).from(pois).orderBy(desc(pois.id)).limit(1))[0];
  const poiTouched = (
    await db.select({ updatedAt: pois.updatedAt }).from(pois).orderBy(desc(pois.updatedAt)).limit(1)
  )[0];
  const poiCount = (await db.select({ n: count() }).from(pois))[0];
  // The day's drive-hours override is an input to the build but lives outside
  // the trip row, so it has to reach the hash by hand — otherwise setting it
  // would leave the fingerprint unmoved and replan would keep serving the plan
  // built at the old pace.
  const dayOverride =
    planDate === undefined
      ? null
      : ((await getSetting(db, driveHoursKey(tripId, planDate), DriveHoursSchema))?.value.hours ?? null);

  // Where the night gets chosen from. The weights and the detour cap are read
  // straight through, because moving a slider must replan.
  const stayWeightRows = await db
    .select({ factor: stayWeights.factor, weight: stayWeights.weight })
    .from(stayWeights)
    .where(eq(stayWeights.tripId, tripId))
    .orderBy(asc(stayWeights.factor));
  const stayDetourCap = (await staySettings(db)).maxDetourMinutes;
  const stayPlanRows = await db
    .select({ planDate: stayPlans.planDate, poiId: stayPlans.poiId, state: stayPlans.state })
    .from(stayPlans)
    .where(eq(stayPlans.tripId, tripId))
    .orderBy(asc(stayPlans.planDate));
  const siteTouched = (
    await db.select({ updatedAt: staySites.updatedAt }).from(staySites).orderBy(desc(staySites.updatedAt)).limit(1)
  )[0];
  const siteCount = (await db.select({ n: count() }).from(staySites))[0];
  // updatedAt, deliberately, and never fetchedAt: the availability job bumps
  // fetchedAt on every check and updatedAt only when the answer actually
  // changed. Hashing fetchedAt here would replan an unchanged day on every poll.
  const availTouched = (
    await db
      .select({ updatedAt: stayAvailability.updatedAt })
      .from(stayAvailability)
      .orderBy(desc(stayAvailability.updatedAt))
      .limit(1)
  )[0];
  const availCount = (await db.select({ n: count() }).from(stayAvailability))[0];

  const state = {
    // The fingerprint hashes state, not code — so a deployed engine change
    // would otherwise keep serving the plan built by the previous engine until
    // some unrelated row moved. Bumping this by hand replans exactly once. A
    // constant is still constant, so ROUTE-5 determinism is untouched.
    engine: ENGINE_REVISION,
    trip: trip ? { ...trip, createdAt: undefined, updatedAt: undefined } : null,
    dayDriveHours: dayOverride,
    // The spread is load-bearing: every anchor column — radius, parent, depth,
    // order, pin — must reach the hash so editing an anchor actually replans.
    // It is also why auto-resolution is never written back to this row; that
    // would move the fingerprint as a consequence of building and replan forever.
    waypoints: wps.map((w) => ({ ...w, createdAt: undefined })),
    needs: needRows,
    weights: weights.map((w) => ({ category: w.category, weight: w.weight })),
    marks,
    selections,
    checkins: { last: checkinLast?.id ?? 0, n: checkinCount?.n ?? 0 },
    progress: { last: progressLast?.id ?? 0, n: progressCount?.n ?? 0 },
    rates: rateLast?.id ?? 0,
    pois: { last: poiLast?.id ?? 0, touched: poiTouched?.updatedAt ?? "", n: poiCount?.n ?? 0 },
    stayWeights: stayWeightRows,
    stayDetourCap,
    stayPlans: stayPlanRows,
    staySites: { touched: siteTouched?.updatedAt ?? "", n: siteCount?.n ?? 0 },
    stayAvailability: { touched: availTouched?.updatedAt ?? "", n: availCount?.n ?? 0 },
  };
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

export async function storedPlanFingerprint(
  db: Db,
  tripId: number,
  planDate: string,
): Promise<string | null> {
  const rec = await getSetting(db, fingerprintKey(tripId, planDate), PlanFingerprintSchema);
  return rec?.value.hash ?? null;
}

/** Persist a build for a date: expire prior proposals, keep any selection. */
export async function persistCandidates(
  db: Db,
  tripId: number,
  planDate: string,
  built: BuiltCandidate[],
): Promise<void> {
  const existing = await db
    .select()
    .from(routeCandidates)
    .where(and(eq(routeCandidates.tripId, tripId), eq(routeCandidates.planDate, planDate)));
  const proposedIds = existing.filter((c) => c.status === "proposed").map((c) => c.id);
  if (proposedIds.length > 0) {
    await db
      .update(routeCandidates)
      .set({ status: "expired" })
      .where(inArray(routeCandidates.id, proposedIds));
  }
  const now = new Date().toISOString();
  for (const c of built) {
    const inserted = await db
      .insert(routeCandidates)
      .values({
        tripId,
        planDate,
        tier: c.tier,
        title: c.title,
        summary: c.summary,
        score: c.score,
        durationMinutes: c.durationMinutes,
        distanceMiles: c.distanceMiles,
        remainingBudgetMinutes: c.remainingBudgetMinutes,
        geometry: c.geometry,
        projectedGeometry: c.projectedGeometry,
        warnings: JSON.stringify(c.warnings),
        status: "proposed",
        generatedAt: now,
      })
      .returning({ id: routeCandidates.id });
    const candidateId = inserted[0]!.id;
    for (let i = 0; i < c.stops.length; i++) {
      const s = c.stops[i]!;
      await db.insert(routeLegs).values({
        candidateId,
        orderIndex: i,
        toName: s.name,
        toLat: s.lat,
        toLng: s.lng,
        poiId: s.poiId,
        waypointId: s.waypointId,
        needId: s.needId,
        purpose: s.purpose,
        etaMinutesFromStart: s.etaMinutesFromStart,
        cumMiles: s.cumMiles,
        dwellMinutes: s.dwellMinutes,
      });
    }
    // Every stay this candidate weighed, in rank order — including the ones it
    // ruled out and why. This is what lets a weight slider re-rank tonight
    // without touching the router, and what puts the runners-up on screen when
    // the first choice turns out to be full.
    for (let i = 0; i < c.stayOptions.length; i++) {
      const s = c.stayOptions[i]!;
      await db.insert(stayOptions).values({
        candidateId,
        poiId: s.poiId,
        stayKind: s.stayKind,
        marginalMinutes: s.marginalMinutes,
        toStayMinutes: s.toStayMinutes,
        fromStayMinutes: s.fromStayMinutes,
        toStayMiles: s.toStayMiles,
        arrivalIso: s.arrivalIso,
        sunsetIso: s.sunsetIso,
        factors: JSON.stringify(s.factors),
        score: s.score,
        excludedReason: s.excludedReason,
        orderIndex: i,
      });
    }
  }
  // Record the state this build was derived from, so a replan with no state
  // change can serve it back verbatim instead of regenerating (ROUTE-5).
  await setSetting(
    db,
    fingerprintKey(tripId, planDate),
    PlanFingerprintSchema,
    { hash: await planStateFingerprint(db, tripId, planDate) },
    null,
  );
}
