---
id: shell/crud-tables
package: "@elements/shell-crud-tables"
plane: system
category: shell
version: 0.1.0
variationGroup: null
variationAxis: null
summary: Sortable data table with typed columns and per-row actions, bound by the vertical to list queries and row mutations.
provides: [DataTable, DataTableProps, ColumnDef, RowAction]
requiresElements: []
requiresConfig: []
claims:
  - "A table with data shows every row it was given; a table with none says so in words rather than showing a blank area."
whenToUse: "Any listing of records with optional row-level actions."
whenNotToUse: "Editable grids or virtualized thousand-row tables."
---

## Purpose

The one way records are listed: typed columns, optional click-to-sort, per-row action buttons that can be hidden per row (role honesty), and an explicit empty message so a blank screen is never ambiguous.

## Behavior

Every row provided appears, with the columns the screen promises. Clicking a sortable column header orders the rows by that column and clicking again reverses the order. Row actions act on exactly the row they sit in. When there is nothing to show, the table says so in words.

## Configuration

Columns (header, cell renderer, optional sort value), row actions (label, handler, visibility), and the empty message — all supplied by the bespoke page.

## Wiring

Purely presentational: the vertical feeds it rows from a list query and wires actions to mutations, so control-to-procedure edges remain in derivable bespoke code.

## Variations & alternatives

None yet. Server-side pagination would extend `output/table-views` and this element together when a vertical's data outgrows client-side lists.

## Limits

Client-side sorting only; no pagination or column filtering in v1 — suitable for the hundreds-of-rows scale.
