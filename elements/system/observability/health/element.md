---
id: observability/health
package: "@elements/observability-health"
plane: system
category: observability
version: 0.2.0
variationGroup: null
variationAxis: null
summary: Liveness, readiness, and diagnostics endpoints — build identity, uptime, and recent problems retrievable from any running installation.
provides: [createHealthPlugin, NamedCheck, HealthPluginOptions]
requiresElements: [observability/structured-logging]
requiresConfig: []
claims:
  - "A running installation can always report whether it is healthy and what has recently gone wrong, from a browser, with no server access."
whenToUse: "Every vertical. Clients self-host, so this is how a remote installation is diagnosed."
whenNotToUse: "Metrics time series or alerting pipelines — future observability variations."
---

## Purpose

Three HTTP endpoints that make a self-hosted installation inspectable from outside: liveness for the container orchestrator, readiness gating traffic on prepared data, and a diagnostics snapshot carrying build identity and the recent problem buffer.

## Behavior

Fetching the health address of a running installation answers immediately. The readiness address reports not-ready until the database schema and sample data are fully in place. The diagnostics address states exactly which build is running and lists the most recent recorded problems, so a remote issue can be triaged from a single URL fetch.

## Configuration

The identity block (vertical name, version, manifest hash) is injected by the generated composition root; checks are supplied by the elements that own them.

## Wiring

Registered as a service-runtime plugin. Readiness checks come from `lifecycle/migrate-seed` (`isReady`) and a storage ping; the ring buffer comes from `observability/structured-logging`.

## Variations & alternatives

None yet. Prometheus-format metrics would be a sibling element in observability, not a change to this one.

## Limits

Diagnostics reflect the current process only — no history across restarts. The problem buffer is bounded and in-memory.
