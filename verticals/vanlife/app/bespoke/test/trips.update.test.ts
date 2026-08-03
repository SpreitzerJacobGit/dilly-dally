/**
 * Editing and deleting a trip.
 *
 * The interesting assertions here are the negatives: renaming a trip must NOT
 * move the deviation budget, and deleting the active trip must NOT be possible.
 * Both are the kind of thing that only breaks quietly.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, like } from "@elements/storage-sqlite-drizzle";
import { appSettings } from "@elements/lifecycle-app-settings";
import { createDb, type DbHandle } from "@elements/storage-sqlite-drizzle";
import { users } from "@elements/identity-session-auth";
import {
  daySelections,
  digests,
  poiMarks,
  pois,
  progressEvents,
  routeCandidates,
  routeLegs,
  trips,
  waypoints,
} from "../src/db/schema.js";
import {
  applyTripUpdate,
  deleteTrip,
  movesEndpoints,
  planningSettings,
  PLANNING_SETTINGS_KEY,
  PlanningSettingsSchema,
  shouldPushWarnings,
} from "../src/server/engine/trips.js";
import { setSetting } from "@elements/lifecycle-app-settings";
import { planDateOf, planStateFingerprint } from "../src/server/engine/candidates.js";

const T0 = "2026-07-25T00:00:00.000Z";
const ORIGIN = { lat: 45.5152, lng: -122.6784 };
const DEST = { lat: 36.1699, lng: -115.1398 };

let handle: DbHandle;
let tripId: number;

async function migrate(h: DbHandle): Promise<void> {
  const md = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
  for (const f of fs.readdirSync(md).filter((x) => x.endsWith(".sql")).sort())
    for (const s of fs.readFileSync(path.join(md, f), "utf8").split("--> statement-breakpoint"))
      if (s.trim()) await h.client.execute(s);
}

async function insertTrip(status: string): Promise<number> {
  const rows = await handle.db
    .insert(trips)
    .values({
      name: "Sierra loop",
      status,
      originName: "Portland, OR",
      originLat: ORIGIN.lat,
      originLng: ORIGIN.lng,
      destName: "Las Vegas, NV",
      destLat: DEST.lat,
      destLng: DEST.lng,
      directDurationMinutes: 1200,
      deviationBudgetRatio: 2,
      dailyDriveHours: 4,
      createdAt: T0,
      updatedAt: T0,
    })
    .returning({ id: trips.id });
  return rows[0]!.id;
}

async function readTrip(id: number) {
  return (await handle.db.select().from(trips).where(eq(trips.id, id)))[0]!;
}

/** A candidate for today, in whichever status the test needs. */
async function insertCandidate(id: number, status: string): Promise<number> {
  const rows = await handle.db
    .insert(routeCandidates)
    .values({
      tripId: id,
      planDate: planDateOf(new Date().toISOString()),
      tier: "direct",
      title: "Straight shot",
      summary: "s",
      score: 1,
      durationMinutes: 240,
      distanceMiles: 180,
      remainingBudgetMinutes: 900,
      geometry: '{"coordinates":[]}',
      projectedGeometry: null,
      warnings: "[]",
      status,
      generatedAt: T0,
    })
    .returning({ id: routeCandidates.id });
  return rows[0]!.id;
}

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vl-trips-"));
  handle = await createDb({ dbFile: path.join(dir, "t.db") });
  await migrate(handle);
  tripId = await insertTrip("planning");
});
afterEach(() => handle.close());

