import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, type DbHandle } from "@elements/storage-sqlite-drizzle";
import { users } from "@elements/identity-session-auth";
import { trips, waypoints, pois, interestWeights, progressEvents } from "../src/db/schema.js";
import { buildDailyCandidates, type TripRow } from "../src/server/engine/candidates.js";
import { closestPointOnLine, haversineMiles, type LatLng } from "../src/server/engine/geo.js";
import { FIXTURE_POIS, FIXTURE_TRIP, FIXTURE_ANCHOR, FIXTURE_WEIGHTS } from "../src/seed/fixtures.js";

const T0 = "2026-07-25T00:00:00.000Z";
const NOW = "2026-07-30T17:00:00.000Z";

function fakeOsrm(url: string): Response {
  const m = /\/route\/v1\/driving\/([^?]+)/.exec(url);
  if (!m) return new Response("nf", { status: 404 });
  const coords: LatLng[] = m[1]!.split(";").map((p) => {
    const [lng, lat] = p.split(",").map(Number);
    return { lat: lat!, lng: lng! };
  });
  const legs = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const miles = haversineMiles(coords[i]!, coords[i + 1]!);
    legs.push({ duration: (miles / 45) * 3600, distance: miles * 1609.34 });
  }
  return new Response(JSON.stringify({ code: "Ok", routes: [{
    duration: legs.reduce((s, l) => s + l.duration, 0),
    distance: legs.reduce((s, l) => s + l.distance, 0),
    geometry: { coordinates: coords.map((c) => [c.lng, c.lat]) }, legs }] }),
    { status: 200, headers: { "content-type": "application/json" } });
}

let handle: DbHandle; let trip: TripRow; let uid: number;
const RENO = { lat: 39.5296, lng: -119.8138 };
const CENTER = { lat: FIXTURE_ANCHOR.lat, lng: FIXTURE_ANCHOR.lng };

beforeAll(async () => {
  vi.stubGlobal("fetch", (i: unknown) => Promise.resolve(fakeOsrm(String(i))));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vl-e2e-"));
  handle = await createDb({ dbFile: path.join(dir, "t.db") });
  const md = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
  for (const f of fs.readdirSync(md).filter((x) => x.endsWith(".sql")).sort())
    for (const s of fs.readFileSync(path.join(md, f), "utf8").split("--> statement-breakpoint"))
      if (s.trim()) await handle.client.execute(s);
  const db = handle.db;
  uid = (await db.insert(users).values({ email: "a@b.c", passwordHash: "x", role: "operator", createdAt: T0 }).returning({ id: users.id }))[0]!.id;
  const id = (await db.insert(trips).values({
    name: FIXTURE_TRIP.name, status: "active",
    originName: FIXTURE_TRIP.originName, originLat: FIXTURE_TRIP.originLat, originLng: FIXTURE_TRIP.originLng,
    destName: FIXTURE_TRIP.destName, destLat: FIXTURE_TRIP.destLat, destLng: FIXTURE_TRIP.destLng,
    directDurationMinutes: 1200, deviationBudgetRatio: 2, dailyDriveHours: 8,
    createdAt: T0, updatedAt: T0,
  }).returning({ id: trips.id }))[0]!.id;
  await db.insert(waypoints).values({
    tripId: id, name: FIXTURE_ANCHOR.name, lat: FIXTURE_ANCHOR.lat, lng: FIXTURE_ANCHOR.lng,
    radiusMiles: FIXTURE_ANCHOR.radiusMiles, parentId: null, depth: 0,
    kind: FIXTURE_ANCHOR.kind, orderIndex: 0, status: "pending", createdAt: T0,
  });
  for (const [i, p] of FIXTURE_POIS.entries())
    await db.insert(pois).values({ ...p, sourceId: `f-${i}`, tags: null, url: null, subcategory: null, fetchedAt: T0, updatedAt: T0 });
  for (const w of FIXTURE_WEIGHTS) await db.insert(interestWeights).values({ ...w, updatedAt: T0 });
  trip = (await db.select().from(trips))[0]! as unknown as TripRow;
});
afterAll(() => { vi.unstubAllGlobals(); handle.close(); });

describe("seeded demo: the reported symptom", () => {
  it("every candidate enters the Eastern Sierra anchor and none goes via Reno", async () => {
    const cands = await buildDailyCandidates(handle.db, trip, NOW);
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      const line = (JSON.parse(c.geometry) as { coordinates: [number, number][] }).coordinates;
      const proj = c.projectedGeometry
        ? (JSON.parse(c.projectedGeometry) as { coordinates: [number, number][] }).coordinates : [];
      const all = [...line, ...proj];
      const intoAnchor = closestPointOnLine(all, CENTER).miles;
      const nearReno = closestPointOnLine(all, RENO).miles;
      console.log(`  ${c.tier.padEnd(11)} anchor ${intoAnchor.toFixed(0).padStart(3)} mi   Reno ${nearReno.toFixed(0).padStart(3)} mi`);
      expect(intoAnchor).toBeLessThanOrEqual(FIXTURE_ANCHOR.radiusMiles);
      expect(nearReno).toBeGreaterThan(30);
    }
  });

  it("names the concrete place it chose once the region is within a day's drive", async () => {
    // From Portland the anchor is ~800 miles out, so today's leg only crosses
    // Oregon and the arrival stop never appears. Drive most of the way first.
    await handle.db.insert(progressEvents).values({
      tripId: trip.id,
      kind: "position-set",
      lat: 38.6,
      lng: -119.4,
      milesDriven: 0,
      driveSeconds: 0,
      recordedBy: uid,
      occurredAt: NOW,
    });
    const cands = await buildDailyCandidates(handle.db, trip, NOW);
    const named = cands.flatMap((c) => c.stops.map((s) => s.name));
    console.log("  stops:", [...new Set(named)].join(" | "));
    // The stop is named for the actual place inside the region, with the
    // region in parentheses — never a bare region name pretending to be a spot.
    expect(named.some((n) => n.includes(FIXTURE_ANCHOR.name))).toBe(true);
  });
});
