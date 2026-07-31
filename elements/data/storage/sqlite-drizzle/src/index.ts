import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";

export type Db = LibSQLDatabase<Record<string, unknown>>;

export interface CreateDbOptions {
  /** Path to the SQLite file, or ":memory:" for tests. */
  dbFile: string;
}

export interface DbHandle {
  db: Db;
  client: Client;
  close: () => void;
}

/**
 * The one way a vertical opens its database: local SQLite file over libsql
 * (stable N-API binaries — no compiler toolchain on any host), foreign keys on.
 * Connection discipline lives here, schema lives bespoke.
 */
export async function createDb(opts: CreateDbOptions): Promise<DbHandle> {
  const url = opts.dbFile === ":memory:" ? "file::memory:" : `file:${opts.dbFile}`;
  const client = createClient({ url });
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA busy_timeout = 5000");
  const db = drizzle(client);
  return { db, client, close: () => client.close() };
}

/** Transaction helper — the failed callback leaves the data exactly as it was. */
export async function withTransaction<T>(handle: DbHandle, fn: (db: Db) => Promise<T>): Promise<T> {
  return handle.db.transaction(async (tx) => fn(tx as unknown as Db));
}

// The single sanctioned surface for table definitions — bespoke schemas import
// these from the element, never from drizzle-orm directly, so storage stays a
// visible typed edge in the derived graph.
export {
  sqliteTable,
  text,
  integer,
  real,
  blob,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/sqlite-core";
export { sql, eq, and, or, desc, asc, count, sum, isNull, isNotNull, lte, gte, lt, gt, ne, like, inArray } from "drizzle-orm";
