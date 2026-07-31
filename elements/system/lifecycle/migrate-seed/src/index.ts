import { migrate } from "drizzle-orm/libsql/migrator";
import type { DbHandle } from "@elements/storage-sqlite-drizzle";

export interface SeedFn {
  /** Stable id recorded in the seed ledger — a seed runs exactly once per database. */
  id: string;
  run: (handle: DbHandle) => Promise<void>;
}

export interface MigrateSeedResult {
  migrationsApplied: boolean;
  seedsRun: string[];
  seedsSkipped: string[];
}

/**
 * Boot-time migrate + seed. Idempotent: migrations via drizzle's journal,
 * seeds via a ledger table. The composition root calls this before the app
 * starts listening — the vertical cannot come up without its data in place.
 */
export async function migrateAndSeed(
  handle: DbHandle,
  opts: { migrationsFolder: string; seeds: SeedFn[] },
): Promise<MigrateSeedResult> {
  await migrate(handle.db, { migrationsFolder: opts.migrationsFolder });

  await handle.client.execute(
    `CREATE TABLE IF NOT EXISTS _seed_ledger (
       id TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  );

  const seedsRun: string[] = [];
  const seedsSkipped: string[] = [];

  for (const seed of opts.seeds) {
    const seen = await handle.client.execute({
      sql: `SELECT 1 FROM _seed_ledger WHERE id = ?`,
      args: [seed.id],
    });
    if (seen.rows.length > 0) {
      seedsSkipped.push(seed.id);
      continue;
    }
    await seed.run(handle);
    await handle.client.execute({
      sql: `INSERT INTO _seed_ledger (id, applied_at) VALUES (?, ?)`,
      args: [seed.id, new Date().toISOString()],
    });
    seedsRun.push(seed.id);
  }

  return { migrationsApplied: true, seedsRun, seedsSkipped };
}

/** True once both migrations and every declared seed have been applied. */
export async function isReady(handle: DbHandle, seeds: SeedFn[]): Promise<boolean> {
  try {
    for (const s of seeds) {
      const seen = await handle.client.execute({
        sql: `SELECT 1 FROM _seed_ledger WHERE id = ?`,
        args: [s.id],
      });
      if (seen.rows.length === 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}
