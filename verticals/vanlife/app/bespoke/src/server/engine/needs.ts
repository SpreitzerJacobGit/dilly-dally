import { and, asc, desc, eq, gte, type Db } from "@elements/storage-sqlite-drizzle";
import { evaluateThreshold } from "@elements/processing-threshold-rules";
import { users } from "@elements/identity-session-auth";
import { checkIns, needRates, needs, progressEvents } from "../../db/schema.js";

/**
 * The consumption model. A need's level is NEVER stored — it is derived at
 * read time from the check-in log, the rate history, the driving log, and the
 * clock, so the log and the level cannot disagree. (This follows the
 * derive-don't-store discipline of processing/derived-aggregates; its
 * signed-SUM expression is not reusable here because the drain term is
 * continuous in elapsed time and recorded miles, which no SUM over rows can
 * express.)
 *
 * Everything is normalized to RUNWAY — units of headroom left before the need
 * runs dry (depleting needs) or overflows (accumulating ones). Rates consume
 * runway in both directions, which makes projection, deadlines, and threshold
 * evaluation identical for "water is getting empty" and "trash is getting
 * full".
 */

export interface NeedRow {
  id: number;
  key: string;
  title: string;
  unit: string;
  capacity: number;
  direction: string;
  warnRatio: number;
  urgentRatio: number;
  poiCategory: string | null;
  routingDriver: boolean;
  sortOrder: number;
  active: boolean;
}

export interface CheckInEvent {
  kind: string; // "service" | "set-level"
  quantity: number | null;
  occurredAt: string;
}

export interface RateInfo {
  ratePerDay: number;
  ratePerMile: number;
  source: string;
}

export type NeedUrgency = "ok" | "warn" | "urgent";

export interface NeedState {
  need: NeedRow;
  rate: RateInfo;
  /** Natural level (water gallons remaining; trash bags accumulated). */
  level: number;
  /** Headroom before dry/overflow, in the need's units. */
  runway: number;
  runwayRatio: number;
  urgency: NeedUrgency;
  asOf: string;
  lastCheckInAt: string | null;
  /** When runway hits the urgent floor if we just sit still; null when rate is 0. */
  deadlineAt: string | null;
  suggestion: RateSuggestion | null;
}

export interface RateSuggestion {
  ratePerDay: number;
  ratePerMile: number;
  samples: number;
  currentPerDay: number;
  currentPerMile: number;
}

const MS_PER_DAY = 86_400_000;

/**
 * Pure runway derivation from an event log. `milesBetween(fromIso, toIso)`
 * supplies recorded driving miles in a window (0 for day-driven needs).
 * Events must be sorted ascending by occurredAt.
 */
export function deriveRunway(
  need: Pick<NeedRow, "capacity" | "direction">,
  events: CheckInEvent[],
  rate: { ratePerDay: number; ratePerMile: number },
  nowIso: string,
  milesBetween: (fromIso: string, toIso: string) => number,
): { level: number; runway: number; anchorAt: string | null } {
  // Find the latest absolute anchor: a set-level, or a full-reset service.
  let anchorIdx = -1;
  let anchorRunway = need.capacity; // trip-start assumption: everything full/empty
  let anchorAt: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "set-level" && e.quantity !== null) {
      anchorRunway = levelToRunway(need, e.quantity);
      anchorIdx = i;
      anchorAt = e.occurredAt;
      break;
    }
    if (e.kind === "service" && e.quantity === null) {
      anchorRunway = need.capacity;
      anchorIdx = i;
      anchorAt = e.occurredAt;
      break;
    }
  }

  const from = anchorAt ?? events[0]?.occurredAt ?? nowIso;
  let runway = anchorRunway;
  // Partial services after the anchor restore runway.
  for (let i = anchorIdx + 1; i < events.length; i++) {
    const e = events[i]!;
    if (e.kind === "service" && e.quantity !== null) runway += e.quantity;
  }
  const days = Math.max(0, (Date.parse(nowIso) - Date.parse(from)) / MS_PER_DAY);
  const miles = milesBetween(from, nowIso);
  runway -= rate.ratePerDay * days + rate.ratePerMile * miles;
  runway = Math.min(need.capacity, Math.max(0, runway));
  return { level: runwayToLevel(need, runway), runway, anchorAt };
}

