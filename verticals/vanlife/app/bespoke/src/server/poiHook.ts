import { and, eq, sql, type Db } from "@elements/storage-sqlite-drizzle";
import { poiSourceRuns, type OnPois, type PoiRegion } from "@elements/intake-poi-sources";
import { pois, trips } from "../db/schema.js";
import { corridorRegionCells } from "./engine/pois.js";

/**
 * The bespoke half of POI intake: idempotent upsert on (source, sourceId) —
 * the element guarantees the identity, this hook guarantees a re-fetch can
 * never duplicate a place (POI-2) and, when the fetched data is unchanged,
 * never bumps `updatedAt` (ROUTE-5): the plan-state fingerprint reads
 * MAX(updated_at), so a no-op poller refresh must not look like a state
 * change and force a replan rebuild. Only `fetchedAt` tracks the fetch.
 */
export const onPois: OnPois = async (db, records, _meta) => {
  const now = new Date().toISOString();
  let upserted = 0;
  for (const r of records) {
    const content = {
      name: r.name,
      category: r.category,
      subcategory: r.subcategory ?? null,
      lat: r.lat,
      lng: r.lng,
      popularity: r.popularity ?? null,
      tags: r.tags ? JSON.stringify(r.tags) : null,
      url: r.url ?? null,
    };
    const existing = (
      await db
        .select()
        .from(pois)
        .where(and(eq(pois.source, r.source), eq(pois.sourceId, r.sourceId)))
    )[0];
    const unchanged =
      existing !== undefined &&
      (Object.keys(content) as (keyof typeof content)[]).every((k) => existing[k] === content[k]);
    if (unchanged) {
      await db
        .update(pois)
        .set({ fetchedAt: now })
        .where(and(eq(pois.source, r.source), eq(pois.sourceId, r.sourceId)));
    } else {
      await db
        .insert(pois)
        .values({ source: r.source, sourceId: r.sourceId, ...content, fetchedAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: [pois.source, pois.sourceId],
          set: { ...content, fetchedAt: now, updatedAt: now },
        });
    }
    upserted++;
  }
  return { upserted };
};

/**
 * Regions worth fetching = the active trip's corridor cells, nearest to the
 * origin first, capped per poll — a whole-corridor sweep would mean dozens of
 * Overpass requests in one tick; hourly polls fill the corridor within a day
 * while staying polite to the shared public endpoint.
 */
const MAX_REGIONS_PER_POLL = 8;

export async function vanlifeRegionProvider(db: Db): Promise<PoiRegion[]> {
  const active = await db.select().from(trips).where(eq(trips.status, "active")).limit(1);
  const trip = active[0];
  if (!trip) return [];
  const baseline = trip.directDurationMinutes;
  if (baseline === null) return [];
  const cells = corridorRegionCells(
    { lat: trip.originLat, lng: trip.originLng },
    { lat: trip.destLat, lng: trip.destLng },
    baseline * trip.deviationBudgetRatio,
  );
  const origin = { lat: trip.originLat, lng: trip.originLng };
  const centerDist = (c: PoiRegion): number => {
    const lat = (c.bbox[0] + c.bbox[2]) / 2;
    const lng = (c.bbox[1] + c.bbox[3]) / 2;
    return (lat - origin.lat) ** 2 + (lng - origin.lng) ** 2;
  };
  // Freshness bookkeeping inside the poller skips cells fetched recently, so
  // capping here rotates through the corridor across successive polls.
  const runs = await db.select().from(poiSourceRuns);
  const freshKeys = new Set(
    runs
      .filter((r) => r.lastSuccessAt && Date.now() - Date.parse(r.lastSuccessAt) < 22 * 3_600_000)
      .map((r) => r.region),
  );
  return cells
    .sort((a, b) => centerDist(a) - centerDist(b) || a.key.localeCompare(b.key))
    .filter((c) => !freshKeys.has(c.key))
    .slice(0, MAX_REGIONS_PER_POLL);
}

/** Seeded-place count, used by the sources screen. */
export async function poiCount(db: Db, source?: string): Promise<number> {
  const rows = source
    ? await db.select({ n: sql<number>`count(*)` }).from(pois).where(and(eq(pois.source, source)))
    : await db.select({ n: sql<number>`count(*)` }).from(pois);
  return rows[0]?.n ?? 0;
}
