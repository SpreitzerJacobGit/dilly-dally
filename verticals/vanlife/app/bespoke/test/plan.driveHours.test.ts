/**
 * ROUTE-9: how many hours today is planned around.
 *
 * The trip has a pace; a single day can override it. The assertions that matter
 * are the boundaries — the override reaches the day leg, it does NOT reach the
 * trip row or tomorrow, and it DOES move the plan fingerprint, because an
 * override that left the fingerprint alone would be quietly ignored by replan
 * for the rest of the day (ROUTE-5 would serve the plan built at the old pace).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "@elements/storage-sqlite-drizzle";
import { createDb, type DbHandle } from "@elements/storage-sqlite-drizzle";
import { users } from "@elements/identity-session-auth";
import { progressEvents, trips } from "../src/db/schema.js";
import {
  buildDailyCandidates,
  dayDriveHours,
  planDateOf,
  planStateFingerprint,
  setDayDriveHours,
  type BuiltCandidate,
  type TripRow,
} from "../src/server/engine/candidates.js";
import {
  anchorHorizons,
  type AnchorNode,
  type ResolvedAnchor,
} from "../src/server/engine/anchors.js";
import { haversineMiles, type LatLng } from "../src/server/engine/geo.js";

const NOW = "2026-07-30T17:23:11.000Z";
const T0 = "2026-07-25T00:00:00.000Z";
const TODAY = planDateOf(NOW);
const TOMORROW = planDateOf(new Date(Date.parse(NOW) + 86_400_000).toISOString());

const ORIGIN: LatLng = { lat: 45.5152, lng: -122.6784 }; // Portland, OR
const DEST: LatLng = { lat: 36.1699, lng: -115.1398 }; // Las Vegas, NV
const POSITION: LatLng = { lat: 44.0582, lng: -121.3153 }; // Bend, OR

let handle: DbHandle;
let trip: TripRow;

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

async function migrate(h: DbHandle): Promise<void> {
  const md = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
  for (const f of fs.readdirSync(md).filter((x) => x.endsWith(".sql")).sort())
    for (const s of fs.readFileSync(path.join(md, f), "utf8").split("--> statement-breakpoint"))
      if (s.trim()) await h.client.execute(s);
}

/** The direct-tier leg, which is the one paced straight off the day's hours. */
const directLeg = (built: BuiltCandidate[]): BuiltCandidate =>
  built.find((c) => c.tier === "direct")!;

