/**
 * The Targets list: waypoint rows plus the trip's destination, as one thing.
 *
 * "One list" is the whole point of the merged screen, so the numbering and the
 * position of the final entry are worth asserting precisely.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "@elements/storage-sqlite-drizzle";
import { createDb, type DbHandle } from "@elements/storage-sqlite-drizzle";
import { trips, waypoints } from "../src/db/schema.js";
import { buildTargetViews, finalTargetView, FINAL_TARGET_ID } from "../src/server/engine/targets.js";

const T0 = "2026-07-25T00:00:00.000Z";
const NOW = "2026-07-30T17:00:00.000Z";
const POSITION = { lat: 45.5152, lng: -122.6784 };
const DEST = { lat: 36.1699, lng: -115.1398 };

let handle: DbHandle;
let tripId: number;

async function trip() {
  return (await handle.db.select().from(trips).where(eq(trips.id, tripId)))[0]!;
}

async function addTarget(name: string, lat: number, lng: number, radiusMiles: number, parentId: number | null, orderIndex: number, depth = 0): Promise<number> {
  const rows = await handle.db
    .insert(waypoints)
    .values({
      tripId, name, lat, lng, radiusMiles, parentId, depth,
      kind: "custom", orderIndex, status: "pending", createdAt: T0,
    })
    .returning({ id: waypoints.id });
  return rows[0]!.id;
}

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vl-targets-"));
  handle = await createDb({ dbFile: path.join(dir, "t.db") });
  const md = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
  for (const f of fs.readdirSync(md).filter((x) => x.endsWith(".sql")).sort())
    for (const s of fs.readFileSync(path.join(md, f), "utf8").split("--> statement-breakpoint"))
      if (s.trim()) await handle.client.execute(s);
  tripId = (
    await handle.db
      .insert(trips)
      .values({
        name: "Sierra loop", status: "active",
        originName: "Portland, OR", originLat: POSITION.lat, originLng: POSITION.lng,
        destName: "Las Vegas, NV", destLat: DEST.lat, destLng: DEST.lng,
        directDurationMinutes: 1200, deviationBudgetRatio: 2, dailyDriveHours: 4,
        createdAt: T0, updatedAt: T0,
      })
      .returning({ id: trips.id })
  )[0]!.id;
});
afterEach(() => handle.close());

describe("buildTargetViews — the destination as the last Target", () => {
  it("appends the final Target even when the trip has no waypoints at all", async () => {
    const views = await buildTargetViews(handle.db, await trip(), POSITION, NOW);
    expect(views).toHaveLength(1);
    const last = views[0]!;
    expect(last.final).toBe(true);
    expect(last.id).toBe(FINAL_TARGET_ID);
    expect(last.name).toBe("Las Vegas, NV");
    expect(last.center).toEqual(DEST);
  });

  it("puts it last, as an exact point with no ring and no pacing", async () => {
    await addTarget("Eastern Sierra", 37.45, -118.55, 110, null, 0);
    const views = await buildTargetViews(handle.db, await trip(), POSITION, NOW);

    expect(views.map((v) => v.name)).toEqual(["Eastern Sierra", "Las Vegas, NV"]);
    const last = views[views.length - 1]!;
    expect(last.final).toBe(true);
    expect(last.radiusMiles).toBe(0);
    expect(last.ring).toBeNull();
    expect(last.resolved).toBeNull();
    expect(last.pacing).toBeNull();
    expect(last.children).toEqual([]);
  });

  it("marks only the destination as final", async () => {
    await addTarget("Eastern Sierra", 37.45, -118.55, 110, null, 0);
    await addTarget("Death Valley", 36.5, -117.1, 30, null, 1);
    const views = await buildTargetViews(handle.db, await trip(), POSITION, NOW);
    expect(views.filter((v) => v.final)).toHaveLength(1);
  });

  it("still gives an area Target its ring, so the map can draw it", async () => {
    await addTarget("Eastern Sierra", 37.45, -118.55, 110, null, 0);
    const views = await buildTargetViews(handle.db, await trip(), POSITION, NOW);
    expect(views[0]!.ring!.length).toBeGreaterThan(3);
  });
});

describe("buildTargetViews — numbering", () => {
  it("numbers top-level Targets 1..n and the destination n+1", async () => {
    await addTarget("Eastern Sierra", 37.45, -118.55, 110, null, 0);
    await addTarget("Death Valley", 36.5, -117.1, 30, null, 1);
    const views = await buildTargetViews(handle.db, await trip(), POSITION, NOW);
    expect(views.map((v) => v.ordinal)).toEqual([1, 2, 3]);
  });

  it("leaves a narrowing unnumbered — it replaces its parent rather than adding a stop", async () => {
    const parent = await addTarget("Eastern Sierra", 37.45, -118.55, 110, null, 0);
    await addTarget("Mono Lake", 38.0, -119.0, 15, parent, 0, 1);
    const views = await buildTargetViews(handle.db, await trip(), POSITION, NOW);

    expect(views[0]!.ordinal).toBe(1);
    expect(views[0]!.children).toHaveLength(1);
    expect(views[0]!.children[0]!.ordinal).toBeNull();
    expect(views[0]!.children[0]!.final).toBe(false);
    // The narrowing does not consume a number: the destination is still 2.
    expect(views[views.length - 1]!.ordinal).toBe(2);
  });
});

describe("finalTargetView", () => {
  it("sorts after the Targets it follows", () => {
    const v = finalTargetView(
      { id: 1, destName: "Moab, UT", destLat: 38.5733, destLng: -109.5498, dailyDriveHours: 4 },
      3,
    );
    expect(v.orderIndex).toBe(3);
    expect(v.ordinal).toBe(4);
    expect(v.id).toBe(FINAL_TARGET_ID);
  });

  it("uses a negative id, so it can never be mistaken for a waypoint row", () => {
    expect(FINAL_TARGET_ID).toBeLessThan(0);
  });
});
