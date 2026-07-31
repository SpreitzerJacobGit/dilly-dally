import { z } from "zod";
import { router } from "@elements/lifecycle-service-runtime";
import { protectedProcedure } from "@elements/identity-session-auth";
import { desc, type Db } from "@elements/storage-sqlite-drizzle";
import { activeRunner } from "@elements/lifecycle-interval-jobs";
import { poiSourceRuns } from "./tables.js";
import { POI_SOURCES_JOB } from "./poller.js";
import {
  SOURCE_KEY_FIELDS,
  getPoiSourceKeys,
  savePoiSourceKeys,
} from "./settings.js";

export type PoiSourceState = "unconfigured" | "never-checked" | "healthy" | "erroring";

export interface PoiSourceStatus {
  source: string;
  state: PoiSourceState;
  needsKey: boolean;
  hasKey: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  fetchedCount: number | null;
  regions: number;
}

/**
 * One honest row per source: never-checked until a fetch has actually
 * succeeded or failed; a keyed source without its key is "unconfigured".
 */
export async function poiSourceStatuses(db: Db, sources: string[]): Promise<PoiSourceStatus[]> {
  const keys = await getPoiSourceKeys(db);
  const runs = await db.select().from(poiSourceRuns).orderBy(desc(poiSourceRuns.updatedAt));

  return sources.map((source) => {
    const keyField = SOURCE_KEY_FIELDS[source];
    const needsKey = keyField !== undefined;
    const hasKey = needsKey ? Boolean(keys[keyField]) : true;
    const rows = runs.filter((r) => r.source === source);
    const latest = rows[0];
    const anyError = rows.find((r) => r.lastError);

    let state: PoiSourceState;
    if (needsKey && !hasKey) state = "unconfigured";
    else if (!latest?.lastRunAt) state = "never-checked";
    else if (anyError) state = "erroring";
    else state = "healthy";

    return {
      source,
      state,
      needsKey,
      hasKey,
      lastRunAt: latest?.lastRunAt ?? null,
      lastSuccessAt: rows.reduce<string | null>((acc, r) => (r.lastSuccessAt && (!acc || r.lastSuccessAt > acc) ? r.lastSuccessAt : acc), null),
      lastError: anyError?.lastError ?? null,
      fetchedCount: rows.reduce<number | null>((acc, r) => (r.fetchedCount === null ? acc : (acc ?? 0) + r.fetchedCount), null),
      regions: rows.length,
    };
  });
}

export function createPoiSourcesStatusRouter(opts: { sources: string[] }) {
  return router({
    status: protectedProcedure.query(async ({ ctx }) => poiSourceStatuses(ctx.dbHandle.db, opts.sources)),

    saveKeys: protectedProcedure
      .input(
        z.object({
          npsApiKey: z.string().optional(),
          recreationGovApiKey: z.string().optional(),
          openChargeMapApiKey: z.string().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        // Merge over stored keys so saving one field never clears another.
        const current = await getPoiSourceKeys(ctx.dbHandle.db);
        await savePoiSourceKeys(ctx.dbHandle.db, { ...current, ...input }, String(ctx.user.id));
        return { saved: true as const };
      }),

    refreshNow: protectedProcedure.mutation(async () => {
      const runner = activeRunner();
      if (!runner) return { started: false as const, reason: "unavailable" as const };
      return runner.runNow(POI_SOURCES_JOB);
    }),
  });
}
