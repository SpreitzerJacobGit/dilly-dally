import { addProtocol } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { layers, namedFlavor } from "@protomaps/basemaps";
import type { StyleSpecification } from "maplibre-gl";

let registered = false;

/**
 * Register the pmtiles:// protocol with MapLibre exactly once. Safe to call
 * from every map mount.
 */
export function registerPmtilesProtocol(): void {
  if (registered) return;
  const protocol = new Protocol();
  addProtocol("pmtiles", protocol.tile);
  registered = true;
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
    sprite: `${assets}/sprites/v4/${flavorName}`,
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