describe("applyTripUpdate — what resets the frozen baseline", () => {
  it("nulls the direct duration when the final Target moves, leaving the ratio alone", async () => {
    const r = await applyTripUpdate(handle.db, {
      id: tripId,
      destName: "Moab, UT",
      dest: { lat: 38.5733, lng: -109.5498 },
    });
    expect(r.baselineReset).toBe(true);
    const t = await readTrip(tripId);
    expect(t.directDurationMinutes).toBeNull();
    expect(t.deviationBudgetRatio).toBe(2);
    expect(t.destName).toBe("Moab, UT");
  });

  it("nulls it when the Origin moves too", async () => {
    const r = await applyTripUpdate(handle.db, { id: tripId, origin: { lat: 47.6, lng: -122.33 } });
    expect(r.baselineReset).toBe(true);
    expect((await readTrip(tripId)).directDurationMinutes).toBeNull();
  });

  it("does NOT null it on a rename — a budget must never move for an unstated reason", async () => {
    const r = await applyTripUpdate(handle.db, { id: tripId, name: "Sierra loop, take two" });
    expect(r.baselineReset).toBe(false);
    const t = await readTrip(tripId);
    expect(t.directDurationMinutes).toBe(1200);
    expect(t.name).toBe("Sierra loop, take two");
  });

  it("does NOT null it when only the ratio or the daily pace changes", async () => {
    const r = await applyTripUpdate(handle.db, { id: tripId, deviationBudgetRatio: 3, dailyDriveHours: 6 });
    expect(r.baselineReset).toBe(false);
    const t = await readTrip(tripId);
    expect(t.directDurationMinutes).toBe(1200);
    expect(t.deviationBudgetRatio).toBe(3);
    expect(t.dailyDriveHours).toBe(6);
  });

  it("does NOT null it when the endpoint is re-sent unchanged", async () => {
    // Renaming the label while leaving the coordinates alone is a rename.
    expect(movesEndpoints(await readTrip(tripId), { id: tripId, dest: DEST, destName: "Vegas" })).toBe(false);
    const r = await applyTripUpdate(handle.db, { id: tripId, dest: DEST, destName: "Vegas" });
    expect(r.baselineReset).toBe(false);
    expect((await readTrip(tripId)).directDurationMinutes).toBe(1200);
  });
});

describe("planning defaults — what a new trip starts at", () => {
  it("is four hours until an operator says otherwise", async () => {
    expect(await planningSettings(handle.db)).toEqual({ defaultDailyDriveHours: 4 });
  });

  it("returns the operator's value once set", async () => {
    await setSetting(
      handle.db,
      PLANNING_SETTINGS_KEY,
      PlanningSettingsSchema,
      { defaultDailyDriveHours: 6.5 },
      null,
    );
    expect(await planningSettings(handle.db)).toEqual({ defaultDailyDriveHours: 6.5 });
  });

  it("does not reach a trip that already exists", async () => {
    await setSetting(
      handle.db,
      PLANNING_SETTINGS_KEY,
      PlanningSettingsSchema,
      { defaultDailyDriveHours: 9 },
      null,
    );
    expect((await readTrip(tripId)).dailyDriveHours).toBe(4);
  });
});

describe("applyTripUpdate — today's plans", () => {
  it("expires today's proposals but keeps a chosen plan, and says it is stale", async () => {
    const proposed = await insertCandidate(tripId, "proposed");
    const selected = await insertCandidate(tripId, "selected");

    const r = await applyTripUpdate(handle.db, { id: tripId, dest: { lat: 38.5733, lng: -109.5498 } });

    expect(r.expiredCandidates).toBe(1);
    expect(r.selectionStale).toBe(true);
    const after = await handle.db.select().from(routeCandidates).where(eq(routeCandidates.tripId, tripId));
    expect(after.find((c) => c.id === proposed)!.status).toBe("expired");
    expect(after.find((c) => c.id === selected)!.status).toBe("selected");
  });

  it("reports no stale selection when nothing was chosen", async () => {
    await insertCandidate(tripId, "proposed");
    const r = await applyTripUpdate(handle.db, { id: tripId, dest: { lat: 38.5733, lng: -109.5498 } });
    expect(r.selectionStale).toBe(false);
  });

  it("changes the plan fingerprint, so a replan rebuilds", async () => {
    const before = await planStateFingerprint(handle.db, tripId);
    await applyTripUpdate(handle.db, { id: tripId, dest: { lat: 38.5733, lng: -109.5498 } });
    expect(await planStateFingerprint(handle.db, tripId)).not.toBe(before);
  });
});

