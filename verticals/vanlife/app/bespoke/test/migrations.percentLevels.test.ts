/**
 * Migration 0004, which turns per-need units and capacities into percentages.
 *
 * The correctness anchor for the whole change is that levels, rates and
 * capacity all scale by the SAME factor, so every runway/capacity ratio — and
 * therefore every urgency label — is invariant across the migration. These
 * tests pin the arithmetic that makes that true, and pin the two exclusions
 * that would otherwise corrupt data: date-tracked needs (whose capacity of 1 is
 * inert) and any need whose capacity is zero (which SQLite would turn into a
 * NULL rather than an error, aborting the migration on a NOT NULL column).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, type DbHandle } from "@elements/storage-sqlite-drizzle";

const MIGRATIONS = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

const THIS_MIGRATION = "0004_percent_levels.sql";

/** Apply the given migration files, in journal order. */
async function apply(h: DbHandle, files: string[]): Promise<void> {
  for (const f of files) {
    for (const s of fs.readFileSync(path.join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) {
      if (s.trim()) await h.client.execute(s);
    }
  }
}

/** Everything before this change — the old shape, with units and capacities. */
async function applyPrior(h: DbHandle): Promise<void> {
  await apply(
    h,
    fs
      .readdirSync(MIGRATIONS)
      .filter((x) => x.endsWith(".sql") && x < THIS_MIGRATION)
      .sort(),
  );
}

async function applyThis(h: DbHandle): Promise<void> {
  await apply(h, [THIS_MIGRATION]);
}

describe("0004_percent_levels — rescaling old units into percentages", () => {
  let handle: DbHandle;
  let dir: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vl-pct-"));
    handle = await createDb({ dbFile: path.join(dir, "test.db") });
    // Stop one short of this migration, so the old shape still exists to migrate.
    await applyPrior(handle);
    // check_ins.recorded_by is a real foreign key — every check-in is attributed.
    await handle.client.execute(
      `INSERT INTO users (id, email, password_hash, role, active, created_at)
       VALUES (1, 'op@vanlife.test', 'x', 'operator', 1, '2026-08-01T00:00:00.000Z')`,
    );
  });

  afterEach(() => handle.close());

  /** An old-shaped row, written raw because the TS schema no longer has the columns. */
  async function insertOldNeed(over: {
    key: string;
    capacity: number;
    trackingMode?: string;
  }): Promise<number> {
    await handle.client.execute({
      sql: `INSERT INTO needs (need_key, title, unit, capacity, direction, warn_ratio, urgent_ratio,
              routing_driver, sort_order, active, tracking_mode)
            VALUES (?, ?, 'gal', ?, 'depletes', 0.25, 0.1, 1, 1, 1, ?)`,
      args: [over.key, over.key, over.capacity, over.trackingMode ?? "level"],
    });
    const row = await handle.client.execute({
      sql: "SELECT id FROM needs WHERE need_key = ?",
      args: [over.key],
    });
    return Number(row.rows[0]!.id);
  }

  async function insertRate(needId: number, perDay: number, perMile: number): Promise<void> {
    await handle.client.execute({
      sql: `INSERT INTO need_rates (need_id, rate_per_day, rate_per_mile, source, effective_from, created_at)
            VALUES (?, ?, ?, 'manual', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
      args: [needId, perDay, perMile],
    });
  }

  async function insertCheckIn(needId: number, quantity: number | null): Promise<void> {
    await handle.client.execute({
      sql: `INSERT INTO check_ins (need_id, kind, quantity, recorded_by, occurred_at, created_at)
            VALUES (?, ?, ?, 1, '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z')`,
      args: [needId, quantity === null ? "service" : "set-level", quantity],
    });
  }

  async function rateOf(needId: number): Promise<{ perDay: number; perMile: number }> {
    const r = await handle.client.execute({
      sql: "SELECT rate_per_day, rate_per_mile FROM need_rates WHERE need_id = ?",
      args: [needId],
    });
    return { perDay: Number(r.rows[0]!.rate_per_day), perMile: Number(r.rows[0]!.rate_per_mile) };
  }

  async function quantitiesOf(needId: number): Promise<(number | null)[]> {
    const r = await handle.client.execute({
      sql: "SELECT quantity FROM check_ins WHERE need_id = ? ORDER BY id",
      args: [needId],
    });
    return r.rows.map((row) => (row.quantity === null ? null : Number(row.quantity)));
  }

  it("rescales a level need's quantities and rates by 100/capacity", async () => {
    const water = await insertOldNeed({ key: "water", capacity: 40 });
    await insertRate(water, 6, 0);
    await insertCheckIn(water, 12);

    await applyThis(handle);

    // 12 gal of a 40 gal tank is 30%; 6 gal/day of it is 15%/day.
    expect(await quantitiesOf(water)).toEqual([30]);
    expect(await rateOf(water)).toEqual({ perDay: 15, perMile: 0 });
  });

  it("rescales a per-mile rate, which is what made fuel awkward", async () => {
    const gas = await insertOldNeed({ key: "gas", capacity: 30 });
    await insertRate(gas, 0, 0.067);

    await applyThis(handle);

    const { perMile } = await rateOf(gas);
    // 0.067 gal/mile out of a 30 gal tank.
    expect(perMile).toBeCloseTo(0.2233, 4);
  });

  it("leaves a full-reset service's null quantity alone", async () => {
    const water = await insertOldNeed({ key: "water", capacity: 40 });
    await insertRate(water, 6, 0);
    await insertCheckIn(water, null);

    await applyThis(handle);

    expect(await quantitiesOf(water)).toEqual([null]);
  });

  it("does not touch a date-tracked need, whose capacity of 1 is inert", async () => {
    const oil = await insertOldNeed({ key: "oil-change", capacity: 1, trackingMode: "date" });
    await insertRate(oil, 0, 0);
    await insertCheckIn(oil, 3);

    await applyThis(handle);

    // A factor of 100/1 would have turned 3 into 300.
    expect(await quantitiesOf(oil)).toEqual([3]);
    expect(await rateOf(oil)).toEqual({ perDay: 0, perMile: 0 });
  });

  it("survives a zero-capacity need rather than aborting on a NOT NULL rate", async () => {
    const broken = await insertOldNeed({ key: "broken", capacity: 0 });
    await insertRate(broken, 5, 0);
    await insertCheckIn(broken, 2);

    await expect(applyThis(handle)).resolves.toBeUndefined();

    // Left exactly as found: there is no meaningful percentage to scale it to,
    // and a NULL here would have failed the migration for every other need too.
    expect(await rateOf(broken)).toEqual({ perDay: 5, perMile: 0 });
    expect(await quantitiesOf(broken)).toEqual([2]);
  });

  it("drops the columns that gave the old units their meaning", async () => {
    await applyThis(handle);
    const cols = await handle.client.execute("PRAGMA table_info(needs)");
    const names = cols.rows.map((r) => String(r.name));
    expect(names).not.toContain("unit");
    expect(names).not.toContain("capacity");
  });

  it("clears digests, whose stored bodies carry gallons in a percent world", async () => {
    await handle.client.execute(
      `INSERT INTO trips (id, name, status, origin_name, origin_lat, origin_lng,
         dest_name, dest_lat, dest_lng, created_at, updated_at)
       VALUES (1, 'T', 'active', 'A', 45, -122, 'B', 36, -115,
         '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
    );
    const tripId = 1;
    await handle.client.execute({
      sql: `INSERT INTO digests (trip_id, date, body, priority, generated_at)
            VALUES (?, '2026-08-02', '{"needOutlook":[{"runway":7.5,"unit":"gal"}]}', 'default', '2026-08-02T00:00:00.000Z')`,
      args: [tripId],
    });

    await applyThis(handle);

    const rows = await handle.client.execute("SELECT COUNT(*) AS n FROM digests");
    expect(Number(rows.rows[0]!.n)).toBe(0);
  });
});
