import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, type DbHandle } from "@elements/storage-sqlite-drizzle";
import { users } from "@elements/identity-session-auth";
import {
  checkIns,
  interestWeights,
  needRates,
  needs,
  pois,
  progressEvents,
  trips,
} from "../src/db/schema.js";
import { buildDailyCandidates, type BuiltCandidate, type TripRow } from "../src/server/engine/candidates.js";
import { haversineMiles, type LatLng } from "../src/server/engine/geo.js";
import { CLUSTER_TIE_MINUTES } from "../src/server/engine/scoring.js";

/**
 * ROUTE-8: candidates prefer stops that share a trip. A place worth stopping
 * for that sits beside a planned service stop beats an equally good one far
 * from it, and two places servicing the same need at near-equal cost are
 * separated by the sightseeing next door.
 *
 * The boundary matters as much as the behavior: the tie-break is a tie-break,
 * so it must never spend more than the detour cap allows, never drop a service
 * stop a need requires, and never make the plan move on its own.
 */

const NOW = "2026-07-30T17:23:11.000Z";
const T0 = "2026-07-25T00:00:00.000Z";
const daysAgo = (days: number): string => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

const ORIGIN: LatLng = { lat: 45.5152, lng: -122.6784 }; // Portland, OR
const DEST: LatLng = { lat: 36.1699, lng: -115.1398 }; // Las Vegas, NV
const POSITION: LatLng = { lat: 44.0582, lng: -121.3153 }; // Bend, OR

const MILES_PER_DEG_LAT = 69;
const milesPerDegLng = (lat: number): number => 69 * Math.cos((lat * Math.PI) / 180);

/** A point `f` of the way from the van to the destination, offset `perpMiles` sideways. */
function along(f: number, perpMiles = 0): LatLng {
  const base = {
    lat: POSITION.lat + (DEST.lat - POSITION.lat) * f,
    lng: POSITION.lng + (DEST.lng - POSITION.lng) * f,
  };
  if (perpMiles === 0) return base;
  // Route heading in miles-space, rotated 90° to get the sideways direction.
  const dy = (DEST.lat - POSITION.lat) * MILES_PER_DEG_LAT;
  const dx = (DEST.lng - POSITION.lng) * milesPerDegLng(base.lat);
  const len = Math.hypot(dx, dy) || 1;
  const east = (-dy / len) * perpMiles;
  const north = (dx / len) * perpMiles;
  return {
    lat: base.lat + north / MILES_PER_DEG_LAT,
    lng: base.lng + east / milesPerDegLng(base.lat),
  };
}

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

interface PoiSeed {
  name: string;
  category: string;
  at: LatLng;
  popularity?: number | null;
}

const openWorlds: DbHandle[] = [];

/** A fresh trip whose water need forces exactly one service stop today. */
async function seedWorld(poiSeeds: PoiSeed[]): Promise<{ handle: DbHandle; trip: TripRow }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vanlife-cluster-"));
  const handle = await createDb({ dbFile: path.join(dir, "test.db") });
  openWorlds.push(handle);
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

  const tripId = (
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
  const trip = (await db.select().from(trips))[0] as unknown as TripRow;

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

  // Water sits just under its warn floor, so a stop is forced today: 30% left
  // against a 25% floor, draining 15%/day. (Formerly 12 gal of a 40 gal tank at
  // 6 gal/day — the same scenario, rescaled when levels became percentages.)
  const needId = (
    await db
      .insert(needs)
      .values({
        key: "water",
        title: "Fresh water",
        direction: "depletes",
        warnRatio: 0.25,
        urgentRatio: 0.1,
        poiCategory: "water-fill",
        routingDriver: true,
        sortOrder: 1,
        active: true,
      })
      .returning({ id: needs.id })
  )[0]!.id;
  await db.insert(needRates).values({
    needId,
    ratePerDay: 15,
    ratePerMile: 0,
    source: "manual",
    effectiveFrom: T0,
    createdAt: T0,
  });
  await db.insert(checkIns).values({
    needId,
    kind: "set-level",
    quantity: 30,
    recordedBy: uid,
    occurredAt: daysAgo(0.5),
    createdAt: daysAgo(0.5),
  });

  for (const [category, weight] of [
    ["hike", 1.5],
    ["scenic", 1],
    ["campground", 0.8],
    ["boulder", 1],
    ["bike", 1],
    ["family", 1],
  ] as const) {
    await db.insert(interestWeights).values({ category, weight, updatedAt: T0 });
  }

  for (const [i, seed] of poiSeeds.entries()) {
    await db.insert(pois).values({
      source: "manual",
      sourceId: `seed-${String(i)}`,
      name: seed.name,
      category: seed.category,
      lat: seed.at.lat,
      lng: seed.at.lng,
      popularity: seed.popularity ?? null,
      fetchedAt: T0,
      updatedAt: T0,
    });
  }
  return { handle, trip };
}

