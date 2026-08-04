import { z } from "zod";
import { and, asc, eq, gte, inArray, lte, type Db } from "@elements/storage-sqlite-drizzle";
import { getSetting } from "@elements/lifecycle-app-settings";
import { poiMarks, pois, stayAvailability, staySites, stayPlans, stayWeights } from "../../db/schema.js";
import { discBbox, haversineMiles, type LatLng } from "./geo.js";
import { osrmTable } from "./osrm.js";
import { arrivesAfterDark, sunsetAt } from "./sun.js";
import { legalityAt, signalAt } from "./hexLookup.js";
import { sightAffinity, type CorridorPoi } from "./pois.js";
import type { NeedState } from "./needs.js";
import { FULL_LEVEL } from "../../shared/levels.js";

/**
 * Choosing where the night is spent.
 *
 * Before this, a day-leg ended at whichever campground happened to be nearest a
 * point on the highway, or — when there wasn't one — at a fabricated stop called
 * "End of day's drive", which is a coordinate on a road wearing the name of a
 * place. This module replaces both with a real choice between four kinds of
 * stay, scored against the needs that are actually running down.
 *
 * Two things here are deliberately unlike the rest of the stop machinery:
 *
 * 1. A stay's cost is NOT an out-and-back detour. Tomorrow resumes from wherever
 *    we slept, so sleeping 20 minutes off-corridor costs 20 minutes and sleeping
 *    20 minutes further along the route costs nothing at all — `marginalMinutes`
 *    is routinely negative. Running a stay through bestInsertion() would double
 *    every cost and bias the planner into stopping short every night.
 *
 * 2. Evaluation and ranking are split. Evaluating means routing, and routing is
 *    slow; ranking is a weighted sum. So every evaluated stay is persisted with
 *    its routed costs and its per-factor scores, and moving a weight slider
 *    re-ranks the stored rows with no router call at all. It also means the
 *    runners-up are already on screen when tonight's first choice turns out to
 *    be full, gated, or posted — which matters more for a bed at 7pm than it
 *    does for any other kind of stop.
 */

export const STAY_KINDS = ["campground", "dispersed", "lodging", "parking"] as const;
export type StayKind = (typeof STAY_KINDS)[number];

const STAY_KIND_SET = new Set<string>(STAY_KINDS);

/** Stay kinds are POI categories too, so the catalog, map and legend get them free. */
export function isStayCategory(category: string): category is StayKind {
  return STAY_KIND_SET.has(category);
}

/** Which stop purpose a kind produces. Dispersed camping is still camping. */
export const PURPOSE_BY_STAY_KIND: Record<StayKind, string> = {
  campground: "camp",
  dispersed: "camp",
  lodging: "lodging",
  parking: "park",
};

export const STAY_FACTORS = [
  "needs",
  "proximity",
  "signal",
  "legality",
  "cost",
  "sights",
  "freshness",
] as const;
export type StayFactor = (typeof STAY_FACTORS)[number];

export const STAY_KIND_WEIGHT_KEYS = STAY_KINDS.map((k) => `kind-${k}`);
export const STAY_WEIGHT_KEYS: string[] = [...STAY_KIND_WEIGHT_KEYS, ...STAY_FACTORS];

/**
 * Where the sliders start.
 *
 * Cost sits low on purpose: the operators asked to see what a night costs
 * without it steering the plan, so cost is always displayed and only nudges the
 * ranking if they raise it. Lodging and parking start below the two camping
 * kinds because this is a van, not a road trip between hotels.
 */
export const DEFAULT_STAY_WEIGHTS: Record<string, number> = {
  "kind-campground": 1,
  "kind-dispersed": 1,
  "kind-lodging": 0.5,
  "kind-parking": 0.4,
  needs: 1.5,
  proximity: 1,
  signal: 1,
  legality: 1,
  cost: 0.3,
  sights: 0.5,
  freshness: 0.5,
};

/** Above this a night is "expensive" for scoring; cost is never a hard filter. */
const COST_CEILING_USD = 150;

/** A user report older than this carries no freshness credit left. */
const STALE_REPORT_DAYS = 730;

