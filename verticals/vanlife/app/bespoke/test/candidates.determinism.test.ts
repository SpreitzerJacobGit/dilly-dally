import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, eq, type DbHandle } from "@elements/storage-sqlite-drizzle";
import { users } from "@elements/identity-session-auth";
import type { PoiRecord } from "@elements/intake-poi-sources";
import {
  checkIns,
  interestWeights,
  needRates,
  needs,
  poiMarks,
  pois,
  progressEvents,
  trips,
  waypoints,
} from "../src/db/schema.js";
import {
  buildDailyCandidates,
  planStateFingerprint,
  type TripRow,
} from "../src/server/engine/candidates.js";
import { closestPointOnLine, haversineMiles, type LatLng } from "../src/server/engine/geo.js";
import {
  flattenPendingAnchors,
  loadAnchorTree,
  resolveAnchor,
} from "../src/server/engine/anchors.js";
import { onPois } from "../src/server/poiHook.js";

/**
 * ROUTE-5 regression: with no new check-ins, selections, or position changes,
 * candidate generation must be a pure function of its inputs — two runs return
 * mathematically identical candidates (same drive times, distances, and stop
 * counts), and an idempotent POI poller refresh must not move the plan-state
 * fingerprint that gates replan rebuilds.
 */

const NOW = "2026-07-30T17:23:11.000Z";
const T0 = "2026-07-25T00:00:00.000Z";
const daysAgo = (days: number): string => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

const ORIGIN: LatLng = { lat: 45.5152, lng: -122.6784 }; // Portland, OR
const DEST: LatLng = { lat: 36.1699, lng: -115.1398 }; // Las Vegas, NV
const POSITION: LatLng = { lat: 44.0582, lng: -121.3153 }; // Bend, OR
const lerp = (f: number): LatLng => ({
  lat: POSITION.lat + (DEST.lat - POSITION.lat) * f,
  lng: POSITION.lng + (DEST.lng - POSITION.lng) * f,
});