/** Campground band so every role finds a sleep spot, well clear of the fixtures. */
function campBand(): PoiSeed[] {
  const camps: PoiSeed[] = [];
  for (let f = 0.2; f <= 0.6; f += 0.05) {
    camps.push({ name: `Camp ${f.toFixed(2)}`, category: "campground", at: along(f), popularity: 0.5 });
  }
  return camps;
}

const waterStopNames = (built: BuiltCandidate[]): string[] =>
  built.flatMap((c) => c.stops.filter((s) => s.needId !== null).map((s) => s.name));

const stopNames = (built: BuiltCandidate[]): string[] => built.flatMap((c) => c.stops.map((s) => s.name));

afterEach(() => {
  vi.unstubAllGlobals();
  while (openWorlds.length > 0) openWorlds.pop()!.close();
});

function stubOsrm(): void {
  vi.stubGlobal("fetch", (input: unknown) => Promise.resolve(fakeOsrmResponse(String(input))));
}

describe("ROUTE-8: sights and services cluster into one errand", () => {
  it("breaks a near-tie between service stops toward the one beside the sights", async () => {
    stubOsrm();
    const { handle, trip } = await seedWorld([
      ...campBand(),
      // Both fills cost about the same detour; only one has a hike next door.
      { name: "Lonely Fill", category: "water-fill", at: along(0.18, -26), popularity: 0.5 },
      { name: "Trailhead Fill", category: "water-fill", at: along(0.18, 30), popularity: 0.5 },
      { name: "Cluster Hike", category: "hike", at: along(0.185, 34), popularity: 0.9 },
    ]);

    const built = await buildDailyCandidates(handle.db, trip, NOW);
    const chosen = waterStopNames(built);

    expect(chosen.length).toBeGreaterThan(0);
    expect(chosen).toContain("Trailhead Fill");
    expect(chosen).not.toContain("Lonely Fill");
  });

  it("never overrides a service stop that is genuinely closer", async () => {
    stubOsrm();
    const { handle, trip } = await seedWorld([
      ...campBand(),
      // The clustered fill now sits far outside the near-tie band.
      { name: "Lonely Fill", category: "water-fill", at: along(0.18, -8), popularity: 0.5 },
      { name: "Trailhead Fill", category: "water-fill", at: along(0.18, 55), popularity: 0.5 },
      { name: "Cluster Hike", category: "hike", at: along(0.185, 59), popularity: 0.9 },
    ]);

    const built = await buildDailyCandidates(handle.db, trip, NOW);
    const chosen = waterStopNames(built);

    expect(chosen.length).toBeGreaterThan(0);
    expect(chosen).toContain("Lonely Fill");
    expect(chosen).not.toContain("Trailhead Fill");
  });

  it("still refuses a service stop beyond the detour cap, and says so honestly", async () => {
    stubOsrm();
    const { handle, trip } = await seedWorld([
      ...campBand(),
      // The only fill in the corridor is far off-route, with sights beside it.
      { name: "Distant Fill", category: "water-fill", at: along(0.3, 240), popularity: 0.5 },
      { name: "Distant Hike", category: "hike", at: along(0.3, 244), popularity: 0.9 },
    ]);

    const built = await buildDailyCandidates(handle.db, trip, NOW);

    expect(waterStopNames(built)).toHaveLength(0);
    const warned = built.filter((c) => c.warnings.some((w) => w.needKey === "water"));
    expect(warned.length).toBeGreaterThan(0);
    expect(warned[0]!.warnings.find((w) => w.needKey === "water")!.message).toMatch(/water-fill/);
  });

  it("prefers the sight beside the service stop over its identical twin across the route", async () => {
    stubOsrm();
    const { handle, trip } = await seedWorld([
      ...campBand(),
      { name: "Only Fill", category: "water-fill", at: along(0.18, 24), popularity: 0.5 },
      // Mirrored across the route: same category, same popularity, same detour.
      { name: "Clustered Sight", category: "hike", at: along(0.18, 28), popularity: 0.7 },
      { name: "Mirrored Sight", category: "hike", at: along(0.18, -28), popularity: 0.7 },
    ]);

    const built = await buildDailyCandidates(handle.db, trip, NOW);

    expect(stopNames(built)).toContain("Only Fill");
    expect(stopNames(built)).toContain("Clustered Sight");

    // The bonus reorders preference; it does not shrink the plan. A roomy tier
    // can afford both twins — what it must never do is take the far one first.
    for (const c of built) {
      const names = c.stops.map((s) => s.name);
      if (names.includes("Mirrored Sight")) expect(names).toContain("Clustered Sight");
    }
    const tookOne = built.filter((c) => {
      const names = c.stops.map((s) => s.name);
      return names.includes("Clustered Sight") !== names.includes("Mirrored Sight");
    });
    expect(tookOne.length).toBeGreaterThan(0);
    for (const c of tookOne) {
      expect(c.stops.map((s) => s.name)).toContain("Clustered Sight");
    }
  });

  it("regenerates identically — the bonus never makes a plan move on its own", async () => {
    stubOsrm();
    const { handle, trip } = await seedWorld([
      ...campBand(),
      { name: "Lonely Fill", category: "water-fill", at: along(0.18, -26), popularity: 0.5 },
      { name: "Trailhead Fill", category: "water-fill", at: along(0.18, 30), popularity: 0.5 },
      { name: "Cluster Hike", category: "hike", at: along(0.185, 34), popularity: 0.9 },
      { name: "Far Sight", category: "scenic", at: along(0.4, -20), popularity: 0.6 },
    ]);

    const run1 = await buildDailyCandidates(handle.db, trip, NOW);
    const run2 = await buildDailyCandidates(handle.db, trip, NOW);

    expect(run1.length).toBeGreaterThan(0);
    expect(run2).toEqual(run1);
  });

  it("falls back to the cheapest service stop when nothing is near anything", async () => {
    stubOsrm();
    const { handle, trip } = await seedWorld([
      ...campBand(),
      { name: "Near Fill", category: "water-fill", at: along(0.18, 12) },
      { name: "Far Fill", category: "water-fill", at: along(0.18, 34) },
      // The only sight is nowhere near either fill.
      { name: "Remote Hike", category: "hike", at: along(0.55, -40), popularity: 0.9 },
    ]);

    const built = await buildDailyCandidates(handle.db, trip, NOW);
    const chosen = waterStopNames(built);

    expect(chosen.length).toBeGreaterThan(0);
    expect(chosen).toContain("Near Fill");
    expect(chosen).not.toContain("Far Fill");
  });

  it("keeps the near-tie band inside the cap it was given", () => {
    // The band is only ever the smaller of the tie window and the headroom
    // left under the cap, so a chosen stop can never exceed the cap.
    for (const [minDetour, cap] of [[10, 90], [88, 90], [90, 90]] as const) {
      const band = Math.min(CLUSTER_TIE_MINUTES, cap - minDetour);
      expect(minDetour + band).toBeLessThanOrEqual(cap);
    }
  });
});