/** How far from the day's reach we bother looking for a bed. */
export const STAY_SEARCH_RADIUS_MILES = 45;

/** Shortlist cap. The matrix endpoint is configured for 8000, so this is cheap. */
export const STAY_SHORTLIST = 40;

export const DEFAULT_MAX_STAY_DETOUR_MINUTES = 30;

/**
 * The one stay knob that is a limit rather than a preference, so it lives in
 * settings rather than in the weights table. It has its own key rather than
 * joining engine/trips.ts's planning settings because trips.ts already imports
 * from candidates.ts, and candidates.ts needs to read this.
 */
export const STAY_SETTINGS_KEY = "stays";
export const StaySettingsSchema = z.object({
  maxDetourMinutes: z.number().min(0).max(240).default(DEFAULT_MAX_STAY_DETOUR_MINUTES),
});

export async function staySettings(db: Db): Promise<{ maxDetourMinutes: number }> {
  const rec = await getSetting(db, STAY_SETTINGS_KEY, StaySettingsSchema);
  return { maxDetourMinutes: rec?.value.maxDetourMinutes ?? DEFAULT_MAX_STAY_DETOUR_MINUTES };
}

/**
 * Arriving after dark is a hard filter only where darkness actually changes the
 * problem: finding an unmarked pullout, or judging whether a lot is somewhere
 * you want to be. A campground with a host and a lit hotel forecourt are ordinary
 * night arrivals, so for those two kinds a late arrival scores lower instead of
 * being ruled out.
 */
const DARK_ARRIVAL_IS_FATAL = new Set<string>(["dispersed", "parking"]);

export interface StaySiteFacts {
  stayKind: StayKind;
  nightlyCostUsd: number | null;
  hookupElectric: boolean;
  hookupWater: boolean;
  dumpStation: boolean;
  showers: boolean;
  laundryOnSite: boolean;
  reservable: string;
  access: string;
  maxNights: number | null;
  lastReportedAt: string | null;
  confidence: string;
}

export interface StayCandidate {
  poi: CorridorPoi;
  site: StaySiteFacts;
  availability: { state: string; source: string; fetchedAt: string; detail: string | null } | null;
  /** An operator has committed to this one for the date — it wins outright. */
  booked: boolean;
}

export interface EvaluatedStay {
  poiId: number;
  name: string;
  lat: number;
  lng: number;
  stayKind: StayKind;
  toStayMinutes: number;
  fromStayMinutes: number;
  toStayMiles: number;
  marginalMinutes: number;
  arrivalIso: string | null;
  sunsetIso: string | null;
  factors: Record<string, number>;
  score: number;
  /** Null means it survived every filter; set names the filter that ruled it out. */
  excludedReason: string | null;
  nightlyCostUsd: number | null;
  availability: StayCandidate["availability"];
  booked: boolean;
}

/** Missing rows mean "never touched", so defaults apply rather than zeroes. */
export async function loadStayWeights(db: Db, tripId: number): Promise<Map<string, number>> {
  const rows = await db
    .select()
    .from(stayWeights)
    .where(eq(stayWeights.tripId, tripId))
    .orderBy(asc(stayWeights.factor));
  const out = new Map<string, number>(Object.entries(DEFAULT_STAY_WEIGHTS));
  for (const r of rows) out.set(r.factor, r.weight);
  return out;
}

/**
 * Stay candidates near the day's reach: the same two-phase shape as the rest of
 * engine/pois.ts — SQL bbox prefilter, then a geometric refine in JS — joined to
 * the stay facts and to anything already known about tonight.
 */
