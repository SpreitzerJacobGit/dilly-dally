import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, type DbHandle } from "@elements/storage-sqlite-drizzle";
import { users } from "@elements/identity-session-auth";
import {
  checkIns,
  daySelections,
  interestWeights,
  needRates,
  needs,
  poiMarks,
  pois,
  progressEvents,
  routeCandidates,
  trips,
} from "../src/db/schema.js";
import {
  buildDailyCandidates,
  persistCandidates,
  planDateOf,
  type TripRow,
} from "../src/server/engine/candidates.js";
import { haversineMiles, pointToLineMiles, type LatLng, type LineCoords } from "../src/server/engine/geo.js";
import { needFacilityOptions } from "../src/server/engine/needSearch.js";

/**
 * NEED-6 / OFF-3: tapping a need lists the places that can service it, ranked
 * by distance from the van and by minutes added to today's route — drawn from
 * the local catalog, so it answers with no uplink, and honest about whether
 * the added-time figures are routed or estimated.
 */

const NOW = "2026-07-30T17:23:11.000Z";
const T0 = "2026-07-25T00:00:00.000Z";
const daysAgo = (days: number): string => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

const ORIGIN: LatLng = { lat: 45.5152, lng: -122.6784 };
const DEST: LatLng = { lat: 36.1699, lng: -115.1398 };
const POSITION: LatLng = { lat: 44.0582, lng: -121.3153 };

const MILES_PER_DEG_LAT = 69;
const milesPerDegLng = (lat: number): number => 69 * Math.cos((lat * Math.PI) / 180);

function along(f: number, perpMiles = 0): LatLng {
  const base = {
    lat: POSITION.lat + (DEST.lat - POSITION.lat) * f,
    lng: POSITION.lng + (DEST.lng - POSITION.lng) * f,
  };
  if (perpMiles === 0) return base;
  const dy = (DEST.lat - POSITION.lat) * MILES_PER_DEG_LAT;
  const dx = (DEST.lng - POSITION.lng) * milesPerDegLng(base.lat);
  const len = Math.hypot(dx, dy) || 1;
  return {
    lat: base.lat + ((dx / len) * perpMiles) / MILES_PER_DEG_LAT,
    lng: base.lng + ((-dy / len) * perpMiles) / milesPerDegLng(base.lat),
  };
}

