---
id: intake/poi-sources
package: "@elements/intake-poi-sources"
plane: data
category: intake
version: 0.1.0
variationGroup: null
variationAxis: null
summary: Polls public POI sources (OSM Overpass, NPS, Recreation.gov, OpenChargeMap) per named region with freshness bookkeeping, normalizes to one record shape, and hands batches to a bespoke ingestion hook; also imports one-shot datasets.
provides: [poiSourceRuns, PoiRecordSchema, PoiRecord, PoiRegion, OnPois, OnPoisMeta, FetchResult, PoiSourceAdapter, POI_SOURCES_SETTINGS_KEY, PoiSourceKeysSchema, SOURCE_KEY_FIELDS, getPoiSourceKeys, savePoiSourceKeys, PoiSourceKeys, createOverpassAdapter, elementToRecord, createNpsAdapter, createRecreationGovAdapter, createOpenChargeMapAdapter, POI_SOURCES_JOB, createPoiPoller, PoiPollerOptions, PoiPollResult, importPoiDataset, geojsonToPoiRecords, createPoiSourcesStatusRouter, poiSourceStatuses, PoiSourceState, PoiSourceStatus]
requiresElements: [storage/sqlite-drizzle, lifecycle/app-settings, lifecycle/interval-jobs, lifecycle/service-runtime, identity/session-auth, observability/structured-logging]
requiresConfig: []
claims:
  - "Every POI source reports itself in exactly one honest state — unconfigured, never-checked, healthy, or erroring with the error and time visible — and never claims a fetch it has not performed."
  - "Every record handed to the application carries a stable (source, sourceId) identity, so re-fetching a region, restarting, or overlapping regions never forces a duplicate on the domain."
whenToUse: "Any vertical that aggregates places from public geo sources into a local store — the fetch/normalize/bookkeeping half of a POI pipeline."
whenNotToUse: "Sources requiring scraping or violating terms (deep-link out instead), realtime feeds, or bulk planet-scale imports (use dedicated tooling and importPoiDataset the result)."
---

## Purpose

The fetch half of POI aggregation: adapters for public sources, per-(source, region) freshness and error bookkeeping, normalization into one `PoiRecord` shape, and a one-shot dataset importer. What the domain keeps, how categories map to needs, and where regions come from belong to the vertical — the poller asks a bespoke `regionProvider` for regions and hands every batch to a bespoke `onPois` hook.

## Behavior

Each poll asks the vertical which regions matter, fetches the stale ones per adapter, and hands normalized batches to the ingestion hook; a region fetched recently is left alone. Sources whose API key is not stored skip without recording anything, so "never checked" stays honest. Failures record the error per (source, region) and keep polling the rest. Every record carries `(source, sourceId)` so the domain can upsert idempotently — polling twice never duplicates a place. Dataset imports validate every row and report rejects instead of dropping them.

## Configuration

Nothing from the environment. The poll interval is chosen where the job is registered (the composition root's bespoke jobs hook). NPS, Recreation.gov, and OpenChargeMap API keys are stored lifecycle configuration entered by an operator through the application; Overpass is keyless. Adapter endpoints are overridable for tests and self-hosted mirrors; per-(source, region) refresh age defaults to 24 h.

## Wiring

The composition root's bespoke jobs hook constructs the poller with the adapter list, the bespoke `onPois` upsert, and a `regionProvider` (e.g. the active trip's corridor cells), then registers it as an always-enabled interval job that skips while there is nothing to fetch. The status router mounts under the application router with the adapter names; a sources page invokes it.

## Variations & alternatives

Additional adapters (AllTrails, iOverlander exports, state park systems) implement `PoiSourceAdapter` in the vertical or, once proven generic, land here. A webhook/streaming source would be a different element shape.

## Limits

Poll-latency freshness only — no realtime. Overpass is a shared public service: keep regions corridor-sized, refresh daily, and expect occasional 429/504s to surface as honest errors. It also requires callers to identify themselves — a request without a `User-Agent` is refused with 406, and Node's `fetch` sends none by default, so the adapter always sets one (overridable per instance). NPS has no bbox parameter (national lists filtered locally); RIDB search is radius-based with a 50-mile cap, so oversized regions are under-covered at their corners. Popularity is sparse and source-dependent; absent signals are null, never invented.
