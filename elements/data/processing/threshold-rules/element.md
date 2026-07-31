---
id: processing/threshold-rules
package: "@elements/processing-threshold-rules"
plane: data
category: processing
version: 0.1.0
variationGroup: null
variationAxis: null
summary: Evaluates levels against configured thresholds into ok/low/out states with deficits, and lists active alerts most-urgent first.
provides: [evaluateThreshold, activeAlerts, ThresholdStatus, ThresholdInput, ThresholdState, AlertRow]
requiresElements: []
requiresConfig: []
claims:
  - "An item at or below its threshold is flagged, an item above it is not, and the most urgent shortfalls are listed first."
whenToUse: "Any 'flag when X crosses Y' requirement over derived or stored values."
whenNotToUse: "Time-based schedules or external notification delivery."
---

## Purpose

The rule that turns quantities into alerts: pure, total functions from (level, threshold) to a status and a deficit, plus the ordering that puts the worst shortfall first. Bespoke code supplies what a level and threshold mean; this element guarantees the comparison is applied one way everywhere.

## Behavior

An item whose level is at or below its threshold is flagged as needing attention, with the size of the shortfall; an item above its threshold never is. An item with no level left is flagged as out. Items with no configured threshold are never flagged. Where alerts are listed, the largest shortfall comes first.

## Configuration

None. Thresholds are data (set per item by users); the predicate is fixed.

## Wiring

Consumes levels from `processing/derived-aggregates` (or any number). Feeds `output/dashboard-cards` panels and list badges via bespoke read procedures.

## Variations & alternatives

Percentage-based or time-derivative rules ("running out within a week") would be variations with genuinely different predicate shapes.

## Limits

Static comparison only; no hysteresis, no acknowledgement state, no notification delivery.
