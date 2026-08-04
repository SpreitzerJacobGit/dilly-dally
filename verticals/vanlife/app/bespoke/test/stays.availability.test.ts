import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, createDb, eq, type Db, type DbHandle } from "@elements/storage-sqlite-drizzle";
import { users } from "@elements/identity-session-auth";
import {
  pois,
  progressEvents,
  stayAvailability,
  staySites,
  stayWeights,
  trips,
} from "../src/db/schema.js";
import {
  buildDailyCandidates,
  persistCandidates,
  planDateOf,
  planStateFingerprint,
  type TripRow,
} from "../src/server/engine/candidates.js";
import { haversineMiles, type LatLng } from "../src/server/engine/geo.js";
import {
  refreshStayAvailability,
  type AvailabilityChecker,
} from "../src/server/engine/stayAvailability.js";

/**
 * Availability is the one live thing in an offline-first planner, and the whole
 * risk is that it quietly turns replanning into a network call and every poll
 * into a reshuffle. These tests pin the two rules that prevent that: an
 * unchanged answer must not move the plan fingerprint, and a failed check must
 * not overwrite what we already knew.
 */

const NOW = "2026-07-30T17:00:00.000Z";
const T0 = "2026-07-25T00:00:00.000Z";
const POSITION: LatLng = { lat: 44.0582, lng: -121.3153 };
const DEST: LatLng = { lat: 36.1699, lng: -115.1398 };
const lerp = (f: number): LatLng => ({
  lat: POSITION.lat + (DEST.lat - POSITION.lat) * f,
  lng: POSITION.lng + (DEST.lng - POSITION.lng) * f,
});
const MPH = 45;

function fakeOsrm(url: string): Response {
  const parse = (s: string): LatLng[] =>
    s.split(";").map((pair) => {
      const [lng, lat] = pair.split(",").map(Number);
      return { lat: lat!, lng: lng! };
    });
  const json = (b: unknown): Response =>
    new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  const table = /\/table\/v1\/driving\/([^?]+)\?(.*)$/.exec(url);
  if (table) {
    const coords = parse(table[1]!);
    const params = new URLSearchParams(table[2]!);
    const idx = (k: string): number[] => {
      const raw = params.get(k);
      return raw === null ? coords.map((_, i) => i) : raw.split(";").map(Number);
    };
    const s = idx("sources");
    const d = idx("destinations");
    return json({
      code: "Ok",
      durations: s.map((a) => d.map((b) => (haversineMiles(coords[a]!, coords[b]!) / MPH) * 3600)),
      distances: s.map((a) => d.map((b) => haversineMiles(coords[a]!, coords[b]!) * 1609.34)),
    });
  }
  const route = /\/route\/v1\/driving\/([^?]+)/.exec(url);
  if (!route) return new Response("not found", { status: 404 });
  const coords = parse(route[1]!);
  const legs = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const miles = haversineMiles(coords[i]!, coords[i + 1]!);
    legs.push({ duration: (miles / MPH) * 3600, distance: miles * 1609.34 });
  }
  return json({
    code: "Ok",
    routes: [
      {
        duration: legs.reduce((x, l) => x + l.duration, 0),
        distance: legs.reduce((x, l) => x + l.distance, 0),
        geometry: { coordinates: coords.map((c) => [c.lng, c.lat]) },
        legs,
      },
    ],
  });
}

let handle: DbHandle;
let db: Db;
let trip: TripRow;
let tripId: number;
let campPoiId: number;
const planDate = planDateOf(NOW);

/** A checker whose answer the test controls, so nothing here touches a network. */
function checkerReturning(answer: { state: "available" | "full"; detail: string | null } | null): AvailabilityChecker {
  return { source: "recgov", check: () => Promise.resolve(answer) };
}

const throwingChecker: AvailabilityChecker = {
  source: "recgov",
  check: () => Promise.reject(new Error("recreation.gov responded 503")),
};

beforeAll(async () => {
  vi.stubGlobal("fetch", (input: unknown) => Promise.resolve(fakeOsrm(String(input))));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vanlife-avail-"));
  handle = await createDb({ dbFile: path.join(dir, "test.db") });
  const migrationsDir = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      if (stmt.trim().length > 0) await handle.client.execute(stmt);
    }
  }
  db = handle.db;

  const uid = (
    await db
      .insert(users)
      .values({ email: "avail@example.com", passwordHash: "x", role: "operator", createdAt: T0 })
      .returning({ id: users.id })
  )[0]!.id;

  tripId = (
    await db
      .insert(trips)
      .values({
        name: "Portland to Vegas",
        status: "active",
        originName: "Portland, OR",
        originLat: 45.5152,
        originLng: -122.6784,
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
    milesDriven: 0,
    driveSeconds: 0,
    recordedBy: uid,
    occurredAt: T0,
  });

  const seeds = [
    { name: "Reservable Camp", f: 0.42, reservable: "required" },
    { name: "Walk Up Camp", f: 0.425, reservable: "none" },
  ];
  for (const [i, s] of seeds.entries()) {
    const p = lerp(s.f);
    const id = (
      await db
        .insert(pois)
        .values({
          source: "recgov",
          sourceId: `camp-${String(i)}`,
          name: s.name,
          category: "campground",
          lat: p.lat,
          lng: p.lng,
          popularity: 0.5,
          fetchedAt: T0,
          updatedAt: T0,
        })
        .returning({ id: pois.id })
    )[0]!.id;
    if (s.name === "Reservable Camp") campPoiId = id;
    await db.insert(staySites).values({
      poiId: id,
      stayKind: "campground",
      nightlyCostUsd: 25,
      reservable: s.reservable,
      access: "van-ok",
      confidence: "verified",
      lastReportedAt: T0,
      updatedAt: T0,
    });
  }

  // A persisted plan, because the availability job asks only about the stays
  // today's candidates actually shortlisted.
  const built = await buildDailyCandidates(db, trip, NOW);
  await persistCandidates(db, tripId, planDate, built);
});