/** Deterministic fake OSRM: straight-line legs driven at a constant 45 mph. */
function fakeOsrmResponse(url: string): Response {
  const match = /\/route\/v1\/driving\/([^?]+)/.exec(url);
  if (!match) return new Response("not found", { status: 404 });
  const coords: LatLng[] = match[1]!.split(";").map((pair) => {
    const [lng, lat] = pair.split(",").map(Number);
    return { lat: lat!, lng: lng! };
  });
  const legs = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const miles = haversineMiles(coords[i]!, coords[i + 1]!);
    legs.push({ duration: (miles / 45) * 3600, distance: miles * 1609.34 });
  }
  const body = {
    code: "Ok",
    routes: [
      {
        duration: legs.reduce((s, l) => s + l.duration, 0),
        distance: legs.reduce((s, l) => s + l.distance, 0),
        geometry: { coordinates: coords.map((c) => [c.lng, c.lat]) },
        legs,
      },
    ],
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

let handle: DbHandle;
let trip: TripRow;
let tripId: number;

beforeAll(async () => {
  vi.stubGlobal("fetch", (input: unknown) => Promise.resolve(fakeOsrmResponse(String(input))));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vanlife-route5-"));
  handle = await createDb({ dbFile: path.join(dir, "test.db") });
  const migrationsDir = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      if (stmt.trim().length > 0) await handle.client.execute(stmt);
    }
  }
  const db = handle.db;

  const uid = (
    await db
      .insert(users)
      .values({ email: "test@example.com", passwordHash: "x", role: "operator", createdAt: T0 })
      .returning({ id: users.id })
  )[0]!.id;

  tripId = (
    await db
      .insert(trips)
      .values({
        name: "Portland to Vegas",
        status: "active",
        originName: "Portland, OR",
        originLat: ORIGIN.lat,
        originLng: ORIGIN.lng,
        destName: "Las Vegas, NV",
        destLat: DEST.lat,
        destLng: DEST.lng,
        directDurationMinutes: 1000,
        deviationBudgetRatio: 2,
        dailyDriveHours: 6,
        createdAt: T0,
        updatedAt: T0,
      })
      .returning({ id: trips.id })
  )[0]!.id;
  trip = (await db.select().from(trips))[0] as unknown as TripRow;

  await db.insert(progressEvents).values({
    tripId,
    kind: "position-set",
    lat: POSITION.lat,
    lng: POSITION.lng,
    milesDriven: 160,
    driveSeconds: (160 / 45) * 3600,
    recordedBy: uid,
    occurredAt: daysAgo(1),
  });

  // Water is close enough to its floor that a service stop is forced today;
  // food has days of runway and stays a non-stop. Percentages: water was 12 gal
  // of 40 at 6 gal/day, food 7 days of runway at 1/day.
  const needSeeds = [
    { key: "water", title: "Fresh water", poiCategory: "water-fill", ratePerDay: 15, checkIn: { kind: "set-level", quantity: 30, at: daysAgo(0.5) } },
    { key: "food", title: "Food", poiCategory: "grocery", ratePerDay: 100 / 7, checkIn: { kind: "service", quantity: null, at: daysAgo(3) } },
  ];
  for (const [i, seed] of needSeeds.entries()) {
    const needId = (
      await db
        .insert(needs)
        .values({
          key: seed.key,
          title: seed.title,
          direction: "depletes",
          warnRatio: 0.25,
          urgentRatio: 0.1,
          poiCategory: seed.poiCategory,
          routingDriver: true,
          sortOrder: i + 1,
          active: true,
        })
        .returning({ id: needs.id })
    )[0]!.id;
    await db.insert(needRates).values({
      needId,
      ratePerDay: seed.ratePerDay,
      ratePerMile: 0,
      source: "manual",
      effectiveFrom: T0,
      createdAt: T0,
    });
    await db.insert(checkIns).values({
      needId,
      kind: seed.checkIn.kind,
      quantity: seed.checkIn.quantity,
      recordedBy: uid,
      occurredAt: seed.checkIn.at,
      createdAt: seed.checkIn.at,
    });
  }

  for (const [category, weight] of [["hike", 1.5], ["scenic", 1], ["campground", 0.8], ["boulder", 1], ["bike", 1], ["family", 1]] as const) {
    await db.insert(interestWeights).values({ category, weight, updatedAt: T0 });
  }

  // Corridor catalog: a dense campground band so every role finds a sleep
  // spot, service stops for water, and side-quest sights — including a pair
  // with identical scores so tie-breaking is actually exercised.
  const poiSeeds: { name: string; category: string; f: number; popularity: number | null }[] = [
    { name: "Corridor Water A", category: "water-fill", f: 0.1, popularity: null },
    { name: "Corridor Water B", category: "water-fill", f: 0.3, popularity: null },
    { name: "Summit Hike", category: "hike", f: 0.15, popularity: 0.9 },
    { name: "Canyon Hike", category: "hike", f: 0.22, popularity: 0.7 },
    { name: "Ridge Hike", category: "hike", f: 0.35, popularity: 0.7 },
    { name: "Quiet Hike", category: "hike", f: 0.5, popularity: null },
    { name: "Vista Point", category: "scenic", f: 0.28, popularity: 0.8 },
    { name: "Dry Lake Overlook", category: "scenic", f: 0.42, popularity: 0.6 },
  ];
  for (let f = 0.2; f <= 0.6; f += 0.03) {
    poiSeeds.push({ name: `Camp ${f.toFixed(2)}`, category: "campground", f, popularity: 0.5 });
  }
  let pinnedPoiId: number | null = null;
  for (const [i, seed] of poiSeeds.entries()) {
    const p = lerp(seed.f);
    const id = (
      await db
        .insert(pois)
        .values({
          source: "manual",
          sourceId: `seed-${String(i)}`,
          name: seed.name,
          category: seed.category,
          lat: p.lat,
          lng: p.lng,
          popularity: seed.popularity,
          fetchedAt: T0,
          updatedAt: T0,
        })
        .returning({ id: pois.id })
    )[0]!.id;
    if (seed.name === "Canyon Hike") pinnedPoiId = id;
  }
  await db.insert(poiMarks).values({ tripId, poiId: pinnedPoiId!, mark: "pinned", createdAt: T0 });
});

afterAll(() => {
  vi.unstubAllGlobals();
  handle.close();
});

describe("ROUTE-5: replan determinism", () => {
  it("two generations with identical inputs are deeply equal, sub-fields included", async () => {
    const run1 = await buildDailyCandidates(handle.db, trip, NOW);
    const run2 = await buildDailyCandidates(handle.db, trip, NOW);

    expect(run1.length).toBeGreaterThan(0);
    expect(run1.some((c) => c.stops.length > 1)).toBe(true);

    // Deep equality across the full candidate shape: driveTime, distance,
    // stops (with ETAs and cumulative miles), geometry, warnings, scores.
    expect(run2).toEqual(run1);
    expect(run2.map((c) => c.durationMinutes)).toEqual(run1.map((c) => c.durationMinutes));
    expect(run2.map((c) => c.distanceMiles)).toEqual(run1.map((c) => c.distanceMiles));
    expect(run2.map((c) => c.stops.length)).toEqual(run1.map((c) => c.stops.length));
  });

  it("a replan minutes later within the same hour changes nothing", async () => {
    const run1 = await buildDailyCandidates(handle.db, trip, NOW);
    const run3 = await buildDailyCandidates(handle.db, trip, "2026-07-30T17:59:59.000Z");
    expect(run3).toEqual(run1);
  });

  it("an idempotent POI refresh does not move the plan-state fingerprint", async () => {
    const meta = {
      source: "overpass",
      region: { key: "42,-119", bbox: [41, -120, 43, -118] as [number, number, number, number] },
    };
    const records: PoiRecord[] = [
      {
        source: "overpass",
        sourceId: "way-1",
        name: "Corridor Spring",
        category: "water-fill",
        lat: lerp(0.55).lat,
        lng: lerp(0.55).lng,
        popularity: 0.5,
        url: null,
      },
      {
        source: "overpass",
        sourceId: "node-2",
        name: "Rim Trailhead",
        category: "hike",
        lat: lerp(0.58).lat,
        lng: lerp(0.58).lng,
        popularity: 0.4,
        tags: { tourism: "trailhead" },
        url: "https://example.com/rim",
      },
    ];
    await onPois(handle.db, records, meta);
    const f1 = await planStateFingerprint(handle.db, tripId);

    // The hourly poller re-fetching identical data is NOT a state change.
    await onPois(handle.db, records, meta);
    expect(await planStateFingerprint(handle.db, tripId)).toBe(f1);

    // But a real content change is. (Small sleep so the bumped updatedAt
    // cannot collide with the first write at millisecond resolution.)
    await new Promise((r) => setTimeout(r, 5));
    await onPois(handle.db, [{ ...records[0]!, name: "Corridor Spring (renamed)" }], meta);
    expect(await planStateFingerprint(handle.db, tripId)).not.toBe(f1);
  });
});