describe("deleteTrip", () => {
  it("removes the trip and everything hanging off it, including the fingerprint setting", async () => {
    const candidateId = await insertCandidate(tripId, "proposed");
    const date = planDateOf(new Date().toISOString());
    const uid = (
      await handle.db
        .insert(users)
        .values({ email: "a@b.c", passwordHash: "x", role: "operator", createdAt: T0 })
        .returning({ id: users.id })
    )[0]!.id;
    await handle.db.insert(routeLegs).values({
      candidateId, orderIndex: 0, toName: "A stop", toLat: 40, toLng: -120,
      purpose: "interest", etaMinutesFromStart: 60, cumMiles: 45, dwellMinutes: 30,
    });
    await handle.db.insert(daySelections).values({
      tripId, planDate: date, candidateId, selectedBy: uid, selectedAt: T0,
    });
    await handle.db.insert(digests).values({ tripId, date, body: "{}", priority: "default", generatedAt: T0 });
    await handle.db.insert(progressEvents).values({
      tripId, kind: "position-set", lat: 44, lng: -121, milesDriven: 10, driveSeconds: 800,
      recordedBy: uid, occurredAt: T0,
    });
    await handle.db.insert(waypoints).values([
      { tripId, name: "Area", lat: 40, lng: -120, radiusMiles: 50, parentId: null, depth: 0, kind: "custom", orderIndex: 0, createdAt: T0 },
    ]);
    const parent = (await handle.db.select().from(waypoints).where(eq(waypoints.tripId, tripId)))[0]!;
    await handle.db.insert(waypoints).values({
      tripId, name: "Narrower", lat: 40.1, lng: -120.1, radiusMiles: 10,
      parentId: parent.id, depth: 1, kind: "custom", orderIndex: 0, createdAt: T0,
    });
    await handle.db.insert(appSettings).values({
      key: `plan-fingerprint:${String(tripId)}:${date}`, value: '"abc"', updatedBy: null, updatedAt: T0,
    });

    const r = await deleteTrip(handle.db, tripId);

    expect(r.deleted.legs).toBe(1);
    expect(r.deleted.selections).toBe(1);
    expect(r.deleted.candidates).toBe(1);
    expect(r.deleted.digests).toBe(1);
    expect(r.deleted.progress).toBe(1);
    expect(r.deleted.targets).toBe(2);
    expect(r.settingsCleared).toBe(1);

    expect(await handle.db.select().from(trips).where(eq(trips.id, tripId))).toHaveLength(0);
    expect(await handle.db.select().from(waypoints).where(eq(waypoints.tripId, tripId))).toHaveLength(0);
    expect(await handle.db.select().from(routeCandidates).where(eq(routeCandidates.tripId, tripId))).toHaveLength(0);
    expect(await handle.db.select().from(routeLegs).where(eq(routeLegs.candidateId, candidateId))).toHaveLength(0);
    expect(
      await handle.db.select().from(appSettings).where(like(appSettings.key, `plan-fingerprint:${String(tripId)}:%`)),
    ).toHaveLength(0);
  });

  it("leaves another trip's rows untouched", async () => {
    const other = await insertTrip("planning");
    const poiId = (
      await handle.db
        .insert(pois)
        .values({
          source: "manual", sourceId: "p-1", name: "A place", category: "scenic",
          lat: 40, lng: -120, fetchedAt: T0, updatedAt: T0,
        })
        .returning({ id: pois.id })
    )[0]!.id;
    await handle.db.insert(poiMarks).values({ tripId: other, poiId, mark: "pinned", createdAt: T0 });
    await insertCandidate(other, "proposed");

    await deleteTrip(handle.db, tripId);

    expect(await handle.db.select().from(trips).where(eq(trips.id, other))).toHaveLength(1);
    expect(await handle.db.select().from(routeCandidates).where(eq(routeCandidates.tripId, other))).toHaveLength(1);
  });
});

describe("shouldPushWarnings — only the trip the van is on may push", () => {
  it("is true only for the active trip", () => {
    expect(shouldPushWarnings({ status: "active" })).toBe(true);
    for (const status of ["planning", "completed", "archived"]) {
      expect(shouldPushWarnings({ status })).toBe(false);
    }
  });
});
