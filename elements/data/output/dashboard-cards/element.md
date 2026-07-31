---
id: output/dashboard-cards
package: "@elements/output-dashboard-cards"
plane: data
category: output
version: 0.1.0
variationGroup: null
variationAxis: null
summary: Headline stat cards and the dashboard grid — the summary numbers a user sees first, wired to read procedures by the vertical.
provides: [StatCard, DashboardGrid, StatCardProps, DashboardGridProps]
requiresElements: []
requiresConfig: []
claims:
  - "A headline number on the dashboard equals what the underlying listing shows when opened."
whenToUse: "Any landing screen that summarizes state before the user drills in."
whenNotToUse: "Charts and time series — a future output element."
---

## Purpose

The dashboard's building blocks: a labelled headline number with an optional alert tone, laid out in a wrapping grid. Values come from bespoke read procedures, so a card is only as honest as the query behind it — which the verification loop checks against the listing it summarizes.

## Behavior

Each card shows one labelled number that agrees with the detailed view it summarizes — a card claiming "3 need attention" sits above a list of exactly those 3. Alert-toned cards are visually distinct from neutral ones.

## Configuration

None. Labels, values, tones, and details are bespoke props.

## Wiring

Bespoke dashboard pages compute values via `output/table-views` reads composed with `processing/*` and pass them in.

## Variations & alternatives

None. Trend charts would be a sibling output element.

## Limits

Static numbers per render; no live refresh beyond query refetching.
