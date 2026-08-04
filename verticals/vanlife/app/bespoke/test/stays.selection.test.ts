import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, eq, type Db, type DbHandle } from "@elements/storage-sqlite-drizzle";
import { setSetting } from "@elements/lifecycle-app-settings";
import { users } from "@elements/identity-session-auth";
import {
  checkIns,
  needRates,
  needs,
  pois,
  progressEvents,
  staySites,
  stayWeights,
  trips,
} from "../src/db/schema.js";
import { buildDailyCandidates, type TripRow } from "../src/server/engine/candidates.js";
import { haversineMiles, type LatLng } from "../src/server/engine/geo.js";
import {
  STAY_SETTINGS_KEY,
  STAY_KINDS,
  StaySettingsSchema,
} from "../src/server/engine/stays.js";

/**
 * The day's leg has to end somewhere real.
 *
 * Before this feature the endpoint was whichever campground happened to be
 * nearest a point on the highway, or a fabricated stop called "End of day's
 * drive". These tests pin the replacement: four kinds of stay compete, each hard
 * filter rules places out with a stated reason, and the cost of a stay is
 * measured the way a stay actually costs — against carrying on, not as an
 * out-and-back detour.
 */

const NOW = "2026-07-30T17:00:00.000Z"; // 10am PDT — a normal morning departure
const WINTER_AFTERNOON = "2026-12-15T22:00:00.000Z"; // 2pm PST — too late to reach anywhere in daylight
const T0 = "2026-07-25T00:00:00.000Z";

const ORIGIN: LatLng = { lat: 45.5152, lng: -122.6784 }; // Portland, OR
const DEST: LatLng = { lat: 36.1699, lng: -115.1398 }; // Las Vegas, NV
const POSITION: LatLng = { lat: 44.0582, lng: -121.3153 }; // Bend, OR

const lerp = (f: number): LatLng => ({
  lat: POSITION.lat + (DEST.lat - POSITION.lat) * f,
  lng: POSITION.lng + (DEST.lng - POSITION.lng) * f,
});
/** Same point on the corridor, pushed sideways in latitude. */
const offset = (f: number, latMiles: number): LatLng => ({
  lat: lerp(f).lat + latMiles / 69,
  lng: lerp(f).lng,
});

const MPH = 45;

/** Deterministic fake OSRM: straight-line legs at a constant 45 mph, plus matrices. */
function fakeOsrm(url: string): Response {
  const parse = (s: string): LatLng[] =>
    s.split(";").map((pair) => {
      const [lng, lat] = pair.split(",").map(Number);
      return { lat: lat!, lng: lng! };
    });
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  const table = /\/table\/v1\/driving\/([^?]+)\?(.*)$/.exec(url);
  if (table) {
    const coords = parse(table[1]!);
    const params = new URLSearchParams(table[2]!);
    const idx = (key: string): number[] => {
      const raw = params.get(key);
      return raw === null ? coords.map((_, i) => i) : raw.split(";").map(Number);
    };
    const sources = idx("sources");
    const destinations = idx("destinations");
    const durations = sources.map((s) =>
      destinations.map((d) => (haversineMiles(coords[s]!, coords[d]!) / MPH) * 3600),
    );
    const distances = sources.map((s) =>
      destinations.map((d) => haversineMiles(coords[s]!, coords[d]!) * 1609.34),
    );
    return json({ code: "Ok", durations, distances });
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
        duration: legs.reduce((s, l) => s + l.duration, 0),
        distance: legs.reduce((s, l) => s + l.distance, 0),
        geometry: { coordinates: coords.map((c) => [c.lng, c.lat]) },
        legs,
      },
    ],
  });
}

interface StaySeed {
  name: string;
  category: (typeof STAY_KINDS)[number];
  point: LatLng;
  access?: string;
  hookupElectric?: boolean;
  nightlyCostUsd?: number | null;
}

let handle: DbHandle;
let db: Db;
let trip: TripRow;
let tripId: number;
let uid: number;
const poiIdByName = new Map<string, number>();

/**
 * The seeded shortlist. Every stay sits near the day's reach so it is genuinely
 * in contention; the differences between them are the things under test.
 */
const STAYS: StaySeed[] = [
  { name: "Corridor Campground", category: "campground", point: lerp(0.42), nightlyCostUsd: 25 },
  { name: "Corridor Campground (powered)", category: "campground", point: lerp(0.425), nightlyCostUsd: 30, hookupElectric: true },
  { name: "Corridor Dispersed", category: "dispersed", point: lerp(0.43), nightlyCostUsd: 0 },
  { name: "Corridor Motel", category: "lodging", point: lerp(0.435), nightlyCostUsd: 95, hookupElectric: true },
  { name: "Corridor Overnight Lot", category: "parking", point: lerp(0.44), nightlyCostUsd: 0 },
  // Ruled out by the van-access filter, not by score.
  { name: "Rough Track Dispersed", category: "dispersed", point: lerp(0.415), access: "high-clearance" },
  // 40 miles off the line: still inside the search radius, so it is shortlisted
  // and then judged on what it actually adds.
  { name: "Far Lateral Camp", category: "campground", point: offset(0.43, 40), nightlyCostUsd: 10 },
  // 30 miles FURTHER along the route than the day would otherwise reach. An
  // out-and-back model would price this at roughly 80 minutes; it should cost
  // almost nothing, because tomorrow starts from here.
  { name: "Ahead On Route Camp", category: "campground", point: lerp(0.47), nightlyCostUsd: 15 },
  // A plain band of campgrounds down the corridor, so the roomier roles — which
  // stop far short of the direct one — also have somewhere to sleep. Deliberately
  // unremarkable: no hookups, middling price, so they never win a contest the
  // named stays above are meant to decide.
  ...[0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35].map(
    (f): StaySeed => ({ name: `Band Camp ${f.toFixed(2)}`, category: "campground", point: lerp(f), nightlyCostUsd: 20 }),
  ),
];

