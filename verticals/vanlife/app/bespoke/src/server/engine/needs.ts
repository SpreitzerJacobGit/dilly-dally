import { and, asc, desc, eq, gte, type Db } from "@elements/storage-sqlite-drizzle";
import { evaluateThreshold } from "@elements/processing-threshold-rules";
import { users } from "@elements/identity-session-auth";
import { checkIns, needRates, needs, progressEvents } from "../../db/schema.js";
import { FULL_LEVEL } from "../../shared/levels.js";

/**
 * The consumption model. A need's level is NEVER stored — it is derived at
 * read time from the check-in log, the rate history, the driving log, and the
 * clock, so the log and the level cannot disagree. (This follows the
 * derive-don't-store discipline of processing/derived-aggregates; its
 * signed-SUM expression is not reusable here because the drain term is
 * continuous in elapsed time and recorded miles, which no SUM over rows can
 * express.)
 *
 * A level-tracked need is a PERCENTAGE. There is no per-need capacity: every
 * tank runs 0 to FULL_LEVEL whether it holds water, fuel or trash, because a
 * percentage is what an operator can read off a gauge without converting.
 *
 * Everything is normalized to RUNWAY — percentage points of headroom left
 * before the need runs dry (depleting needs) or overflows (accumulating ones).
 * Rates consume runway in both directions, which makes projection, deadlines,
 * and threshold evaluation identical for "water is getting empty" and "trash
 * is getting full".
 */

export interface NeedRow {
  id: number;
  key: string;
  title: string;
  direction: string;
  warnRatio: number;
  urgentRatio: number;
  poiCategory: string | null;
  routingDriver: boolean;
  sortOrder: number;
  active: boolean;
  /** "level" = a 0-100% consumable with a rate; "date" = simply due on a day. */
  trackingMode: string;
  dueAt: string | null;
  warnDays: number | null;
  urgentDays: number | null;
  serviceIntervalDays: number | null;
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
  /** How full it physically is, 0-100 (water remaining; trash accumulated). */
  level: number;
  /** Percentage points of headroom before dry/overflow. */
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
  need: Pick<NeedRow, "direction">,
  events: CheckInEvent[],
  rate: { ratePerDay: number; ratePerMile: number },
  nowIso: string,
  milesBetween: (fromIso: string, toIso: string) => number,
): { level: number; runway: number; anchorAt: string | null } {
  // Find the latest absolute anchor: a set-level, or a full-reset service.
  let anchorIdx = -1;
  let anchorRunway = FULL_LEVEL; // trip-start assumption: everything full/empty
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
      anchorRunway = FULL_LEVEL;
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
  runway = Math.min(FULL_LEVEL, Math.max(0, runway));
  return { level: runwayToLevel(need, runway), runway, anchorAt };
}

export function runwayToLevel(need: Pick<NeedRow, "direction">, runway: number): number {
  return need.direction === "accumulates" ? FULL_LEVEL - runway : runway;
}

export function levelToRunway(need: Pick<NeedRow, "direction">, level: number): number {
  return need.direction === "accumulates" ? FULL_LEVEL - level : level;
}

/**
 * Urgency from runway via the shared threshold element: "low" against the
 * warn floor is warn; at or below the urgent floor is urgent.
 */
export function runwayUrgency(
  need: Pick<NeedRow, "warnRatio" | "urgentRatio">,
  runway: number,
): NeedUrgency {
  if (runway <= FULL_LEVEL * need.urgentRatio) return "urgent";
  const state = evaluateThreshold({ level: runway, threshold: FULL_LEVEL * need.warnRatio });
  return state.status === "ok" ? "ok" : "warn";
}

/** Lead times a date-tracked need falls back on when it names none of its own. */
export const DEFAULT_WARN_DAYS = 14;
export const DEFAULT_URGENT_DAYS = 3;

/**
 * Date-tracked needs — an oil change, a registration renewal — have no level
 * and no drain. They are simply due on a day, so their "runway" is the days left
 * until that day. Expressing them in the same runway/urgency/deadline vocabulary
 * as consumables is what lets one gauge, one sort, and one digest serve both.
 */
export function deriveDateState(
  need: Pick<NeedRow, "dueAt" | "warnDays" | "urgentDays" | "serviceIntervalDays">,
  nowIso: string,
): { level: number; runway: number; runwayRatio: number; urgency: NeedUrgency; deadlineAt: string | null } {
  // No due date is nothing scheduled, not something overdue: an empty bar, but calm.
  if (!need.dueAt) {
    return { level: 0, runway: 0, runwayRatio: 0, urgency: "ok", deadlineAt: null };
  }
  const warnDays = need.warnDays ?? DEFAULT_WARN_DAYS;
  const urgentDays = need.urgentDays ?? DEFAULT_URGENT_DAYS;
  const runway = Math.max(0, (Date.parse(need.dueAt) - Date.parse(nowIso)) / MS_PER_DAY);
  // Fill the bar against the whole service interval when there is one, so a need
  // freshly serviced reads full rather than merely "not warned yet".
  const span = need.serviceIntervalDays ?? warnDays * 2;
  const urgency: NeedUrgency = runway <= urgentDays ? "urgent" : runway <= warnDays ? "warn" : "ok";
  return {
    level: round2(runway),
    runway: round2(runway),
    runwayRatio: span > 0 ? round2(Math.min(1, runway / span)) : 0,
    urgency,
    deadlineAt: need.dueAt,
  };
}

