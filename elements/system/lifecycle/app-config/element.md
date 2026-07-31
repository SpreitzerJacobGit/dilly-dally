---
id: lifecycle/app-config
package: "@elements/lifecycle-app-config"
plane: system
category: lifecycle
version: 0.1.0
variationGroup: null
variationAxis: null
summary: Parses environment variables against a typed schema and fails fast at boot with a precise report of missing or invalid keys.
provides: [loadConfig, ConfigError, envString, envInt, envBool]
requiresElements: []
requiresConfig: []
claims:
  - "The application refuses to start when required configuration is missing, and says exactly which keys are wrong."
whenToUse: "Every vertical. Configuration is the single knob surface the assembly manifest's config blocks target."
whenNotToUse: "Secrets management beyond environment variables (vaults, rotation) is out of scope."
---

## Purpose

One typed gate between the process environment and the application. Every other element receives configuration as typed values, never by reading `process.env` itself.

## Behavior

The application either starts with a fully valid configuration or does not start at all. When any required setting is missing or malformed, startup stops immediately and the error names every offending key with the reason, so an operator can fix all of them in one round trip rather than discovering them one restart at a time.

## Configuration

None of its own. `loadConfig(schema)` takes the vertical's schema; keys are environment variable names, values are zod field shapes (`envString()`, `envInt()`, `envBool()`).

## Wiring

Called first in the composition root's boot order. The returned typed object is passed to every other element factory. No element other than this one touches `process.env`.

## Variations & alternatives

None. File-based or remote configuration would be a variation (`lifecycle/config`) if a client ever needs it.

## Limits

Environment variables only; no reload at runtime — configuration is fixed for the life of the process.
