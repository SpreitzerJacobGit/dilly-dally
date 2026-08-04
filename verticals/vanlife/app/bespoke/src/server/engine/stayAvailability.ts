import { and, asc, desc, eq, inArray, type Db } from "@elements/storage-sqlite-drizzle";
import { getPoiSourceKeys } from "@elements/intake-poi-sources";
import {
  pois,
  routeCandidates,
  stayAvailability,
  staySites,
  stayOptions,
  trips,
} from "../../db/schema.js";
import { planDateOf } from "./candidates.js";

/**
 * Whether tonight's shortlist actually has room.
 *
 * This is the one genuinely live thing in an otherwise offline-first planner,
 * so it is fenced off carefully:
 *
 * - It runs as a background job and is NEVER called during a replan. Fetching
 *   here inline would make candidate generation both non-deterministic and
 *   dependent on an uplink, breaking ROUTE-5 and OFF-1 in one move.
 * - An unchanged answer bumps `fetchedAt` and leaves `updatedAt` alone, exactly
 *   as poiHook does for places — the fingerprint reads MAX(updated_at), so
 *   otherwise every poll would replan a day nothing had happened to.
 * - A failed check records the error against the row it was checking. It never
 *   downgrades a stored answer to "unknown", because losing signal in a canyon
 *   is not evidence that a campground emptied out.
 *
 * What is stored is always "what a source said, and when" — never "there is a
 * site free tonight". The UI shows the answer with its age.
 */

export const STAY_AVAILABILITY_JOB = "stay-availability-refresh";

/** How many nights ahead we bother asking about. */
const NIGHTS_AHEAD = 2;

/** Ceiling on checks per run, so a big shortlist cannot hammer a public API. */
const MAX_CHECKS_PER_RUN = 12;

export type AvailabilityState = "available" | "full" | "closed" | "unknown";

export interface AvailabilityAnswer {
  state: AvailabilityState;
  detail: string | null;
}

export interface AvailabilityChecker {
  source: string;
  /** Null means "this checker has nothing to say about this site" — not "full". */
  check(input: {
    poiId: number;
    sourceId: string;
    forDate: string;
  }): Promise<AvailabilityAnswer | null>;
}

/**
 * Recreation.gov's public availability endpoint.
 *
 * UNVERIFIED: the path and response shape below were not confirmed against a
 * live account, exactly like the FCC endpoints in deploy/refresh-cell-signal.ps1.
 * Confirm both before trusting output. Until a key is entered the checker is not
 * constructed at all, so the job reports "not configured" rather than failing.
 */