export async function loadStayCandidates(
  db: Db,
  opts: {
    tripId: number;
    planDate: string;
    near: LatLng;
    radiusMiles?: number;
    limit?: number;
  },
): Promise<StayCandidate[]> {
  const radiusMiles = opts.radiusMiles ?? STAY_SEARCH_RADIUS_MILES;
  const limit = opts.limit ?? STAY_SHORTLIST;
  const bbox = discBbox(opts.near, radiusMiles);

  const marks = await db.select().from(poiMarks).where(eq(poiMarks.tripId, opts.tripId));
  const rejected = new Set(marks.filter((m) => m.mark === "rejected").map((m) => m.poiId));
  const pinnedIds = new Set(marks.filter((m) => m.mark === "pinned").map((m) => m.poiId));

  const rows = await db
    .select({ poi: pois, site: staySites })
    .from(staySites)
    .innerJoin(pois, eq(pois.id, staySites.poiId))
    .where(
      and(
        gte(pois.lat, bbox[0]),
        lte(pois.lat, bbox[2]),
        gte(pois.lng, bbox[1]),
        lte(pois.lng, bbox[3]),
        inArray(pois.category, [...STAY_KINDS]),
      ),
    );

  const near = rows
    .filter((r) => !rejected.has(r.poi.id))
    .map((r) => ({ ...r, miles: haversineMiles(opts.near, { lat: r.poi.lat, lng: r.poi.lng }) }))
    .filter((r) => r.miles <= radiusMiles)
    // Distance, then id — never the database's scan order (ROUTE-5).
    .sort((a, b) => a.miles - b.miles || a.poi.id - b.poi.id)
    .slice(0, limit);

  if (near.length === 0) return [];

  const poiIds = near.map((r) => r.poi.id);
  const availability = await db
    .select()
    .from(stayAvailability)
    .where(and(inArray(stayAvailability.poiId, poiIds), eq(stayAvailability.forDate, opts.planDate)));
  const availByPoi = new Map(availability.map((a) => [a.poiId, a]));

  const booked = await db
    .select()
    .from(stayPlans)
    .where(and(eq(stayPlans.tripId, opts.tripId), eq(stayPlans.planDate, opts.planDate)));
  const bookedPoiId = booked.find((b) => b.state === "booked" || b.state === "confirmed")?.poiId ?? null;

  return near.map((r) => {
    const a = availByPoi.get(r.poi.id);
    return {
      poi: {
        id: r.poi.id,
        name: r.poi.name,
        category: r.poi.category,
        lat: r.poi.lat,
        lng: r.poi.lng,
        source: r.poi.source,
        url: r.poi.url,
        popularity: r.poi.popularity,
        score: 0,
        pinned: pinnedIds.has(r.poi.id),
      },
      site: {
        stayKind: (isStayCategory(r.site.stayKind) ? r.site.stayKind : "campground") as StayKind,
        nightlyCostUsd: r.site.nightlyCostUsd,
        hookupElectric: r.site.hookupElectric,
        hookupWater: r.site.hookupWater,
        dumpStation: r.site.dumpStation,
        showers: r.site.showers,
        laundryOnSite: r.site.laundryOnSite,
        reservable: r.site.reservable,
        access: r.site.access,
        maxNights: r.site.maxNights,
        lastReportedAt: r.site.lastReportedAt,
        confidence: r.site.confidence,
      },
      availability: a ? { state: a.state, source: a.source, fetchedAt: a.fetchedAt, detail: a.detail } : null,
      booked: bookedPoiId === r.poi.id,
    };
  });
}

/** Which tracked need each amenity services, by the need's own poiCategory. */
function servicedCategories(site: StaySiteFacts): Set<string> {
  const out = new Set<string>();
  if (site.hookupElectric) out.add("ev-charge");
  if (site.hookupWater) out.add("water-fill");
  if (site.dumpStation) out.add("dump-station");
  if (site.laundryOnSite) out.add("laundry");
  return out;
}

/**
 * How much of tonight's need pressure this stay actually relieves, 0–1.
 *
 * Pressure is (1 − runway ratio), so a need at 10% counts nine times what a need
 * at 90% does, and the denominator is the pressure across every routing need —
 * a stay that clears the two things about to run out scores near 1 even if it
 * offers nothing else.
 */
export function needsRelief(site: StaySiteFacts, needStates: NeedState[]): number {
  const serviced = servicedCategories(site);
  let relieved = 0;
  let total = 0;
  for (const s of needStates) {
    if (!s.need.routingDriver || !s.need.poiCategory) continue;
    if (s.rate.ratePerDay + s.rate.ratePerMile <= 0) continue;
    const pressure = Math.max(0, 1 - s.runway / FULL_LEVEL);
    total += pressure;
    if (serviced.has(s.need.poiCategory)) relieved += pressure;
  }
  if (total <= 0) return 0;
  return Math.min(1, relieved / total);
}

