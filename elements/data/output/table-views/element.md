---
id: output/table-views
package: "@elements/output-table-views"
plane: data
category: output
version: 0.1.0
variationGroup: null
variationAxis: null
summary: The read-side seam — typed list procedures with a shared parameter vocabulary (search, filters) and one resolver shape.
provides: [listParams, listRead, searchPattern]
requiresElements: [lifecycle/service-runtime, storage/sqlite-drizzle]
requiresConfig: []
claims:
  - "A listing shows exactly the records matching its filters, and searching narrows it to matching records rather than doing nothing."
whenToUse: "Every list endpoint a table or picker binds to."
whenNotToUse: "Exports (CSV/PDF) — a future output element."
---

## Purpose

One shape for reading lists: bespoke queries wrapped in a common resolver, with a shared zod parameter vocabulary so search and filters mean the same thing on every endpoint. The client counterpart is `shell/crud-tables`, joined only through the bespoke page.

## Behavior

A listing reflects the data as it is at the moment it renders: what matches the filters appears, what does not match does not. Entering a search term narrows the list to matching records; clearing it restores the full list.

## Configuration

None. Filters beyond `search` are declared per endpoint in bespoke code via `listParams`.

## Wiring

Bespoke routers: `procedure.input(listParams({...})).query(listRead(read))`. Derived columns (levels, statuses) compose in from `processing/derived-aggregates` and `processing/threshold-rules` inside the read body.

## Variations & alternatives

Server-side pagination/sorting would extend this element when a vertical's data outgrows client-side lists — a version bump, not a variation.

## Limits

Whole-result reads; no cursors. Search is a simple contains match.
