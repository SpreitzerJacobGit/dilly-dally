---
id: processing/derived-aggregates
package: "@elements/processing-derived-aggregates"
plane: data
category: processing
version: 0.1.0
variationGroup: null
variationAxis: null
summary: Derives read models from event-style logs — a level is the signed sum of its movements, computed in the database, never stored.
provides: [signedSumExpr, deriveLevel]
requiresElements: [storage/sqlite-drizzle]
requiresConfig: []
claims:
  - "A displayed level always equals the sum of its recorded movements — recording a movement changes the level everywhere it appears, and nothing else can."
whenToUse: "Any quantity that is the consequence of a history — stock from deliveries and usage, balances from postings."
whenNotToUse: "Values users edit directly, or aggregates over data too large to sum on demand."
---

## Purpose

The mechanism behind derived quantities: a signed-sum SQL expression composed into bespoke queries, so the displayed number is computed from the log at read time. There is no stored level to drift out of agreement with its history.

## Behavior

The level shown for an item always equals its deliveries minus its usage, everywhere it appears. Recording a movement is the only thing that changes a level, and after recording one the new level is what every screen shows.

## Configuration

None. The bespoke layer supplies the movement table's columns and which kind counts positive.

## Wiring

`signedSumExpr` composes into bespoke drizzle queries (grouped by item, or filtered to one). `processing/threshold-rules` consumes the derived values.

## Variations & alternatives

Materialized snapshots (for logs too large to sum) would be a variation with an explicit refresh discipline — a meaningful design decision that propagates.

## Limits

Sums on demand: fine for thousands of movements, wrong for millions. No time-windowed aggregation yet.