/**
 * Age is measured against the build's own quantized clock, never Date.now():
 * reading the wall clock here would give two builds a minute apart very slightly
 * different scores, which is exactly the reshuffle ROUTE-5 forbids.
 */
function freshnessScore(lastReportedAt: string | null, nowIso: string): number {
  if (!lastReportedAt) return 0.5; // Unknown age is neither fresh nor stale.
  const days = (Date.parse(nowIso) - Date.parse(lastReportedAt)) / 86_400_000;
  if (!Number.isFinite(days) || days < 0) return 0.5;
  return Math.max(0, 1 - days / STALE_REPORT_DAYS);
}

function costScore(nightlyCostUsd: number | null): number {
  if (nightlyCostUsd === null) return 0.5; // Unknown price is not "free".
  return Math.max(0, 1 - nightlyCostUsd / COST_CEILING_USD);
}

/**
 * Legality only asks a question of dispersed camping. A campground, a motel and
 * a signed overnight lot are places that exist to be slept in; whether BLM would
 * allow dispersed camping on that spot says nothing about them, so they score
 * neutral-high rather than being punished for a question nobody asked.
 */
function legalityScore(kind: StayKind, lat: number, lng: number): number {
  if (kind !== "dispersed") return 0.8;
  const reading = legalityAt(lat, lng);
  if (!reading.installed || reading.value === null) return 0.5; // No overlay built — say nothing.
  if (reading.blm) return 1;
  if (reading.usfs) return reading.usfsAssumedWidth ? 0.7 : 1;
  return 0.15; // Inside the built extent and neither regime indicated.
}

function signalScore(lat: number, lng: number): number {
  const reading = signalAt(lat, lng);
  if (!reading.installed || reading.value === null) return 0.5; // No grid built — say nothing.
  return Math.min(1, reading.value / 4);
}

export interface StayScoreInputs {
  needStates: NeedState[];
  sideQuests: CorridorPoi[];
  maxDetourMinutes: number;
  /** Best sight affinity seen in this shortlist, for normalizing. */
  affinityCeiling: number;
  /** The build's quantized clock — see freshnessScore. */
  nowIso: string;
}

/** Pure: the per-factor 0–1 scores for one stay. No weights applied yet. */
export function stayFactors(
  candidate: StayCandidate,
  routed: { marginalMinutes: number },
  inputs: StayScoreInputs,
): Record<StayFactor, number> {
  const { site, poi } = candidate;
  const affinity = sightAffinity({ lat: poi.lat, lng: poi.lng }, inputs.sideQuests, 10);
  return {
    needs: needsRelief(site, inputs.needStates),
    // Ahead-on-route stays get the full mark; the cap is where it reaches zero.
    proximity:
      inputs.maxDetourMinutes <= 0
        ? 1
        : Math.max(0, Math.min(1, 1 - Math.max(0, routed.marginalMinutes) / inputs.maxDetourMinutes)),
    signal: signalScore(poi.lat, poi.lng),
    legality: legalityScore(site.stayKind, poi.lat, poi.lng),
    cost: costScore(site.nightlyCostUsd),
    sights: inputs.affinityCeiling > 0 ? Math.min(1, affinity / inputs.affinityCeiling) : 0,
    freshness: freshnessScore(site.lastReportedAt, inputs.nowIso),
  };
}

/**
 * Weighted sum, normalized by the weights in play, then scaled by the kind's own
 * weight. A kind weighted to zero scores zero and is excluded outright — the same
 * semantics an interest weight of zero already has for side-quests (PROF-2).
 */
export function scoreStay(
  stayKind: StayKind,
  factors: Record<string, number>,
  weights: Map<string, number>,
): number {
  const kindWeight = weights.get(`kind-${stayKind}`) ?? DEFAULT_STAY_WEIGHTS[`kind-${stayKind}`] ?? 1;
  if (kindWeight <= 0) return 0;
  let sum = 0;
  let total = 0;
  for (const f of STAY_FACTORS) {
    const w = weights.get(f) ?? DEFAULT_STAY_WEIGHTS[f] ?? 1;
    if (w <= 0) continue;
    sum += w * (factors[f] ?? 0);
    total += w;
  }
  const base = total > 0 ? sum / total : 0;
  return Math.round(kindWeight * base * 10_000) / 10_000;
}

