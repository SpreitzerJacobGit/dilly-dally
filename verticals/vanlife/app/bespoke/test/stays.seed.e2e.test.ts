import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, eq, type Db, type DbHandle } from "@elements/storage-sqlite-drizzle";
import { migrateAndSeed } from "@elements/lifecycle-migrate-seed";
import { users } from "@elements/identity-session-auth";
import { pois, staySites, trips } from "../src/db/schema.js";
import { seedVanlifeData } from "../src/server/seed.js";
import { buildDailyCandidates, type TripRow } from "../src/server/engine/candidates.js";
import { haversineMiles, type LatLng } from "../src/server/engine/geo.js";
import { FIXTURE_POIS } from "../src/seed/fixtures.js";

/**
 * The shipped demo, end to end: migrate a database from nothing, run the real
 * seed, and plan a day. What this proves that the unit tests cannot is that a
 * first-run installation has somewhere to sleep — the seeded corridor really
 * does carry all four kinds of stay, and the planner really does end the day at
 * one of them.
 */

const NOW = "2026-07-30T17:00:00.000Z";
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

beforeAll(async () => {
  vi.stubGlobal("fetch", (input: unknown) => Promise.resolve(fakeOsrm(String(input))));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vl-stay-seed-"));
  handle = await createDb({ dbFile: path.join(dir, "t.db") });
  // The real boot seeds credentials first (check-ins and stay plans are always
  // attributed), so stand in for that step rather than reaching into app/server.
  const operators = {
    id: "test-operators",
    run: async (h: DbHandle) => {
      await h.db
        .insert(users)
        .values({ email: "jacob@vanlife.test", passwordHash: "x", role: "operator", createdAt: "2026-07-25T00:00:00.000Z" });
    },
  };
  await migrateAndSeed(handle, {
    migrationsFolder: fileURLToPath(new URL("../../../db/migrations", import.meta.url)),
    seeds: [operators, seedVanlifeData],
  });
  db = handle.db;
  trip = (await db.select().from(trips).where(eq(trips.status, "active")))[0] as unknown as TripRow;
});

afterAll(() => {
  vi.unstubAllGlobals();
  handle.close();
});

describe("the shipped demo has somewhere to sleep", () => {
  it("seeds every kind of stay, and only stay places get stay facts", async () => {
    const rows = await db.select({ site: staySites, category: pois.category }).from(staySites).innerJoin(pois, eq(pois.id, staySites.poiId));
    const kinds = new Set(rows.map((r) => r.site.stayKind));
    expect(kinds).toEqual(new Set(["campground", "dispersed", "lodging", "parking"]));
    // One row per stay fixture, and nothing else — a fuel station is not a bed.
    expect(rows.length).toBe(FIXTURE_POIS.filter((p) => p.stay).length);
    for (const r of rows) expect(r.category).toBe(r.site.stayKind);
  });

  it("marks exactly one seeded site as needing high clearance", async () => {
    const rough = await db.select().from(staySites).where(eq(staySites.access, "high-clearance"));
    expect(rough.length).toBe(1);
  });

  it("plans a first day that ends at a real place to stay", async () => {
    const built = await buildDailyCandidates(db, trip, NOW);
    expect(built.length).toBeGreaterThan(0);
    for (const c of built) {
      const last = c.stops[c.stops.length - 1]!;
      // Either a bed, or an honest admission — never a coordinate wearing a name.
      if (last.poiId === null) {
        expect(last.name).toContain("no stay found");
        expect(c.warnings.some((w) => w.severity === "urgent")).toBe(true);
      } else {
        expect(["camp", "lodging", "park", "sight", "drive", "family"]).toContain(last.purpose);
      }
    }
    // The straight-shot day should reach one of the seeded Oregon stays.
    const direct = built[0]!;
    expect(direct.stayOptions.length).toBeGreaterThan(0);
    expect(direct.summary).toContain("overnight at");
    const bed = direct.stops[direct.stops.length - 1]!;
    expect(bed.poiId).not.toBeNull();
    expect(["camp", "lodging", "park"]).toContain(bed.purpose);
  });

  it("never offers the high-clearance site as a usable bed", async () => {
    const rough = (
      await db.select({ poiId: staySites.poiId }).from(staySites).where(eq(staySites.access, "high-clearance"))
    )[0]!;
    const built = await buildDailyCandidates(db, trip, NOW);
    for (const c of built) {
      const option = c.stayOptions.find((s) => s.poiId === rough.poiId);
      if (option) expect(option.excludedReason).toBe("the road in needs high clearance");
      expect(c.stops[c.stops.length - 1]!.poiId).not.toBe(rough.poiId);
    }
  });
});
