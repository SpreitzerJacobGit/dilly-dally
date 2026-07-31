import { addProtocol, setWorkerUrl } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { layers, namedFlavor } from "@protomaps/basemaps";
import type { StyleSpecification } from "maplibre-gl";
// MapLibre resolves its worker as `new URL("./maplibre-gl-worker.mjs", import.meta.url)`
// at runtime. A bundler cannot see that reference, so the file is never emitted, the
// request falls through to the SPA's index.html, and the worker dies on a MIME-type
// error — no tile is ever parsed and the map renders blank *without* firing any map
// error event. `?worker&url` makes the bundler emit it; `&worker` rather than a plain
// `?url` matters because the worker imports ./maplibre-gl-shared.mjs, which a verbatim
// copy would leave dangling. This bundles those imports in.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

let initialized = false;

/**
 * Prepare MapLibre for an offline-served basemap: point it at the bundled
 * worker and register the pmtiles:// protocol. Idempotent — safe to call from
 * every map mount, and it must run before the first Map is constructed.
 */
export function initMapLibre(): void {
  if (initialized) return;
  setWorkerUrl(maplibreWorkerUrl);
  const protocol = new Protocol();
  addProtocol("pmtiles", protocol.tile);
  initialized = true;
}

export interface BasemapStyleOptions {
  /** URL of the .pmtiles archive, absolute or host-relative (e.g. /tiles/basemap.pmtiles). */
  pmtilesUrl: string;
  /** Base URL under which glyphs/ and sprites/ are served (e.g. /tiles). */
  assetsUrl: string;
  flavor?: "light" | "dark" | "white" | "grayscale" | "black";
  lang?: string;
}

/**
 * MapLibre resolves glyph and tile URLs against the document, but its
 * `normalizeSpriteURL` calls `new URL(url)` with no base — so a host-relative
 * sprite path throws "Invalid sprite URL … must be absolute" and takes the
 * whole style down with it, leaving a blank basemap. Resolve it against the
 * document here. Still same-origin: no request leaves the host.
 */
function absoluteSpriteUrl(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path;
  if (typeof location === "undefined") return path;
  return new URL(path, location.href).href;
}

/**
 * A complete MapLibre style over a locally served Protomaps basemap. Every URL
 * in the style — tiles, glyphs, sprites — points at the given host paths, so
 * the map renders with zero external requests (the offline-LAN case is the
 * primary deployment, and CDN references would fail exactly there, silently).
 */
export function basemapStyle(opts: BasemapStyleOptions): StyleSpecification {
  const flavorName = opts.flavor ?? "light";
  const assets = opts.assetsUrl.replace(/\/$/, "");
  return {
    version: 8,
    glyphs: `${assets}/glyphs/{fontstack}/{range}.pbf`,
    sprite: absoluteSpriteUrl(`${assets}/sprites/v4/${flavorName}`),
    sources: {
      protomaps: {
        type: "vector",
        url: `pmtiles://${opts.pmtilesUrl}`,
        attribution: '<a href="https://openstreetmap.org">© OpenStreetMap</a>',
      },
    },
    layers: layers("protomaps", namedFlavor(flavorName), { lang: opts.lang ?? "en" }),
  };
}