beforeEach(async () => {
  vi.stubGlobal("fetch", (input: unknown) => Promise.resolve(fakeOsrmResponse(String(input))));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vl-drive-hours-"));
  handle = await createDb({ dbFile: path.join(dir, "t.db") });
  await migrate(handle);

  const uid = (
    await handle.db
      .insert(users)
      .values({ email: "test@example.com", passwordHash: "x", role: "operator", createdAt: T0 })
      .returning({ id: users.id })
  )[0]!.id;

  const tripId = (
    await handle.db
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
        deviationBudgetRatio: 4,
        dailyDriveHours: 4,
        createdAt: T0,
        updatedAt: T0,
      })
      .returning({ id: trips.id })
  )[0]!.id;
  trip = (await handle.db.select().from(trips).where(eq(trips.id, tripId)))[0] as unknown as TripRow;

  await handle.db.insert(progressEvents).values({
    tripId,
    kind: "position-set",
    lat: POSITION.lat,
    lng: POSITION.lng,
    milesDriven: 160,
    driveSeconds: (160 / 45) * 3600,
    recordedBy: uid,
    occurredAt: new Date(Date.parse(NOW) - 86_400_000).toISOString(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  handle.close();
});

describe("today's drive-hours override", () => {
  it("defaults to the trip's pace, and reports it as no override", async () => {
    expect(await dayDriveHours(handle.db, trip, TODAY)).toEqual({
      effective: 4,
      override: null,
      tripHours: 4,
    });
  });

  it("paces the day's legs, so a longer day drives proportionally further", async () => {
    const atFour = directLeg(await buildDailyCandidates(handle.db, trip, NOW));

    await setDayDriveHours(handle.db, trip.id, TODAY, 8);
    const atEight = directLeg(await buildDailyCandidates(handle.db, trip, NOW));

    // Doubling the hours doubles the drive; allow slack for the routed repair.
    expect(atEight.durationMinutes).toBeGreaterThan(atFour.durationMinutes * 1.8);
    expect(atEight.distanceMiles).toBeGreaterThan(atFour.distanceMiles * 1.8);
  });

  it("reverts exactly when cleared — the trip's pace was never touched", async () => {
    const before = directLeg(await buildDailyCandidates(handle.db, trip, NOW));

    await setDayDriveHours(handle.db, trip.id, TODAY, 9);
    await setDayDriveHours(handle.db, trip.id, TODAY, null);
    const after = directLeg(await buildDailyCandidates(handle.db, trip, NOW));

    expect(after.durationMinutes).toBe(before.durationMinutes);
    expect((await handle.db.select().from(trips).where(eq(trips.id, trip.id)))[0]!.dailyDriveHours).toBe(4);
  });

  it("is today's alone — tomorrow is still the trip's pace", async () => {
    await setDayDriveHours(handle.db, trip.id, TODAY, 10);

    expect((await dayDriveHours(handle.db, trip, TODAY)).effective).toBe(10);
    expect(await dayDriveHours(handle.db, trip, TOMORROW)).toEqual({
      effective: 4,
      override: null,
      tripHours: 4,
    });
  });

  it("leaves every Target's expected arrival alone", async () => {
    // Pacing is derived from the trip's pace, so it must be reachable only from
    // the trip row — one long day cannot re-time the horizons of the whole trip.
    const reno: LatLng = { lat: 39.5296, lng: -119.8138 };
    const resolved: ResolvedAnchor[] = [
      {
        anchorId: 1,
        name: "Reno",
        point: reno,
        radiusMiles: 0,
        via: "point",
        poiId: null,
        poiName: null,
        detourMinutes: 0,
      },
    ];
    const anchors: AnchorNode[] = [
      {
        id: 1,
        parentId: null,
        name: "Reno",
        kind: "waypoint",
        center: reno,
        radiusMiles: 0,
        orderIndex: 0,
        depth: 0,
        status: "pending",
        pinned: null,
        pinnedPoiId: null,
        arriveBy: null,
        children: [],
      },
    ];
    const pacing = () =>
      anchorHorizons(resolved, anchors, {
        start: POSITION,
        // Read the way targets.ts reads it: off the trip, never off the day.
        dailyDriveHours: trip.dailyDriveHours,
        now: NOW,
      });

    const before = pacing();
    await setDayDriveHours(handle.db, trip.id, TODAY, 12);
    const freshTrip = (await handle.db.select().from(trips).where(eq(trips.id, trip.id)))[0]!;
    expect(freshTrip.dailyDriveHours).toBe(4);
    expect(pacing()).toEqual(before);
  });
});

describe("the plan fingerprint (ROUTE-5)", () => {
  it("moves when today's hours change, so replan rebuilds instead of serving the old pace", async () => {
    const before = await planStateFingerprint(handle.db, trip.id, TODAY);
    await setDayDriveHours(handle.db, trip.id, TODAY, 7);
    expect(await planStateFingerprint(handle.db, trip.id, TODAY)).not.toBe(before);
  });

  it("is stable when the hours do not change", async () => {
    await setDayDriveHours(handle.db, trip.id, TODAY, 7);
    const a = await planStateFingerprint(handle.db, trip.id, TODAY);
    expect(await planStateFingerprint(handle.db, trip.id, TODAY)).toBe(a);
  });

  it("does not let today's override disturb tomorrow's fingerprint", async () => {
    const before = await planStateFingerprint(handle.db, trip.id, TOMORROW);
    await setDayDriveHours(handle.db, trip.id, TODAY, 7);
    expect(await planStateFingerprint(handle.db, trip.id, TOMORROW)).toBe(before);
  });
});
