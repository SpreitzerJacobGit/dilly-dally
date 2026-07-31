import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb, withTransaction, sql } from "@elements/storage-sqlite-drizzle";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agger-db-"));
  return path.join(dir, "test.db");
}
import { migrateAndSeed, isReady, type SeedFn } from "../src/index.js";

function tempMigrations(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agger-mig-"));
  fs.writeFileSync(
    path.join(dir, "0000_init.sql"),
    "CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
  );
  fs.mkdirSync(path.join(dir, "meta"));
  fs.writeFileSync(
    path.join(dir, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "sqlite",
      entries: [{ idx: 0, version: "6", when: 1700000000000, tag: "0000_init", breakpoints: true }],
    }),
  );
  return dir;
}

describe("storage + migrate-seed", () => {
  it("opens a database, migrates, seeds exactly once, and reports readiness", async () => {
    const handle = await createDb({ dbFile: tempDbFile() });
    const migrationsFolder = tempMigrations();
    let seedRuns = 0;
    const seeds: SeedFn[] = [
      {
        id: "seed-things-v1",
        run: async (h) => {
          seedRuns++;
          await h.client.execute("INSERT INTO things (name) VALUES ('first')");
        },
      },
    ];

    expect(await isReady(handle, seeds)).toBe(false);

    const first = await migrateAndSeed(handle, { migrationsFolder, seeds });
    expect(first.seedsRun).toEqual(["seed-things-v1"]);

    const second = await migrateAndSeed(handle, { migrationsFolder, seeds });
    expect(second.seedsSkipped).toEqual(["seed-things-v1"]);
    expect(seedRuns).toBe(1);

    expect(await isReady(handle, seeds)).toBe(true);

    const rows = await handle.client.execute("SELECT name FROM things");
    expect(rows.rows.length).toBe(1);
    handle.close();
  });

  it("rolls back a failed transaction completely", async () => {
    const handle = await createDb({ dbFile: tempDbFile() });
    await handle.client.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    await expect(
      withTransaction(handle, async (db) => {
        await db.run(sql`INSERT INTO t (v) VALUES ('a')`);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const rows = await handle.client.execute("SELECT * FROM t");
    expect(rows.rows.length).toBe(0);
    handle.close();
  });
});