async function setKindWeights(value: number): Promise<void> {
  for (const kind of STAY_KINDS) {
    const factor = `kind-${kind}`;
    const existing = (
      await db.select().from(stayWeights).where(eq(stayWeights.factor, factor))
    ).find((r) => r.tripId === tripId);
    if (existing) {
      await db.update(stayWeights).set({ weight: value, updatedAt: T0 }).where(eq(stayWeights.id, existing.id));
    } else {
      await db.insert(stayWeights).values({ tripId, factor, weight: value, updatedAt: T0 });
    }
  }
}

async function clearKindWeights(): Promise<void> {
  await db.delete(stayWeights).where(eq(stayWeights.tripId, tripId));
}

beforeAll(async () => {
  vi.stubGlobal("fetch", (input: unknown) => Promise.resolve(fakeOsrm(String(input))));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vanlife-stays-"));
  handle = await createDb({ dbFile: path.join(dir, "test.db") });
  const migrationsDir = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      if (stmt.trim().length > 0) await handle.client.execute(stmt);
    }
  }
  db = handle.db;

  uid = (
    await db
      .insert(users)
      .values({ email: "stays@example.com", passwordHash: "x", role: "operator", createdAt: T0 })
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
    milesDriven: 0,
    driveSeconds: 0,
    recordedBy: uid,
    occurredAt: T0,
  });

  for (const [i, s] of STAYS.entries()) {
    const id = (
      await db
        .insert(pois)
        .values({
          source: "manual",
          sourceId: `stay-${String(i)}`,
          name: s.name,
          category: s.category,
          lat: s.point.lat,
          lng: s.point.lng,
          popularity: 0.5,
          fetchedAt: T0,
          updatedAt: T0,
        })
        .returning({ id: pois.id })
    )[0]!.id;
    poiIdByName.set(s.name, id);
    await db.insert(staySites).values({
      poiId: id,
      stayKind: s.category,
      nightlyCostUsd: s.nightlyCostUsd ?? null,
      hookupElectric: s.hookupElectric ?? false,
      reservable: "none",
      access: s.access ?? "van-ok",
      confidence: "reported",
      lastReportedAt: T0,
      updatedAt: T0,
    });
  }
});

afterAll(() => {
  vi.unstubAllGlobals();
  handle.close();
});

async function firstCandidate(nowIso = NOW) {
  const built = await buildDailyCandidates(db, trip, nowIso);
  expect(built.length).toBeGreaterThan(0);
  return built[0]!;
}

describe("the night is a real place", () => {
  it("ends every candidate at a named stay rather than a point on the road", async () => {
    const built = await buildDailyCandidates(db, trip, NOW);
    for (const c of built) {
      const last = c.stops[c.stops.length - 1]!;
      expect(["camp", "lodging", "park"]).toContain(last.purpose);
      expect(last.poiId).not.toBeNull();
      expect(last.name).not.toBe("End of day's drive");
      expect(c.summary).toContain("overnight at");
    }
  });

  it("puts all four kinds of stay in contention", async () => {
    const c = await firstCandidate();
    expect(new Set(c.stayOptions.map((s) => s.stayKind))).toEqual(new Set(STAY_KINDS));
  });

  it("keeps the runners-up, so a full site has an alternative ready", async () => {
    const c = await firstCandidate();
    const usable = c.stayOptions.filter((s) => s.excludedReason === null);
    expect(usable.length).toBeGreaterThan(2);
    // Ranked, and the winner is the one the route actually drives to.
    expect(c.stops[c.stops.length - 1]!.poiId).toBe(usable[0]!.poiId);
  });
});

