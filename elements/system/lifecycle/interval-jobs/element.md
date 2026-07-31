---
id: lifecycle/interval-jobs
package: "@elements/lifecycle-interval-jobs"
plane: system
category: lifecycle
version: 0.2.0
variationGroup: null
variationAxis: null
summary: Named recurring background jobs with structural overlap prevention and persisted per-job status — the scheduling backbone for polling integrations.
provides: [intervalJobStatus, createJobRunner, jobStatusRows, jobStatusRow, setActiveRunner, activeRunner, IntervalJob, JobStatus, JobRunner]
requiresElements: [storage/sqlite-drizzle, observability/structured-logging]
requiresConfig: []
claims:
  - "Recurring background work reports when it last ran, when it last succeeded, and what last went wrong — retrievable from the running application at any time."
whenToUse: "Any element that must act on a schedule — polling an external system, periodic pushes, housekeeping."
whenNotToUse: "Cron-style wall-clock scheduling or one-off delayed tasks."
---

## Purpose

One scheduling discipline for background work: elements register named jobs with an interval, the runner executes them without overlap, and every outcome is persisted to a status table that the diagnostics endpoint and status pages read. A failing job is a recorded, visible fact — never a crashed process.

## Behavior

Background work that is configured to run keeps running on its schedule, and its bookkeeping is always available: when it last ran, when it last succeeded, and the exact error if it is failing. Work that is not configured is shown as not running rather than silently absent. Two runs of the same job never overlap, so a slow poll delays the next one instead of doubling it. A run that had nothing real to do records nothing at all, so "last run" always means the last genuine attempt.

## Configuration

None of its own. Each registering element supplies the job name, interval, and enabled flag (derived from that element's configuration).

## Wiring

The composition root creates the runner before the service (registration touches no database), passes `jobStatusRows` to the health element's diagnostics sections, and starts the runner after the service listens. `setActiveRunner` publishes the instance so status routers can offer a "run now" control.

## Variations & alternatives

None. Wall-clock cron scheduling would be a variation with a genuinely different contract (missed-window semantics).

## Limits

Intervals are best-effort (next run scheduled after the previous settles — no fixed-rate catch-up). In-memory schedule: a restart re-registers from configuration; status rows persist. `setActiveRunner` is shared module state — one runner per process, by design.