/**
 * Re-rank already-evaluated stays under new weights. Pure, and deliberately the
 * only thing a slider move has to run — no router, no catalog query.
 *
 * A booked stay stays on top regardless: an operator's commitment outranks the
 * scoring, and silently re-ranking past it would be the app second-guessing a
 * phone call it did not make.
 */
export function rankStays<T extends { poiId: number; stayKind: StayKind; factors: Record<string, number>; excludedReason: string | null; booked: boolean }>(
  options: T[],
  weights: Map<string, number>,
): (T & { score: number })[] {
  return options
    .map((o) => {
      const score = scoreStay(o.stayKind, o.factors, weights);
      const kindOff = score === 0 && o.excludedReason === null && !o.booked;
      return {
        ...o,
        score,
        excludedReason: kindOff ? `${o.stayKind} stays are turned off for this trip` : o.excludedReason,
      };
    })
    .sort((a, b) => {
      if (a.booked !== b.booked) return a.booked ? -1 : 1;
      const aOut = a.excludedReason !== null;
      const bOut = b.excludedReason !== null;
      if (aOut !== bOut) return aOut ? 1 : -1;
      return b.score - a.score || a.poiId - b.poiId;
    });
}

export interface EvaluateStaysOptions {
  candidates: StayCandidate[];
  /** Last committed point before the night: the final stop, or the day's start. */
  lastPoint: LatLng;
  /** Where tomorrow goes, so the resume cost is real rather than assumed. */
  nextPoint: LatLng;
  /** Wall clock at the start of the leg. */
  departureIso: string;
  /** Minutes from departure to `lastPoint`, dwell included. */
  minutesToLastPoint: number;
  weights: Map<string, number>;
  maxDetourMinutes: number;
  needStates: NeedState[];
  sideQuests: CorridorPoi[];
}

/**
 * Route the shortlist, apply the hard filters, score what survives.
 *
 * The baseline a stay is measured against is the cost of NOT detouring for the
 * night: driving straight on from the last committed stop toward tomorrow's
 * first point. So
 *
 *     marginal = (last → stay) + (stay → tomorrow) − (last → tomorrow)
 *
 * which is ~0 for a stay that sits on the way, and grows only with a real
 * sideways detour. Note what it is NOT measured against: the fabricated
 * end-of-day point. That point is only ever a place to go looking for beds, and
 * using it as the cost baseline made stays beyond it look free — an artefact of
 * a made-up coordinate, not a fact about the road.
 *
 * One matrix call covers the whole shortlist. Every excluded stay comes back
 * with the reason rather than being dropped, so the UI can say "four sites need
 * high clearance" instead of quietly showing a shorter list.
 */