describe("hard filters rule places out, with the reason", () => {
  it("excludes a road the van cannot drive", async () => {
    const c = await firstCandidate();
    const rough = c.stayOptions.find((s) => s.poiId === poiIdByName.get("Rough Track Dispersed"));
    expect(rough?.excludedReason).toBe("the road in needs high clearance");
  });

  it("excludes a stay that adds more than the detour cap, and says how much", async () => {
    await setSetting(db, STAY_SETTINGS_KEY, StaySettingsSchema, { maxDetourMinutes: 2 }, null);
    try {
      const c = await firstCandidate();
      const far = c.stayOptions.find((s) => s.poiId === poiIdByName.get("Far Lateral Camp"));
      expect(far?.excludedReason).toMatch(/adds \d+ min off the day's route/);
      // The on-route one survives the same cap — the filter is about detour, not distance.
      const ahead = c.stayOptions.find((s) => s.poiId === poiIdByName.get("Ahead On Route Camp"));
      expect(ahead?.excludedReason).toBeNull();
    } finally {
      await setSetting(db, STAY_SETTINGS_KEY, StaySettingsSchema, { maxDetourMinutes: 30 }, null);
    }
  });

  it("will not send us to an unlit place after dark, but a motel is fine", async () => {
    const c = await firstCandidate(WINTER_AFTERNOON);
    const reasonFor = (name: string): string | null =>
      c.stayOptions.find((s) => s.poiId === poiIdByName.get(name))?.excludedReason ?? null;
    expect(reasonFor("Corridor Dispersed")).toBe("we would arrive after dark");
    expect(reasonFor("Corridor Overnight Lot")).toBe("we would arrive after dark");
    // Finding an unmarked pullout in the dark is the problem; a lit forecourt
    // with a front desk is an ordinary night arrival.
    expect(reasonFor("Corridor Motel")).toBeNull();
  });
});

describe("what a stay actually costs", () => {
  it("does not charge a stay further along the route as an out-and-back detour", async () => {
    const c = await firstCandidate();
    const ahead = c.stayOptions.find((s) => s.poiId === poiIdByName.get("Ahead On Route Camp"))!;
    // It sits ~30 miles beyond the day's reach. Priced as a detour that would be
    // roughly 2 x 40 minutes; priced correctly — tomorrow resumes from here — it
    // is close to free.
    const outAndBack = (haversineMiles(lerp(0.42), lerp(0.47)) / MPH) * 60 * 2;
    expect(outAndBack).toBeGreaterThan(50);
    expect(Math.abs(ahead.marginalMinutes)).toBeLessThan(10);
  });
});

describe("needs drive the choice", () => {
  it("prefers a hookup when the battery is nearly flat", async () => {
    const needId = (
      await db
        .insert(needs)
        .values({
          key: "electric",
          title: "Battery",
          direction: "depletes",
          warnRatio: 0.3,
          urgentRatio: 0.15,
          poiCategory: "ev-charge",
          routingDriver: true,
          sortOrder: 1,
          active: true,
        })
        .returning({ id: needs.id })
    )[0]!.id;
    await db.insert(needRates).values({
      needId,
      ratePerDay: 25,
      ratePerMile: 0,
      source: "manual",
      effectiveFrom: T0,
      createdAt: T0,
    });
    await db.insert(checkIns).values({
      needId,
      kind: "set-level",
      quantity: 6,
      recordedBy: uid,
      occurredAt: NOW,
      createdAt: NOW,
    });
    try {
      const c = await firstCandidate();
      const winner = c.stayOptions.find((s) => s.excludedReason === null)!;
      const powered = new Set([
        poiIdByName.get("Corridor Campground (powered)"),
        poiIdByName.get("Corridor Motel"),
      ]);
      expect(powered.has(winner.poiId)).toBe(true);
      expect(winner.factors.needs).toBeGreaterThan(0.9);
    } finally {
      await db.delete(checkIns).where(eq(checkIns.needId, needId));
      await db.delete(needRates).where(eq(needRates.needId, needId));
      await db.delete(needs).where(eq(needs.id, needId));
    }
  });
});

describe("when there is nowhere to stay", () => {
  it("says so plainly instead of inventing a destination", async () => {
    await setKindWeights(0);
    try {
      const c = await firstCandidate();
      const last = c.stops[c.stops.length - 1]!;
      expect(last.poiId).toBeNull();
      expect(last.purpose).toBe("drive");
      // The endpoint is a coordinate and must not read as a place.
      expect(last.name).toContain("no stay found");
      expect(c.warnings.some((w) => w.severity === "urgent" && /ruled out|No known place/.test(w.message))).toBe(true);
      expect(c.summary).toContain("nowhere to stay found");
    } finally {
      await clearKindWeights();
    }
  });

  it("names how many were ruled out and why", async () => {
    await setKindWeights(0);
    try {
      const c = await firstCandidate();
      const warning = c.warnings.find((w) => w.message.includes("ruled out"))!;
      expect(warning.message).toMatch(/\d+ because/);
    } finally {
      await clearKindWeights();
    }
  });
});

describe("determinism with stays in play (ROUTE-5)", () => {
  it("two builds with identical inputs are deeply equal, stay options included", async () => {
    const a = await buildDailyCandidates(db, trip, NOW);
    const b = await buildDailyCandidates(db, trip, NOW);
    expect(b).toEqual(a);
    expect(b[0]!.stayOptions).toEqual(a[0]!.stayOptions);
  });

  it("a rebuild later in the same hour still chooses the same bed", async () => {
    const a = await buildDailyCandidates(db, trip, NOW);
    const b = await buildDailyCandidates(db, trip, "2026-07-30T17:58:00.000Z");
    expect(b).toEqual(a);
  });
});
