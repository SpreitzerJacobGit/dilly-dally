import { and, eq, type DbHandle } from "@elements/storage-sqlite-drizzle";
import type { IntervalJob } from "@elements/lifecycle-interval-jobs";
import type { AppLogger } from "@elements/observability-structured-logging";
import {
  POI_SOURCES_JOB,
  createNpsAdapter,
  createOpenChargeMapAdapter,
  createOverpassAdapter,
  createPoiPoller,
  createRecreationGovAdapter,
} from "@elements/intake-poi-sources";
import { digests, trips } from "../db/schema.js";
import { onPois, vanlifeRegionProvider } from "./poiHook.js";
import {
  buildDailyCandidates,
  persistCandidates,
  planDateOf,
  planStateFingerprint,
  storedPlanFingerprint,
  type TripRow,
} from "./engine/candidates.js";
import { digestHour, generateAndDeliverDigest, pushUrgentWarnings } from "./engine/digest.js";
import { OsrmUnavailableError } from "./engine/osrm.js";

export const MORNING_DIGEST_JOB = "vanlife-morning-digest";

/**
 * Recurring bespoke work, registered by the generated composition root:
 * - POI refresh over the active trip's corridor (hourly tick; per-region
 *   freshness inside the poller keeps real fetches ~daily).
 * - Morning digest: a 15-minute tick that gates on the configured local hour
 *   and the once-a-day digest row — interval-jobs has no wall clock, and a
 *   skipped tick honestly records nothing.
 */
export function createBespokeJobs(deps: {
  dbHandle: DbHandle;
  logger: AppLogger;
  config: Record<string, unknown>;
}): IntervalJob[] {
  const { dbHandle, logger } = deps;

  const poller = createPoiPoller({
    dbHandle,
    logger,
    adapters: [
      createOverpassAdapter(),
      createNpsAdapter(),
      createRecreationGovAdapter(),
      createOpenChargeMapAdapter(),
    ],
    onPois,
    regionProvider: vanlifeRegionProvider,
  });

  const poiJob: IntervalJob = {
    name: POI_SOURCES_JOB,
    intervalMs: 3_600_000,
    enabled: true,
    run: async () => ((await poller.poll()).skipped ? "skipped" : undefined),
  };

  const digestJob: IntervalJob = {
    name: MORNING_DIGEST_JOB,
    intervalMs: 15 * 60_000,
    enabled: true,
    run: async () => {
      const db = dbHandle.db;
      const active = await db.select().from(trips).where(eq(trips.status, "active")).limit(1);
      const trip = active[0] as (TripRow & { name: string }) | undefined;
      if (!trip) return "skipped";
      const now = new Date();
      const hour = await digestHour(db);
      if (now.getHours() < hour) return "skipped";
      const date = planDateOf(now.toISOString());
      const already = await db
        .select({ id: digests.id })
        .from(digests)
        .where(and(eq(digests.tripId, trip.id), eq(digests.date, date)));
      if (already.length > 0) return "skipped";

      // Fresh plan first, so the digest describes today's actual options;
      // if routing is down, compose a needs-only digest and say so.
      // ROUTE-5: if today's plan already exists and no state changed since it
      // was built, keep it — a rebuild under a newer clock would reshuffle
      // candidates without any check-in, selection, or position change.
      const stored = await storedPlanFingerprint(db, trip.id, date);
      const unchanged = stored !== null && stored === (await planStateFingerprint(db, trip.id));
      try {
        if (!unchanged) {
          const built = await buildDailyCandidates(db, trip, now.toISOString());
          await persistCandidates(db, trip.id, date, built);
          await pushUrgentWarnings(dbHandle, logger, trip, built.flatMap((b) => b.warnings), now.toISOString());
        }
      } catch (err) {
        if (!(err instanceof OsrmUnavailableError)) throw err;
        logger.warn({ err: err.message }, "digest: planning degraded, composing needs-only digest");
      }
      const result = await generateAndDeliverDigest(dbHandle, logger, trip, now.toISOString());
      if (!result.push.ok && !result.push.skipped) {
        // Row persisted (banner works); push failed — surface it as a job error.
        throw new Error(`digest push failed: ${result.push.error}`);
      }
      return undefined;
    },
  };

  return [poiJob, digestJob];
}
