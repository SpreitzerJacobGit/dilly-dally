---
id: lifecycle/service-runtime
package: "@elements/lifecycle-service-runtime"
plane: system
category: lifecycle
version: 0.2.0
variationGroup: null
variationAxis: null
summary: The process frame — Fastify plus the single canonical tRPC instance, enforcing the boot order config, logger, storage, migrate/seed, routes, listen.
provides: [createService, router, publicProcedure, middleware, mergeRouters, TRPCError, BaseContext, Cookies, Service, ServiceOptions]
requiresElements: [storage/sqlite-drizzle, observability/structured-logging, lifecycle/migrate-seed]
requiresConfig: [PORT]
claims:
  - "The application serves its interface and its API from one address, and refuses to accept traffic until its data is fully prepared."
whenToUse: "Every vertical. Regenerating this frame per project would make the most defect-prone wiring the least proven code in the system."
whenNotToUse: "Standalone batch jobs with no HTTP surface."
---

## Purpose

Owns the running process: one Fastify server serving the built client and the tRPC API, with a fixed boot order no vertical can deviate from. Exports the one canonical set of tRPC builders — every procedure in the application is built from these, which is what makes the client-server seam statically provable.

## Behavior

The application is reachable at a single address that serves both its pages and its data. It never accepts a request before its database schema and sample data are in place. Errors during a request produce a controlled error response, never a hung or half-rendered page, and are recorded for diagnostics.

## Configuration

`port` (and optional `host`), the migrations folder path, and the static assets directory — all supplied by the generated composition root from app-config values.

## Wiring

The composition root builds config → logger → storage, then hands everything to `createService` with the merged appRouter, seeds, and plugins (health). Elements contribute procedures by importing `router`/`publicProcedure` from here — never by creating their own tRPC instance.

## Variations & alternatives

None. A second HTTP framework or a serverless shape would be a new variation group with wide propagation; nothing motivates it.

## Limits

One process, one port. WebSockets and subscriptions are not wired in v1. TLS terminates outside the container (client's reverse proxy).
