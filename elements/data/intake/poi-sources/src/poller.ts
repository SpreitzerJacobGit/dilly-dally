import { eq, type DbHandle } from "@elements/storage-sqlite-drizzle";
import { errorInfo, type AppLogger } from "@elements/observability-structured-logging";
import { poiSourceRuns } from "./tables.js";
import type { OnPois, PoiRegion, PoiSourceAdapter } from "./types.js";

export const POI_SOURCES_JOB = "poi-sources-refresh";

export interface PoiPollerOptions {
  dbHandle: DbHandle;
  logger: AppLogger;
  adapters: PoiSourceAdapter[];
  onPois: OnPois;
  /**
   * Returns the regions currently worth fetching (e.g. the active trip's
   * corridor cells). Empty → the poll skips entirely. The element never knows
   * what a trip is.
   */
  regionProvider: (db: DbHandle["db"]) => Promise<PoiRegion[]>;
  /** A (source, region) fresher than this is not refetched. Default 24h. */
  minRefreshHours?: number;
}

export interface PoiPollResult {
  skipped: boolean;
  fetched: number;
  errors: number;
}

export function createPoiPoller(opts: PoiPollerOptions) {
  const { db } = opts.dbHandle;
  const log = opts.logger;
  const minAgeMs = (opts.minRefreshHours ?? 24) * 3_600_000;

  async function upsertRun(
    key: string,
    source: string,
    region: string,
    patch: { success?: { count: number }; error?: string },
  ): Promise<void> {
    const now = new Date().toISOString();
    const existing = await db.select().from(poiSourceRuns).where(eq(poiSourceRuns.key, key));
    const row = {
      key,
      source,
      region,
      lastRunAt: now,
      lastSuccessAt: patch.success ? now : (existing[0]?.lastSuccessAt ?? null),
      lastError: patch.error ?? null,
      fetchedCount: patch.success?.count ?? existing[0]?.fetchedCount ?? null,
      updatedAt: now,
    };
    if (existing.length > 0) {
      await db.update(poiSourceRuns).set(row).where(eq(poiSourceRuns.key, key));
    } else {
      await db.insert(poiSourceRuns).values(row);
    }
  }

  return {
    async poll(): Promise<PoiPollResult> {
      const regions = await opts.regionProvider(db);
      if (regions.length === 0) return { skipped: true, fetched: 0, errors: 0 };

      let fetched = 0;
      let errors = 0;
      let didWork = false;

      for (const adapter of opts.adapters) {
        for (const region of regions) {
          const key = `${adapter.source}:${region.key}`;
          const existing = await db.select().from(poiSourceRuns).where(eq(poiSourceRuns.key, key));
          const lastSuccess = existing[0]?.lastSuccessAt;
          if (lastSuccess && Date.now() - Date.parse(lastSuccess) < minAgeMs) continue;

          try {
            const result = await adapter.fetchRegion(region, { db, logger: log });
            if (!Array.isArray(result)) {
              log.info({ source: adapter.source, reason: result.unconfigured }, "poi source skipped");
              continue; // unconfigured — record nothing
            }
            const { upserted } = await opts.onPois(db, result, { source: adapter.source, region });
            await upsertRun(key, adapter.source, region.key, { success: { count: result.length } });
            log.info(
              { source: adapter.source, region: region.key, fetched: result.length, upserted },
              "poi region refreshed",
            );
            fetched += result.length;
            didWork = true;
          } catch (err) {
            errors += 1;
            didWork = true;
            await upsertRun(key, adapter.source, region.key, { error: errorInfo(err).message });
            log.warn({ source: adapter.source, region: region.key, ...errorInfo(err) }, "poi fetch failed");
          }
        }
      }
      return { skipped: !didWork, fetched, errors };
    },
  };
}
