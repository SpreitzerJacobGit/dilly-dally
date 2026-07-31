---
id: lifecycle/migrate-seed
package: "@elements/lifecycle-migrate-seed"
plane: system
category: lifecycle
version: 0.1.0
variationGroup: null
variationAxis: null
summary: Idempotent boot-time migration runner and ledger-tracked seeding — the vertical cannot start without its schema and sample data in place.
provides: [migrateAndSeed, isReady, SeedFn, MigrateSeedResult]
requiresElements: [storage/sqlite-drizzle]
requiresConfig: []
claims:
  - "A freshly installed application starts with its full schema and sample data already present — the first screen is never empty."
whenToUse: "Every vertical with storage. This is the mechanical answer to 'empty databases are defects'."
whenNotToUse: "Data imports from a client's legacy system — that is an intake concern, not boot seeding."
---

## Purpose

Runs schema migrations and one-time seeds during boot, before the application accepts traffic. Seeds are bespoke functions with stable ids; the ledger guarantees each runs exactly once per database, so restarting a container never duplicates data.

## Behavior

The very first time the application starts on a fresh volume, it arrives with realistic sample data already loaded — a first-time visitor sees a populated application, not an empty one. Restarting or upgrading the application never duplicates that data and never loses recorded changes.

## Configuration

`migrationsFolder` — path to the drizzle migration journal inside the artifact. Seeds are passed by the composition root.

## Wiring

Called by `lifecycle/service-runtime` during boot, after the database opens and before routes register. `isReady` feeds `observability/health`'s readiness check.

## Variations & alternatives

None. Rollback of schema is deliberately not attempted at the application level — delivery-level rollback is image retagging (see lifecycle/docker-delivery).

## Limits

Migrations are forward-only. Seeds run synchronously at boot; heavy fixtures would delay first listen.