/**
 * A stable slug for an operator-created need. The key is what the check-in
 * verbs and the seed fixtures address needs by, so it stays a slug rather than
 * becoming the title — and it must not move when the title is later edited.
 * Collisions take a numeric suffix rather than being rejected, since a second
 * need called "Propane" is a reasonable thing to want.
 */
export function slugifyKey(title: string, taken: Set<string>): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "need";
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${String(i)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Where a service check-in moves a date-tracked need's due date. */
export function rollDueDate(
  need: Pick<NeedRow, "serviceIntervalDays">,
  servicedAtIso: string,
): string | null {
  if (need.serviceIntervalDays === null || need.serviceIntervalDays <= 0) return null;
  return new Date(Date.parse(servicedAtIso) + need.serviceIntervalDays * MS_PER_DAY).toISOString();
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
  need: Pick<NeedRow, "urgentRatio">,
  runway: number,
  ratePerDay: number,
  nowIso: string,
): string | null {
  if (ratePerDay <= 0) return null;
  const floor = FULL_LEVEL * need.urgentRatio;
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
 * consumed a full 100% (plus partials in between) over its (days, miles) gap.
 * The rate is attributed to the need's dominant driver, and the suggestion is
 * the median of the last 8 samples, offered only once 3 samples exist and it
 * moves the rate by >15%. Suggestions NEVER apply themselves.
 *
 * Which driver owns a need is now a property of its RATE rather than its key.
 * A need that drains with driving says so by carrying a per-mile rate; the old
 * `key === "gas"` test could not say it for a second tank or for a propane
 * need an operator adds, since operator-created needs slug their own title.
 * The trade-off: a need whose per-mile rate is zero will never bootstrap into
 * a per-mile suggestion. That is the honest reading — nothing about such a
 * need claims mileage matters — and the seeded fuel need ships with one.
 */
export function rateSuggestionFromHistory(
  events: CheckInEvent[],
  current: { ratePerDay: number; ratePerMile: number },
  milesBetween: (fromIso: string, toIso: string) => number,
): RateSuggestion | null {
  const resets = events.filter((e) => e.kind === "service" && e.quantity === null);
  const mileDriven = current.ratePerMile > 0;
  const samples: number[] = [];
  for (let i = 1; i < resets.length; i++) {
    const from = resets[i - 1]!.occurredAt;
    const to = resets[i]!.occurredAt;
    const partials = events
      .filter((e) => e.kind === "service" && e.quantity !== null && e.occurredAt > from && e.occurredAt < to)
      .reduce((sum, e) => sum + (e.quantity ?? 0), 0);
    const consumed = FULL_LEVEL + partials;
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
  /** Archived needs are hidden from every planning reader; only the manager asks for them. */
  includeArchived = false,
): Promise<NeedState[]> {
  const needRows = (await (includeArchived
    ? db.select().from(needs).orderBy(asc(needs.sortOrder))
    : db.select().from(needs).where(eq(needs.active, true)).orderBy(asc(needs.sortOrder)))) as NeedRow[];

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
    // Date-tracked needs have no level to drain and no rate to refine, so they
    // skip the consumption model entirely — but return the same shape, which is why
    // candidates, the digest and the gauges need no idea the two kinds differ. A
    // zero rate is also what keeps them out of the service-stop loop in candidates.
    if (need.trackingMode === "date") {
      const dateState = deriveDateState(need, nowIso);
      return {
        need,
        rate: { ratePerDay: 0, ratePerMile: 0, source: rate.source },
        ...dateState,
        asOf: nowIso,
        lastCheckInAt: events.at(-1)?.occurredAt ?? null,
        suggestion: null,
      };
    }
    const { level, runway } = deriveRunway(need, events, rate, nowIso, milesBetween);
    return {
      need,
      rate,
      level: round2(level),
      runway: round2(runway),
      // Redundant with `runway` now that runway IS a percentage — but NOT for a
      // date-tracked need, which fills this against its service interval. Keeping
      // one field both modes populate is what lets one gauge render both; do not
      // "simplify" it away.
      runwayRatio: round2(runway / FULL_LEVEL),
      urgency: runwayUrgency(need, runway),
      asOf: nowIso,
      lastCheckInAt: events.at(-1)?.occurredAt ?? null,
      deadlineAt: wallClockDeadline(need, runway, rate.ratePerDay, nowIso),
      suggestion: rateSuggestionFromHistory(events, rate, milesBetween),
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
