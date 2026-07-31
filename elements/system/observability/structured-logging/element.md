---
id: observability/structured-logging
package: "@elements/observability-structured-logging"
plane: system
category: observability
version: 0.1.0
variationGroup: null
variationAxis: null
summary: Structured JSON logging with per-element child loggers and an in-memory ring buffer of recent warnings and errors.
provides: [createLogger, childLogger, errorInfo, LogRingBuffer, AppLogger, LogEntry]
requiresElements: []
requiresConfig: []
claims:
  - "Every warning or error the application emits is retrievable from the running instance without file access."
whenToUse: "Every vertical. Clients self-host, so logs are the primary signal Jacob can ask a client to read back."
whenNotToUse: "Log shipping to external aggregators — that would be an output-plane concern configured per client."
---

## Purpose

One logging discipline for every element and the bespoke layer: structured JSON lines, a named child logger per element, and a bounded in-memory buffer of recent problems that the health element exposes over HTTP.

## Behavior

Application events are recorded as structured entries rather than free text. The most recent warnings and errors remain available from the running application itself, so a problem report from a client can be diagnosed by fetching the diagnostics endpoint rather than asking them to locate log files.

## Configuration

`level` (default "info") and service `name`, both supplied by the composition root from app-config values.

## Wiring

Created once at boot, immediately after configuration. Every element factory receives a child logger (`childLogger(logger, { element: "..." })`). The ring buffer instance is shared with `observability/health` for `/__diag`.

## Variations & alternatives

None yet. A file-rotation or syslog variation would join `observability/logging` as a variation group if a client's ops require it.

## Limits

The ring buffer is in-memory and bounded (default 200 entries); it does not survive restarts. Console output is the single sink in v1.