export function runwayToLevel(need: Pick<NeedRow, "capacity" | "direction">, runway: number): number {
  return need.direction === "accumulates" ? need.capacity - runway : runway;
}

export function levelToRunway(need: Pick<NeedRow, "capacity" | "direction">, level: number): number {
  return need.direction === "accumulates" ? need.capacity - level : level;
}

/**
 * Urgency from runway via the shared threshold element: "low" against the
 * warn floor is warn; at or below the urgent floor is urgent.
 */
export function runwayUrgency(
  need: Pick<NeedRow, "capacity" | "warnRatio" | "urgentRatio">,
  runway: number,
): NeedUrgency {
  if (runway <= need.capacity * need.urgentRatio) return "urgent";
  const state = evaluateThreshold({ level: runway, threshold: need.capacity * need.warnRatio });
  return state.status === "ok" ? "ok" : "warn";
}

/** Projected runway after `etaMinutes` of elapsed time and `miles` of driving. */
export function projectRunway(
  runway: number,
  rate: { ratePerDay: number; ratePerMile: number },
  etaMinutes: number,
  miles: number,
): number {
  return runway - rate.ratePerDay * (etaMinutes / 1440) - rate.ratePerMile * miles;
}

/** Wall-clock instant the runway reaches the urgent floor, if it ever does. */
export function wallClockDeadline(
  need: Pick<NeedRow, "capacity" | "urgentRatio">,
  runway: number,
  ratePerDay: number,
  nowIso: string,
): string | null {
  if (ratePerDay <= 0) return null;
  const floor = need.capacity * need.urgentRatio;
  const days = Math.max(0, (runway - floor) / ratePerDay);
  return new Date(Date.parse(nowIso) + days * MS_PER_DAY).toISOString();
}

/**
 * Miles-along-route at which projected runway crosses the given floor, from a
 * cumulative (etaMinutes, cumMiles) table. Null when it never crosses.
 */
export function deadlineMilesAlongRoute(
  runway: number,
  rate: { ratePerDay: number; ratePerMile: number },
  floor: number,
  table: { etaMinutes: number; cumMiles: number }[],
): number | null {
  let prev = { etaMinutes: 0, cumMiles: 0 };
  let prevRunway = runway;
  for (const point of table) {
    const projected = projectRunway(runway, rate, point.etaMinutes, point.cumMiles);
    if (projected <= floor) {
      const span = prevRunway - projected;
      const t = span > 0 ? (prevRunway - floor) / span : 0;
      return prev.cumMiles + (point.cumMiles - prev.cumMiles) * Math.min(1, Math.max(0, t));
    }
    prev = point;
    prevRunway = projected;
  }
  return null;
}

/**
 * Rate refinement from pairs of consecutive full-reset services: each pair
 * consumed a full capacity (plus partials in between) over its (days, miles)
 * gap. The rate is attributed to the need's dominant driver — miles for gas,
 * days for everything else — and the suggestion is the median of the last 8
 * samples, offered only once 3 samples exist and it moves the rate by >15%.
 * Suggestions NEVER apply themselves.
 */
