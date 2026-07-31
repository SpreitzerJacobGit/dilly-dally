---
id: lifecycle/app-settings
package: "@elements/lifecycle-app-settings"
plane: system
category: lifecycle
version: 0.1.0
variationGroup: null
variationAxis: null
summary: Stored lifecycle configuration — typed, named settings records managed through the application by its operator instead of through the environment.
provides: [appSettings, getSetting, setSetting, deleteSetting, SettingRecord]
requiresElements: [storage/sqlite-drizzle]
requiresConfig: []
claims:
  - "Configuration an operator saves through the application survives restarts and upgrades, and a corrupted record surfaces as a visible error rather than silently pretending to be unconfigured."
whenToUse: "Any configuration the application's operator should manage at runtime — integration connections, notification targets, feature toggles."
whenNotToUse: "Boot-critical configuration the process cannot start without (port, database file) — that stays environment configuration via lifecycle/app-config."
---

## Purpose

The stored half of lifecycle configuration. Boot-critical settings stay in the environment (`lifecycle/app-config`); everything an operator should be able to change from inside the application lives here as a typed, validated record. Consumers own their key and schema; this element owns one storage discipline: JSON records validated on read and write, attributed to who changed them.

## Behavior

A setting saved by the operator takes effect without restarting and is still there after restarts and upgrades. A record that fails validation — corrupted, or written by an older version — surfaces as a visible, attributable error wherever it is used; it never silently reads as "not configured" and never half-applies.

## Configuration

None. Keys and schemas are declared by consuming elements.

## Wiring

The `app_settings` table joins the vertical's schema barrel for migrations. Consuming elements call `getSetting`/`setSetting` with their own key and zod schema; write procedures are gated by the consumer (typically owner-only).

## Variations & alternatives

None. An encrypted-at-rest variation would require a key-management story clients can actually operate; without one, encryption is theater.

## Limits

Values are stored as plaintext JSON in the vertical's own database — acceptable for self-hosted single-tenant installs where the operator owns the disk; document per-integration. No history/audit of prior values in v1 (only last-writer attribution).
