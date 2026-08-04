import { and, eq, sql, type Db } from "@elements/storage-sqlite-drizzle";
import { poiSourceRuns, type OnPois, type PoiRegion } from "@elements/intake-poi-sources";
import { pois, staySites, trips } from "../db/schema.js";
import { anchorRegionCells, corridorRegionCells } from "./engine/pois.js";
import { allPendingAnchors, loadAnchorTree } from "./engine/anchors.js";
import { deriveStayFacts } from "./engine/stayFacts.js";

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
    // A place we could sleep at also needs its stay facts, or the planner would
    // only ever consider the campgrounds that happened to exist before this
    // feature shipped. Same discipline as above: an unchanged derivation must
    // leave updatedAt alone, because the fingerprint reads MAX(updated_at) here
    // too and a nightly poll would otherwise replan every morning by itself.
    const facts = deriveStayFacts(r);
    if (facts) {
      const row = (
        await db
          .select({ id: pois.id })
          .from(pois)
          .where(and(eq(pois.source, r.source), eq(pois.sourceId, r.sourceId)))
      )[0];
      if (row) await upsertStaySite(db, row.id, facts, now);
    }
    upserted++;
  }
  return { upserted };
};

type StayFacts = NonNullable<ReturnType<typeof deriveStayFacts>>;

async function upsertStaySite(db: Db, poiId: number, facts: StayFacts, now: string): Promise<void> {
  const existing = (await db.select().from(staySites).where(eq(staySites.poiId, poiId)))[0];
  if (existing) {
    const unchanged = (Object.keys(facts) as (keyof StayFacts)[]).every((k) => existing[k] === facts[k]);
    if (unchanged) return;
    await db.update(staySites).set({ ...facts, updatedAt: now }).where(eq(staySites.poiId, poiId));
    return;
  }
  await db.insert(staySites).values({ poiId, ...facts, updatedAt: now });
}

/**
 * Regions worth fetching = the active trip's corridor cells, nearest to the
 * origin first, capped per poll — a whole-corridor sweep would mean dozens of
 * Overpass requests in one tick; hourly polls fill the corridor within a day
 * while staying polite to the shared public endpoint.
 */
const MAX_REGIONS_PER_POLL = 8;

/**
 * Anchors get a reserved share of each poll. A single 110-mile anchor tiles to
 * roughly a dozen cells, which would otherwise starve the corridor sweep for a
 * day — and an anchor with no places behind it can only resolve geometrically,
 * so it is the cell most worth fetching.
 */
const ANCHOR_REGION_QUOTA = 5;

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

  // Anchor cells share the corridor's key format, so a cell claimed by both
  // dedupes here and shares one freshness row downstream.
  const anchors = allPendingAnchors(await loadAnchorTree(db, trip.id));
  const anchorCells = [
    ...new Map(
      anchors
        .flatMap((a) => anchorRegionCells(a.center, a.radiusMiles))
        .map((c) => [c.key, c] as const),
    ).values(),
  ]
    .sort((a, b) => a.key.localeCompare(b.key))
    .filter((c) => !freshKeys.has(c.key))
    .slice(0, ANCHOR_REGION_QUOTA);

  const anchorKeys = new Set(anchorCells.map((c) => c.key));
  const corridorCells = cells
    .sort((a, b) => centerDist(a) - centerDist(b) || a.key.localeCompare(b.key))
    .filter((c) => !freshKeys.has(c.key) && !anchorKeys.has(c.key))
    .slice(0, MAX_REGIONS_PER_POLL - anchorCells.length);

  return [...anchorCells, ...corridorCells];
}

/** Seeded-place count, used by the sources screen. */
export async function poiCount(db: Db, source?: string): Promise<number> {
  const rows = source
    ? await db.select({ n: sql<number>`count(*)` }).from(pois).where(and(eq(pois.source, source)))
    : await db.select({ n: sql<number>`count(*)` }).from(pois);
  return rows[0]?.n ?? 0;
}
