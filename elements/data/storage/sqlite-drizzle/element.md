---
id: storage/sqlite-drizzle
package: "@elements/storage-sqlite-drizzle"
plane: data
category: storage
version: 0.1.0
variationGroup: storage/relational
variationAxis: "Embedded single-file SQLite vs. a networked Postgres variation; choosing SQLite propagates a single-writer, single-container deployment shape."
summary: Embedded SQLite storage via Drizzle with WAL mode, foreign keys, and transactional discipline; re-exports the sanctioned table-definition surface.
provides: [createDb, withTransaction, Db, DbHandle, CreateDbOptions, sqliteTable, text, integer, real, blob, index, uniqueIndex, primaryKey, sql, eq, and, or, desc, asc, count, sum, isNull, isNotNull, lte, gte, lt, gt, ne, like, inArray]
requiresElements: []
requiresConfig: [DB_FILE]
claims:
  - "Data written by one request is visible to every subsequent request, including after the application restarts."
whenToUse: "Single-tenant self-hosted verticals where the whole state fits one machine — the default."
whenNotToUse: "Multi-writer concurrency across processes, or clients mandating an existing database server — that is the Postgres variation."
---

## Purpose

The vertical's persistence: one SQLite file on a mounted volume, opened one way, with write-ahead logging and enforced foreign keys. Bespoke code defines tables using builders re-exported from here, which keeps every schema definition a visible edge to this element in the derived graph.

## Behavior

Anything the user saves stays saved: records survive page reloads, logouts, and full application restarts. Deleting or changing a record is atomic — a failed operation leaves the data exactly as it was, never half-applied.

## Configuration

`dbFile` — path to the database file. In delivered containers this sits on the named volume so data outlives image upgrades and rollbacks.

## Wiring

`createDb` runs once during boot, before migrations. The handle is placed in the request context by the composition root; procedures reach the database only through that context.

## Variations & alternatives

`storage/postgres-drizzle` (future variation in group `storage/relational`): same Drizzle query surface, different operational shape — network server, connection pool, multi-writer. Choosing between them is a design decision that propagates to delivery and lifecycle.

## Limits

Single writer process. No horizontal scaling. Database size is bounded by local disk. Backup is file-copy of the volume (with WAL checkpointing), not replication.