export function createRecreationGovChecker(apiKey: string): AvailabilityChecker {
  return {
    source: "recgov",
    async check({ sourceId, forDate }) {
      const month = `${forDate.slice(0, 7)}-01T00:00:00.000Z`;
      const url = `https://www.recreation.gov/api/camps/availability/campground/${encodeURIComponent(sourceId)}/month?start_date=${encodeURIComponent(month)}`;
      const res = await fetch(url, {
        headers: { apikey: apiKey, "User-Agent": "dilly-dally/0.1.0" },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`recreation.gov responded ${String(res.status)}`);
      const data = (await res.json()) as {
        campsites?: Record<string, { availabilities?: Record<string, string> }>;
      };
      const sites = Object.values(data.campsites ?? {});
      if (sites.length === 0) return null;
      const key = `${forDate}T00:00:00Z`;
      let free = 0;
      let seen = 0;
      for (const site of sites) {
        const status = site.availabilities?.[key];
        if (status === undefined) continue;
        seen++;
        if (status === "Available") free++;
      }
      if (seen === 0) return null;
      return free > 0
        ? { state: "available", detail: `${String(free)} of ${String(seen)} sites free` }
        : { state: "full", detail: `0 of ${String(seen)} sites free` };
    },
  };
}

export async function availabilityCheckers(db: Db): Promise<AvailabilityChecker[]> {
  const keys = await getPoiSourceKeys(db);
  const out: AvailabilityChecker[] = [];
  if (keys.recreationGovApiKey) out.push(createRecreationGovChecker(keys.recreationGovApiKey));
  return out;
}

interface Target {
  poiId: number;
  source: string;
  sourceId: string;
  forDate: string;
}

/**
 * What is worth asking about: the stays the current candidates actually short-
 * listed for the next couple of nights, reservable ones first. Driving the
 * question off the plan keeps the request count bounded by what we might really
 * sleep in, rather than by the size of the catalog.
 */
export async function availabilityTargets(db: Db, nowIso: string): Promise<Target[]> {
  const active = (await db.select().from(trips).where(eq(trips.status, "active")).limit(1))[0];
  if (!active) return [];

  const dates: string[] = [];
  for (let i = 0; i < NIGHTS_AHEAD; i++) {
    dates.push(planDateOf(new Date(Date.parse(nowIso) + i * 86_400_000).toISOString()));
  }

  const out: Target[] = [];
  const seen = new Set<string>();
  for (const forDate of dates) {
    const rows = await db
      .select({
        poiId: stayOptions.poiId,
        orderIndex: stayOptions.orderIndex,
        excludedReason: stayOptions.excludedReason,
        source: pois.source,
        sourceId: pois.sourceId,
        reservable: staySites.reservable,
      })
      .from(stayOptions)
      .innerJoin(routeCandidates, eq(routeCandidates.id, stayOptions.candidateId))
      .innerJoin(pois, eq(pois.id, stayOptions.poiId))
      .innerJoin(staySites, eq(staySites.poiId, stayOptions.poiId))
      .where(and(eq(routeCandidates.tripId, active.id), eq(routeCandidates.planDate, forDate)))
      .orderBy(asc(stayOptions.orderIndex));
    for (const r of rows) {
      // A site nobody can reserve has no availability to report; asking would
      // manufacture a fact rather than discover one.
      if (r.reservable === "none") continue;
      const key = `${String(r.poiId)}:${forDate}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ poiId: r.poiId, source: r.source, sourceId: r.sourceId, forDate });
    }
  }
  return out.slice(0, MAX_CHECKS_PER_RUN);
}

export interface AvailabilityRunResult {
  checked: number;
  changed: number;
  failed: number;
}

export async function refreshStayAvailability(
  db: Db,
  nowIso: string,
  checkers?: AvailabilityChecker[],
): Promise<AvailabilityRunResult | "skipped"> {
  const active = checkers ?? (await availabilityCheckers(db));
  // No configured source is not a failure and not a run — recording it as
  // either would make "never checked" indistinguishable from "checked, nothing
  // to report" on the sources screen.
  if (active.length === 0) return "skipped";

  const targets = await availabilityTargets(db, nowIso);
  if (targets.length === 0) return "skipped";

  const bySource = new Map(active.map((c) => [c.source, c]));
  const now = new Date().toISOString();
  let checked = 0;
  let changed = 0;
  let failed = 0;

  for (const t of targets) {
    const checker = bySource.get(t.source);
    if (!checker) continue;
    checked++;
    let answer: AvailabilityAnswer | null = null;
    let error: string | null = null;
    try {
      answer = await checker.check({ poiId: t.poiId, sourceId: t.sourceId, forDate: t.forDate });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      failed++;
    }
    if (answer === null && error === null) continue;

    const existing = (
      await db
        .select()
        .from(stayAvailability)
        .where(and(eq(stayAvailability.poiId, t.poiId), eq(stayAvailability.forDate, t.forDate)))
    )[0];

    if (error !== null) {
      // Record the failure without touching the stored answer: a check we could
      // not make is not evidence about the campground.
      if (existing) {
        await db
          .update(stayAvailability)
          .set({ fetchedAt: now, lastError: error })
          .where(eq(stayAvailability.id, existing.id));
      }
      continue;
    }

    const same =
      existing !== undefined &&
      existing.state === answer!.state &&
      existing.detail === answer!.detail &&
      existing.source === checker.source;
    if (same) {
      // fetchedAt only — see the module header.
      await db
        .update(stayAvailability)
        .set({ fetchedAt: now, lastError: null })
        .where(eq(stayAvailability.id, existing.id));
      continue;
    }

    changed++;
    if (existing) {
      await db
        .update(stayAvailability)
        .set({
          state: answer!.state,
          detail: answer!.detail,
          source: checker.source,
          lastError: null,
          fetchedAt: now,
          updatedAt: now,
        })
        .where(eq(stayAvailability.id, existing.id));
    } else {
      await db.insert(stayAvailability).values({
        poiId: t.poiId,
        forDate: t.forDate,
        state: answer!.state,
        detail: answer!.detail,
        source: checker.source,
        lastError: null,
        fetchedAt: now,
        updatedAt: now,
      });
    }
  }

  return { checked, changed, failed };
}

export interface AvailabilityHealth {
  configured: boolean;
  lastFetchedAt: string | null;
  lastError: string | null;
  rows: number;
}

/** For the status screen — the same four-state honesty the POI sources have. */
export async function availabilityHealth(db: Db): Promise<AvailabilityHealth> {
  const keys = await getPoiSourceKeys(db);
  const latest = (
    await db
      .select()
      .from(stayAvailability)
      .orderBy(desc(stayAvailability.fetchedAt))
      .limit(1)
  )[0];
  const errored = (
    await db
      .select({ lastError: stayAvailability.lastError })
      .from(stayAvailability)
      .where(inArray(stayAvailability.state, ["available", "full", "closed", "unknown"]))
      .orderBy(desc(stayAvailability.fetchedAt))
      .limit(20)
  ).find((r) => r.lastError !== null);
  const rows = (await db.select({ id: stayAvailability.id }).from(stayAvailability)).length;
  return {
    configured: Boolean(keys.recreationGovApiKey),
    lastFetchedAt: latest?.fetchedAt ?? null,
    lastError: errored?.lastError ?? null,
    rows,
  };
}