export function rateSuggestionFromHistory(
  need: Pick<NeedRow, "key" | "capacity">,
  events: CheckInEvent[],
  current: { ratePerDay: number; ratePerMile: number },
  milesBetween: (fromIso: string, toIso: string) => number,
): RateSuggestion | null {
  const resets = events.filter((e) => e.kind === "service" && e.quantity === null);
  const mileDriven = need.key === "gas";
  const samples: number[] = [];
  for (let i = 1; i < resets.length; i++) {
    const from = resets[i - 1]!.occurredAt;
    const to = resets[i]!.occurredAt;
    const partials = events
      .filter((e) => e.kind === "service" && e.quantity !== null && e.occurredAt > from && e.occurredAt < to)
      .reduce((sum, e) => sum + (e.quantity ?? 0), 0);
    const consumed = need.capacity + partials;
    const denom = mileDriven
      ? milesBetween(from, to)
      : (Date.parse(to) - Date.parse(from)) / MS_PER_DAY;
    if (denom > 0.05) samples.push(consumed / denom);
  }
  const recent = samples.slice(-8).sort((a, b) => a - b);
  if (recent.length < 3) return null;
  const median = recent[Math.floor(recent.length / 2)]!;
  const currentValue = mileDriven ? current.ratePerMile : current.ratePerDay;
  if (currentValue > 0 && Math.abs(median - currentValue) / currentValue < 0.15) return null;
  return {
    ratePerDay: mileDriven ? current.ratePerDay : median,
    ratePerMile: mileDriven ? median : current.ratePerMile,
    samples: recent.length,
    currentPerDay: current.ratePerDay,
    currentPerMile: current.ratePerMile,
  };
}

/** Load full need states — the one query path every reader shares. */
export async function loadNeedStates(
  db: Db,
  tripId: number | null,
  nowIso: string,
): Promise<NeedState[]> {
  const needRows = (await db
    .select()
    .from(needs)
    .where(eq(needs.active, true))
    .orderBy(asc(needs.sortOrder))) as NeedRow[];

  const allEvents = await db
    .select({
      needId: checkIns.needId,
      kind: checkIns.kind,
      quantity: checkIns.quantity,
      occurredAt: checkIns.occurredAt,
    })
    .from(checkIns)
    .orderBy(asc(checkIns.occurredAt));

  // Tie-break on id so "the latest rate" is stable when two rows share an
  // effectiveFrom instant (ROUTE-5 determinism).
  const rateRows = await db.select().from(needRates).orderBy(asc(needRates.effectiveFrom), asc(needRates.id));

  const driving =
    tripId === null
      ? []
      : await db
          .select({ occurredAt: progressEvents.occurredAt, miles: progressEvents.milesDriven })
          .from(progressEvents)
          .where(and(eq(progressEvents.tripId, tripId), gte(progressEvents.milesDriven, 0)))
          .orderBy(asc(progressEvents.occurredAt));
  const milesBetween = (fromIso: string, toIso: string): number =>
    driving
      .filter((d) => d.occurredAt > fromIso && d.occurredAt <= toIso)
      .reduce((sum, d) => sum + d.miles, 0);

  return needRows.map((need) => {
    const events: CheckInEvent[] = allEvents.filter((e) => e.needId === need.id);
    const latestRate = rateRows.filter((r) => r.needId === need.id).at(-1);
    const rate: RateInfo = {
      ratePerDay: latestRate?.ratePerDay ?? 0,
      ratePerMile: latestRate?.ratePerMile ?? 0,
      source: latestRate?.source ?? "manual",
    };
    const { level, runway } = deriveRunway(need, events, rate, nowIso, milesBetween);
    return {
      need,
      rate,
      level: round2(level),
      runway: round2(runway),
      runwayRatio: need.capacity > 0 ? round2(runway / need.capacity) : 0,
      urgency: runwayUrgency(need, runway),
      asOf: nowIso,
      lastCheckInAt: events.at(-1)?.occurredAt ?? null,
      deadlineAt: wallClockDeadline(need, runway, rate.ratePerDay, nowIso),
      suggestion: rateSuggestionFromHistory(need, events, rate, milesBetween),
    };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Newest-first history rows for a need's screen, with who recorded each. */
export async function checkInHistory(db: Db, needId: number, limit: number) {
  return db
    .select({
      id: checkIns.id,
      kind: checkIns.kind,
      quantity: checkIns.quantity,
      note: checkIns.note,
      occurredAt: checkIns.occurredAt,
      recordedByEmail: users.email,
    })
    .from(checkIns)
    .innerJoin(users, eq(checkIns.recordedBy, users.id))
    .where(eq(checkIns.needId, needId))
    .orderBy(desc(checkIns.occurredAt), desc(checkIns.id))
    .limit(limit);
}