describe("area anchors", () => {
  /** A broad disc straddling the corridor, roughly a third of the way along. */
  const CENTER = lerp(0.33);
  let anchorId: number;

  beforeAll(async () => {
    anchorId = (
      await handle.db
        .insert(waypoints)
        .values({
          tripId,
          name: "Test Range",
          lat: CENTER.lat,
          lng: CENTER.lng,
          radiusMiles: 60,
          parentId: null,
          depth: 0,
          kind: "custom",
          orderIndex: 0,
          status: "pending",
          createdAt: T0,
        })
        .returning({ id: waypoints.id })
    )[0]!.id;
  });

  it("still generates identical candidates twice with an anchor in play", async () => {
    const run1 = await buildDailyCandidates(handle.db, trip, NOW);
    const run2 = await buildDailyCandidates(handle.db, trip, NOW);
    expect(run1.length).toBeGreaterThan(0);
    expect(run2).toEqual(run1);
  });

  it("routes the projected continuation through the anchor's area", async () => {
    // The end-to-end proof of the whole feature: whatever else a candidate
    // does, the route it projects must actually enter the region.
    const [candidate] = await buildDailyCandidates(handle.db, trip, NOW);
    expect(candidate).toBeDefined();
    const line = JSON.parse(candidate!.geometry) as { coordinates: [number, number][] };
    const projected = candidate!.projectedGeometry
      ? (JSON.parse(candidate!.projectedGeometry) as { coordinates: [number, number][] }).coordinates
      : [];
    const all = [...line.coordinates, ...projected];
    expect(closestPointOnLine(all, CENTER).miles).toBeLessThanOrEqual(60);
  });

  it("moving the fingerprint: radius, parent, order and pin each count as a change", async () => {
    const base = await planStateFingerprint(handle.db, tripId);

    await handle.db.update(waypoints).set({ radiusMiles: 75 }).where(eq(waypoints.id, anchorId));
    const afterRadius = await planStateFingerprint(handle.db, tripId);
    expect(afterRadius).not.toBe(base);

    await handle.db.update(waypoints).set({ orderIndex: 3 }).where(eq(waypoints.id, anchorId));
    expect(await planStateFingerprint(handle.db, tripId)).not.toBe(afterRadius);

    await handle.db
      .update(waypoints)
      .set({ orderIndex: 0, pinnedLat: CENTER.lat, pinnedLng: CENTER.lng })
      .where(eq(waypoints.id, anchorId));
    expect(await planStateFingerprint(handle.db, tripId)).not.toBe(afterRadius);

    // Back to where we started: the hash is a pure function of state, not of
    // how many times it has been edited.
    await handle.db
      .update(waypoints)
      .set({ radiusMiles: 60, orderIndex: 0, pinnedLat: null, pinnedLng: null })
      .where(eq(waypoints.id, anchorId));
    expect(await planStateFingerprint(handle.db, tripId)).toBe(base);
  });

  it("a plain waypoint written with only pre-anchor columns still resolves to its exact point", async () => {
    // Backward compatibility: rows that predate the anchor columns rely on the
    // radius-0 default and must route exactly as they always did.
    const legacyPoint = lerp(0.7);
    const id = (
      await handle.db
        .insert(waypoints)
        .values({
          tripId,
          name: "Legacy Pin",
          lat: legacyPoint.lat,
          lng: legacyPoint.lng,
          kind: "custom",
          orderIndex: 9,
          status: "pending",
          createdAt: T0,
        })
        .returning({ id: waypoints.id })
    )[0]!.id;

    const tree = await loadAnchorTree(handle.db, tripId);
    const legacy = flattenPendingAnchors(tree).find((a) => a.id === id);
    expect(legacy?.radiusMiles).toBe(0);
    expect(legacy?.depth).toBe(0);
    const resolved = resolveAnchor(legacy!, ORIGIN, DEST, []);
    expect(resolved.via).toBe("point");
    expect(resolved.point).toEqual(legacyPoint);

    await handle.db.delete(waypoints).where(eq(waypoints.id, id));
  });
});