afterAll(() => {
  vi.unstubAllGlobals();
  handle.close();
});

const row = async () =>
  (
    await db
      .select()
      .from(stayAvailability)
      .where(and(eq(stayAvailability.poiId, campPoiId), eq(stayAvailability.forDate, planDate)))
  )[0];

describe("the availability job", () => {
  it("records nothing at all when no source is configured", async () => {
    expect(await refreshStayAvailability(db, NOW, [])).toBe("skipped");
    expect(await row()).toBeUndefined();
  });

  it("only asks about stays that can be reserved", async () => {
    const asked: number[] = [];
    await refreshStayAvailability(db, NOW, [
      {
        source: "recgov",
        check: ({ poiId }) => {
          asked.push(poiId);
          return Promise.resolve({ state: "available" as const, detail: "3 of 40 sites free" });
        },
      },
    ]);
    // The walk-up site has no availability to report; asking would manufacture a fact.
    const walkUp = (await db.select().from(pois).where(eq(pois.name, "Walk Up Camp")))[0]!;
    expect(asked).toContain(campPoiId);
    expect(asked).not.toContain(walkUp.id);
  });

  it("an unchanged answer bumps fetchedAt, leaves updatedAt, and does not replan", async () => {
    const before = (await row())!;
    const fingerprintBefore = await planStateFingerprint(db, tripId, planDate);

    await new Promise((r) => setTimeout(r, 5));
    await refreshStayAvailability(db, NOW, [checkerReturning({ state: "available", detail: "3 of 40 sites free" })]);

    const after = (await row())!;
    expect(after.state).toBe("available");
    expect(Date.parse(after.fetchedAt)).toBeGreaterThan(Date.parse(before.fetchedAt));
    // The fingerprint reads MAX(updated_at) — this is the whole reason a
    // three-hourly poll does not rebuild an unchanged day every three hours.
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(await planStateFingerprint(db, tripId, planDate)).toBe(fingerprintBefore);
  });

  it("a genuinely different answer does move the plan", async () => {
    const fingerprintBefore = await planStateFingerprint(db, tripId, planDate);
    await new Promise((r) => setTimeout(r, 5));
    await refreshStayAvailability(db, NOW, [checkerReturning({ state: "full", detail: "0 of 40 sites free" })]);

    const after = (await row())!;
    expect(after.state).toBe("full");
    expect(await planStateFingerprint(db, tripId, planDate)).not.toBe(fingerprintBefore);
  });

  it("a failed check records the error without overwriting what we knew", async () => {
    const before = (await row())!;
    const result = await refreshStayAvailability(db, NOW, [throwingChecker]);
    expect(result).not.toBe("skipped");
    expect((result as { failed: number }).failed).toBeGreaterThan(0);

    const after = (await row())!;
    // Losing signal in a canyon is not evidence that a campground emptied out.
    expect(after.state).toBe(before.state);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.lastError).toContain("503");
  });

  it("a site reported full is ruled out of tonight, with the reason", async () => {
    const built = await buildDailyCandidates(db, trip, NOW);
    const option = built[0]!.stayOptions.find((s) => s.poiId === campPoiId);
    expect(option?.excludedReason).toBe("reported full for tonight");
    // And it is genuinely not where we are being sent.
    const last = built[0]!.stops[built[0]!.stops.length - 1]!;
    expect(last.poiId).not.toBe(campPoiId);
  });
});

describe("weights are part of the plan's state", () => {
  it("moving a stay slider replans, and moving it back restores the hash", async () => {
    const base = await planStateFingerprint(db, tripId, planDate);
    const inserted = (
      await db
        .insert(stayWeights)
        .values({ tripId, factor: "cost", weight: 2.5, updatedAt: T0 })
        .returning({ id: stayWeights.id })
    )[0]!;
    expect(await planStateFingerprint(db, tripId, planDate)).not.toBe(base);

    await db.delete(stayWeights).where(eq(stayWeights.id, inserted.id));
    // A pure function of state, not of how many times it was edited.
    expect(await planStateFingerprint(db, tripId, planDate)).toBe(base);
  });
});