/** Fake OSRM answering both /route and /table, at a constant 45 mph. */
function fakeOsrm(url: string): Response {
  const parse = (raw: string): LatLng[] =>
    raw.split(";").map((pair) => {
      const [lng, lat] = pair.split(",").map(Number);
      return { lat: lat!, lng: lng! };
    });

  const table = /\/table\/v1\/driving\/([^?]+)/.exec(url);
  if (table) {
    const coords = parse(table[1]!);
    const durations = coords.map((a) => coords.map((b) => (haversineMiles(a, b) / 45) * 3600));
    const distances = coords.map((a) => coords.map((b) => haversineMiles(a, b) * 1609.34));
    return new Response(JSON.stringify({ code: "Ok", durations, distances }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const route = /\/route\/v1\/driving\/([^?]+)/.exec(url);
  if (!route) return new Response("not found", { status: 404 });
  const coords = parse(route[1]!);
  const legs = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const miles = haversineMiles(coords[i]!, coords[i + 1]!);
    legs.push({ duration: (miles / 45) * 3600, distance: miles * 1609.34 });
  }
  return new Response(
    JSON.stringify({
      code: "Ok",
      routes: [
        {
          duration: legs.reduce((s, l) => s + l.duration, 0),
          distance: legs.reduce((s, l) => s + l.distance, 0),
          geometry: { coordinates: coords.map((c) => [c.lng, c.lat]) },
          legs,
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

interface PoiSeed {
  name: string;
  category: string;
  at: LatLng;
  popularity?: number | null;
}

const openWorlds: DbHandle[] = [];

async function seedWorld(poiSeeds: PoiSeed[]): Promise<{
  handle: DbHandle;
  trip: TripRow;
  needId: number;
  poiIdByName: Map<string, number>;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vanlife-needsearch-"));
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

  const needId = (
    await db
      .insert(needs)
      .values({
        key: "water",
        title: "Fresh water",
        unit: "gal",
        capacity: 40,
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
    ratePerDay: 6,
    ratePerMile: 0,
    source: "manual",
    effectiveFrom: T0,
    createdAt: T0,
  });
  await db.insert(checkIns).values({
    needId,
    kind: "set-level",
    quantity: 12,
    recordedBy: uid,
    occurredAt: daysAgo(0.5),
    createdAt: daysAgo(0.5),
  });
  // A checklist-only concern, to prove it never lists places (NEED-5).
  await db.insert(needs).values({
    key: "internet",
    title: "Work internet",
    unit: "bars",
    capacity: 5,
    direction: "depletes",
    warnRatio: 0.25,
    urgentRatio: 0.1,
    poiCategory: null,
    routingDriver: false,
    sortOrder: 2,
    active: true,
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

  const poiIdByName = new Map<string, number>();
  for (const [i, seed] of poiSeeds.entries()) {
    const id = (
      await db
        .insert(pois)
        .values({
          source: "manual",
          sourceId: `seed-${String(i)}`,
          name: seed.name,
          category: seed.category,
          lat: seed.at.lat,
          lng: seed.at.lng,
          popularity: seed.popularity ?? null,
          url: `https://example.test/${String(i)}`,
          fetchedAt: T0,
          updatedAt: T0,
        })
        .returning({ id: pois.id })
    )[0]!.id;
    poiIdByName.set(seed.name, id);
  }
  return { handle, trip, needId, poiIdByName };
}

function campBand(): PoiSeed[] {
  const camps: PoiSeed[] = [];
  for (let f = 0.2; f <= 0.6; f += 0.05) {
    camps.push({ name: `Camp ${f.toFixed(2)}`, category: "campground", at: along(f), popularity: 0.5 });
  }
  return camps;
}

/** Build today's candidates, persist them, and select the first. */
async function selectTodaysPlan(handle: DbHandle, trip: TripRow): Promise<number> {
  const built = await buildDailyCandidates(handle.db, trip, NOW);
  const planDate = planDateOf(NOW);
  await persistCandidates(handle.db, trip.id, planDate, built);
  const rows = await handle.db.select().from(routeCandidates);
  const chosen = rows[0]!;
  const uid = (await handle.db.select().from(users))[0]!.id;
  await handle.db.insert(daySelections).values({
    tripId: trip.id,
    planDate,
    candidateId: chosen.id,
    selectedBy: uid,
    selectedAt: NOW,
  });
  return chosen.id;
}

const stubOsrm = (): void => {
  vi.stubGlobal("fetch", (input: unknown) => Promise.resolve(fakeOsrm(String(input))));
};

afterEach(() => {
  vi.unstubAllGlobals();
  while (openWorlds.length > 0) openWorlds.pop()!.close();
});

describe("pointToLineMiles", () => {
  const line: LineCoords = [
    [-121.0, 44.0],
    [-120.0, 44.0],
    [-120.0, 43.0],
  ];

  it("is zero on a vertex and along a segment", () => {
    expect(pointToLineMiles({ lat: 44.0, lng: -121.0 }, line)).toBeCloseTo(0, 6);
    expect(pointToLineMiles({ lat: 44.0, lng: -120.5 }, line)).toBeLessThan(0.01);
  });

  it("matches the haversine truth for a known perpendicular offset", () => {
    const p = { lat: 44.2, lng: -120.5 };
    const truth = haversineMiles(p, { lat: 44.0, lng: -120.5 });
    const measured = pointToLineMiles(p, line);
    expect(Math.abs(measured - truth) / truth).toBeLessThan(0.01);
  });

  it("is Infinity for a line with no segments — no route is not zero miles away", () => {
    expect(pointToLineMiles({ lat: 44, lng: -121 }, [])).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("NEED-6: places that can service a need", () => {
  const fills: PoiSeed[] = [
    { name: "On-Route Fill", category: "water-fill", at: along(0.2, 3), popularity: 0.5 },
    { name: "Sideways Fill", category: "water-fill", at: along(0.2, 35), popularity: 0.5 },
    { name: "Rejected Fill", category: "water-fill", at: along(0.2, 5), popularity: 0.9 },
    { name: "Far Away Fill", category: "water-fill", at: along(0.95, 5), popularity: 0.9 },
    { name: "Not A Fill", category: "grocery", at: along(0.2, 4), popularity: 0.9 },
  ];

  it("ranks by real routed detour, flags pinned and planned stops, and drops rejects", async () => {
    stubOsrm();
    const { handle, trip, needId, poiIdByName } = await seedWorld([...campBand(), ...fills]);
    const candidateId = await selectTodaysPlan(handle, trip);
    await handle.db.insert(poiMarks).values([
      { tripId: trip.id, poiId: poiIdByName.get("Rejected Fill")!, mark: "rejected", createdAt: T0 },
      { tripId: trip.id, poiId: poiIdByName.get("Sideways Fill")!, mark: "pinned", createdAt: T0 },
    ]);

    const result = await needFacilityOptions(handle.db, {
      trip,
      needId,
      nowIso: NOW,
      candidateId,
      radiusMiles: 60,
      limit: 20,
    });

    expect(result.detourSource).toBe("routed");
    expect(result.message).toBeNull();
    expect(result.candidateId).toBe(candidateId);
    expect(result.poiCategory).toBe("water-fill");

    const names = result.options.map((o) => o.name);
    expect(names).toContain("On-Route Fill");
    expect(names).toContain("Sideways Fill");
    // A rejected place never reappears in suggestions for this trip (POI-4).
    expect(names).not.toContain("Rejected Fill");
    // Only places whose category services the need.
    expect(names).not.toContain("Not A Fill");
    // Outside the radius from both the van and the route.
    expect(names).not.toContain("Far Away Fill");

    // Ranked by added minutes, ties broken on id — never on scan order.
    const detours = result.options.map((o) => o.detourMinutes!);
    expect(detours).toEqual([...detours].sort((a, b) => a - b));
    expect(names.indexOf("On-Route Fill")).toBeLessThan(names.indexOf("Sideways Fill"));

    const sideways = result.options.find((o) => o.name === "Sideways Fill")!;
    expect(sideways.pinned).toBe(true);
    expect(sideways.milesFromRoute).not.toBeNull();
    expect(sideways.url).toMatch(/^https:\/\//);
    expect(result.options.find((o) => o.name === "On-Route Fill")!.pinned).toBe(false);

    // A place the plan already stops at is called out rather than re-offered blindly.
    const planned = result.options.filter((o) => o.plannedToday);
    for (const p of planned) expect(p.detourMinutes).toBeLessThanOrEqual(sideways.detourMinutes!);
  });

  it("still lists places, ranked, when route computation is unavailable (OFF-3)", async () => {
    stubOsrm();
    const { handle, trip, needId } = await seedWorld([...campBand(), ...fills]);
    const candidateId = await selectTodaysPlan(handle, trip);

    // The uplink dies after the plan was built.
    vi.stubGlobal("fetch", () => Promise.reject(new Error("network down")));

    const result = await needFacilityOptions(handle.db, {
      trip,
      needId,
      nowIso: NOW,
      candidateId,
      radiusMiles: 60,
      limit: 20,
    });

    expect(result.options.length).toBeGreaterThan(0);
    expect(result.detourSource).toBe("estimated");
    expect(result.message).toMatch(/estimate/i);
    for (const o of result.options) expect(o.detourMinutes).not.toBeNull();
    const detours = result.options.map((o) => o.detourMinutes!);
    expect(detours).toEqual([...detours].sort((a, b) => a - b));
  });

  it("falls back to distance from the van when no route has been picked", async () => {
    stubOsrm();
    // With no route there is no corridor — only what is near the van itself,
    // which is why this fixture needs a fill inside the radius.
    const { handle, trip, needId } = await seedWorld([
      ...campBand(),
      ...fills,
      { name: "Nearby Fill", category: "water-fill", at: along(0.04, 2), popularity: 0.5 },
      { name: "Just Outside Fill", category: "water-fill", at: along(0.2, 3), popularity: 0.5 },
    ]);

    const result = await needFacilityOptions(handle.db, {
      trip,
      needId,
      nowIso: NOW,
      radiusMiles: 60,
      limit: 20,
    });

    expect(result.candidateId).toBeNull();
    expect(result.detourSource).toBe("none");
    expect(result.message).toMatch(/No route picked/i);
    expect(result.options.map((o) => o.name)).toContain("Nearby Fill");
    // Places down the corridor are not "nearby" when there is no route to be on.
    expect(result.options.map((o) => o.name)).not.toContain("Just Outside Fill");
    for (const o of result.options) expect(o.milesFromHere).toBeLessThanOrEqual(60);
    for (const o of result.options) {
      expect(o.detourMinutes).toBeNull();
      expect(o.milesFromRoute).toBeNull();
    }
    const miles = result.options.map((o) => o.milesFromHere);
    expect(miles).toEqual([...miles].sort((a, b) => a - b));
  });

  it("never lists places for a checklist-only concern (NEED-5)", async () => {
    stubOsrm();
    const { handle, trip } = await seedWorld([...campBand(), ...fills]);
    const internet = (await handle.db.select().from(needs)).find((n) => n.key === "internet")!;

    const result = await needFacilityOptions(handle.db, {
      trip,
      needId: internet.id,
      nowIso: NOW,
      radiusMiles: 60,
      limit: 20,
    });

    expect(result.options).toHaveLength(0);
    expect(result.poiCategory).toBeNull();
    expect(result.message).toMatch(/checklist/i);
  });

  it("honors the limit and returns the same answer twice", async () => {
    stubOsrm();
    const { handle, trip, needId } = await seedWorld([...campBand(), ...fills]);
    const candidateId = await selectTodaysPlan(handle, trip);
    const args = { trip, needId, nowIso: NOW, candidateId, radiusMiles: 60, limit: 2 };

    const first = await needFacilityOptions(handle.db, args);
    const second = await needFacilityOptions(handle.db, args);

    expect(first.options.length).toBeLessThanOrEqual(2);
    expect(second).toEqual(first);
  });
});
