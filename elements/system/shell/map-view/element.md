---
id: shell/map-view
package: "@elements/shell-map-view"
plane: system
category: shell
version: 0.1.0
variationGroup: null
variationAxis: null
summary: Offline-first map plumbing — serves a PMTiles basemap with range requests plus self-hosted glyphs/sprites, and builds a MapLibre style whose every URL resolves locally.
provides: [createTileAssetsPlugin, TileAssetsOptions, registerPmtilesProtocol, basemapStyle, BasemapStyleOptions]
requiresElements: [lifecycle/service-runtime]
requiresConfig: [TILES_DIR]
claims:
  - "The basemap renders entirely from locally served assets — no request leaves the host for tiles, glyphs, or sprites."
  - "A missing tile archive is reported honestly through the status endpoint rather than rendering as a silently blank map."
whenToUse: "Any vertical with a map that must work where the only reachable host is the application's own server — cached vector basemap, offline deployments, LAN-first installs."
whenNotToUse: "Maps that can assume internet access and are better served by a hosted tile provider, or raster-tile pipelines."
---

## Purpose

The generic, fiddly leg-work of an offline map: serving a multi-gigabyte `.pmtiles` archive over HTTP range requests, hosting the glyph and sprite assets a vector style needs, registering MapLibre's `pmtiles://` protocol exactly once, and emitting a style specification with no external URL in it. Everything about what the map shows — layers, markers, interactions, styling of domain data — belongs to the vertical.

## Behavior

The server half mounts a static route (default `/tiles`) over the configured directory with range requests enabled; `/tiles/status` reports which archives, glyphs, and sprites are actually present, so a missing basemap is a visible state rather than a blank map. The client half returns a complete MapLibre style whose tiles come from `pmtiles://<local url>` and whose fonts and sprites come from the same host — rendering works when no other host is reachable.

## Configuration

`TILES_DIR` — the directory holding `*.pmtiles`, `glyphs/`, and `sprites/` (in delivery, a path on the data volume; the archive and assets are provisioned out of band, documented per vertical). Client calls take the served URLs.

## Wiring

The generator emits the plugin into the service-runtime `plugins` list when this element is pinned, with `TILES_DIR` in the config schema. The vertical's map component calls `registerPmtilesProtocol()` once, then `basemapStyle({...})` for the style, and layers its own sources on top.

## Variations & alternatives

A hosted-tiles variation (style URL pass-through, no serving) would suit internet-assumed verticals. Raster tile caching is a different element shape entirely.

## Limits

One basemap flavor per style call; no style hot-swapping helper. Sprite assets follow the Protomaps `sprites/v4/<flavor>` layout. The archive itself is not managed here — download, extraction, and refresh are vertical-documented operations. No tile rendering on the server; clients need WebGL.
