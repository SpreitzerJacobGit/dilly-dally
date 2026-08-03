/**
 * The migrations apply through drizzle's own journal, on a fresh database.
 *
 * Every other test in this suite hand-executes the .sql files, which proves the
 * SQL parses but says nothing about _journal.json — and the journal is what the
 * real boot path reads. A migration added without its journal entry passes the
 * whole rest of the suite and then silently never runs in production.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "@elements/storage-sqlite-drizzle";
import { migrateAndSeed } from "@elements/lifecycle-migrate-seed";

const MIGRATIONS = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

describe("migrations", () => {
  it("every .sql file is registered in the journal", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    const onDisk = fs
      .readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.replace(/\.sql$/, ""))
      .sort();

    expect([...journal.entries].sort((a, b) => a.idx - b.idx).map((e) => e.tag)).toEqual(onDisk);
  });

  it("applies to a fresh database and creates the lookup memory", async () => {
    const handle = await createDb({ dbFile: ":memory:" });
    try {
      await migrateAndSeed(handle, { migrationsFolder: MIGRATIONS, seeds: [] });

      const cols = await handle.client.execute("PRAGMA table_info(place_lookups)");
      expect(cols.rows.map((r) => String(r.name)).sort()).toEqual([
        "fetched_at",
        "id",
        "kind",
        "query_key",
        "results_json",
      ]);

      // The uniqueness is what makes a repeat lookup an upsert rather than a pile of rows.
      const indexes = await handle.client.execute("PRAGMA index_list(place_lookups)");
      const unique = indexes.rows.find((r) => String(r.name) === "place_lookups_kind_query");
      expect(unique).toBeDefined();
      expect(Number(unique!.unique)).toBe(1);
    } finally {
      handle.close();
    }
  });

  it("is idempotent — a second boot applies nothing and still works", async () => {
    const handle = await createDb({ dbFile: ":memory:" });
    try {
      await migrateAndSeed(handle, { migrationsFolder: MIGRATIONS, seeds: [] });
      await migrateAndSeed(handle, { migrationsFolder: MIGRATIONS, seeds: [] });
      const cols = await handle.client.execute("PRAGMA table_info(place_lookups)");
      expect(cols.rows.length).toBe(5);
    } finally {
      handle.close();
    }
  });
});
