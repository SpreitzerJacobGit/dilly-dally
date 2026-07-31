import { z } from "zod";
import type { Db } from "@elements/storage-sqlite-drizzle";
import type { AppLogger } from "@elements/observability-structured-logging";

/**
 * The normalized shape every adapter emits and the bespoke `onPois` hook
 * receives. The domain POI table (and any category remapping) belongs to the
 * vertical; identity, normalization, and fetch bookkeeping belong here.
 */
export const PoiRecordSchema = z.object({
  /** Adapter id: "overpass" | "nps" | "recgov" | "opencharge" | a dataset name. */
  source: z.string().min(1),
  /** Stable within the source — with `source`, the dedupe identity. */
  sourceId: z.string().min(1),
  name: z.string().min(1),
  /**
   * Canonical categories adapters emit: campground, water-fill, dump-station,
   * laundry, grocery, fuel, ev-charge, restroom, hike, scenic, family, other.
   * Typed as string so verticals can extend; remap in `onPois` if needed.
   */
  category: z.string().min(1),
  subcategory: z.string().nullish(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /** Normalized 0–1 popularity when the source has a signal; null when it does not. */
  popularity: z.number().min(0).max(1).nullish(),
  /** Raw source attributes worth keeping (OSM tags, park codes, …). */
  tags: z.record(z.string(), z.unknown()).optional(),
  /** Deep link out to the source's own page for this POI. */
  url: z.string().nullish(),
});
export type PoiRecord = z.infer<typeof PoiRecordSchema>;

/** A named fetch region — typically a corridor cell the vertical computes. */
export interface PoiRegion {
  /** Stable key; drives per-region freshness bookkeeping. */
  key: string;
  /** [south, west, north, east] in degrees. */
  bbox: [number, number, number, number];
}

export interface OnPoisMeta {
  source: string;
  region: PoiRegion;
}

/**
 * The bespoke ingestion hook. Receives normalized batches; owns upsert into the
 * vertical's POI table keyed on (source, sourceId). Returns counts for logging.
 */
export type OnPois = (
  db: Db,
  records: PoiRecord[],
  meta: OnPoisMeta,
) => Promise<{ upserted: number }>;

export type FetchResult = PoiRecord[] | { unconfigured: string };

export interface PoiSourceAdapter {
  source: string;
  /**
   * Fetch one region. Return `{ unconfigured }` when the adapter cannot run
   * (e.g. its API key is not stored) — the poller then skips it without
   * recording a run. Throw on real failures.
   */
  fetchRegion(region: PoiRegion, deps: { db: Db; logger: AppLogger }): Promise<FetchResult>;
}