export async function evaluateStays(opts: EvaluateStaysOptions): Promise<EvaluatedStay[]> {
  if (opts.candidates.length === 0) return [];

  // coords: [lastPoint, nextPoint, ...stays]
  const coords: LatLng[] = [
    opts.lastPoint,
    opts.nextPoint,
    ...opts.candidates.map((c) => ({ lat: c.poi.lat, lng: c.poi.lng })),
  ];
  const stayIdx = opts.candidates.map((_, i) => i + 2);
  const sources = [0, ...stayIdx];
  const destinations = [1, ...stayIdx];
  const table = await osrmTable(coords, { sources, destinations });

  const srcRow = new Map(sources.map((c, i) => [c, i]));
  const dstCol = new Map(destinations.map((c, i) => [c, i]));
  const dur = (from: number, to: number): number => table.durations[srcRow.get(from)!]![dstCol.get(to)!]!;
  const dist = (from: number, to: number): number => table.distances[srcRow.get(from)!]![dstCol.get(to)!]!;

  const baseline = dur(0, 1);

  const routed = opts.candidates.map((c, i) => {
    const idx = stayIdx[i]!;
    const toStayMinutes = dur(0, idx);
    const fromStayMinutes = dur(idx, 1);
    return {
      candidate: c,
      toStayMinutes,
      fromStayMinutes,
      toStayMiles: dist(0, idx),
      marginalMinutes: toStayMinutes + fromStayMinutes - baseline,
    };
  });

  // Normalizing sights across the shortlist keeps the factor meaningful in a
  // corridor with nothing to see as well as one crowded with trailheads.
  const affinityCeiling = routed.reduce(
    (m, r) =>
      Math.max(m, sightAffinity({ lat: r.candidate.poi.lat, lng: r.candidate.poi.lng }, opts.sideQuests, 10)),
    0,
  );
  const inputs: StayScoreInputs = {
    needStates: opts.needStates,
    sideQuests: opts.sideQuests,
    maxDetourMinutes: opts.maxDetourMinutes,
    affinityCeiling,
    nowIso: opts.departureIso,
  };

  const departureMs = Date.parse(opts.departureIso);
  const out: EvaluatedStay[] = [];
  for (const r of routed) {
    const { candidate } = r;
    const { site, poi } = candidate;
    const arrivalMs = departureMs + (opts.minutesToLastPoint + r.toStayMinutes) * 60_000;
    const arrivalIso = Number.isFinite(arrivalMs) ? new Date(arrivalMs).toISOString() : null;
    const sunsetIso = arrivalIso ? sunsetAt(arrivalIso, poi.lat, poi.lng) : null;

    // Hard filters, most-decisive first, each keeping its reason.
    let excludedReason: string | null = null;
    if (site.access === "high-clearance") {
      excludedReason = "the road in needs high clearance";
    } else if (r.marginalMinutes > opts.maxDetourMinutes) {
      excludedReason = `adds ${String(Math.round(r.marginalMinutes))} min off the day's route`;
    } else if (
      arrivalIso !== null &&
      DARK_ARRIVAL_IS_FATAL.has(site.stayKind) &&
      arrivesAfterDark(arrivalIso, poi.lat, poi.lng)
    ) {
      excludedReason = "we would arrive after dark";
    } else if (candidate.availability?.state === "full") {
      excludedReason = "reported full for tonight";
    } else if (candidate.availability?.state === "closed") {
      excludedReason = "reported closed";
    }

    const factors = stayFactors(candidate, r, inputs);
    out.push({
      poiId: poi.id,
      name: poi.name,
      lat: poi.lat,
      lng: poi.lng,
      stayKind: site.stayKind,
      toStayMinutes: Math.round(r.toStayMinutes),
      fromStayMinutes: Math.round(r.fromStayMinutes),
      toStayMiles: Math.round(r.toStayMiles * 10) / 10,
      marginalMinutes: Math.round(r.marginalMinutes),
      arrivalIso,
      sunsetIso,
      factors,
      score: 0,
      excludedReason,
      nightlyCostUsd: site.nightlyCostUsd,
      availability: candidate.availability,
      booked: candidate.booked,
    });
  }

  return rankStays(out, opts.weights);
}

/** The one that gets slept in: booked first, else the best that survived. */
export function chosenStay(ranked: EvaluatedStay[]): EvaluatedStay | null {
  return ranked.find((s) => s.booked) ?? ranked.find((s) => s.excludedReason === null) ?? null;
}

/**
 * Why there is no bed tonight, in the operators' words rather than a count.
 * Returning null when the shortlist was simply empty keeps "we looked and found
 * nothing" distinct from "we found places and ruled every one of them out".
 */
export function noStayExplanation(ranked: EvaluatedStay[]): string {
  if (ranked.length === 0) {
    return "No known place to stay within reach of the day's end.";
  }
  const reasons = new Map<string, number>();
  for (const s of ranked) {
    if (s.excludedReason === null) continue;
    reasons.set(s.excludedReason, (reasons.get(s.excludedReason) ?? 0) + 1);
  }
  const parts = [...reasons.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map(([reason, n]) => `${String(n)} because ${reason}`);
  return `Every place to stay near the day's end was ruled out — ${parts.join(", ")}.`;
}
