import { useEffect, useRef, useState, type JSX } from "react";
import {
  Map as MlMap,
  Marker,
  NavigationControl,
  type GeoJSONSource,
  type MapLayerMouseEvent,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { basemapStyle, initMapLibre } from "@elements/shell-map-view/client";
import { useTileArchivePresent } from "../lib/tileStatus.js";
import {
  CATEGORY_COLORS,
  DEFAULT_SIGNAL_CARRIER,
  isSignalCarrier,
  LAND_COLORS,
  PROJECTED_COLOR,
  ROLE_COLORS,
  SIGNAL_COLORS,
  SIGNAL_TIERS,
} from "./palette.js";
import type { CandidateRouteView, MapTargetView, MapViewProps } from "./types.js";

/**
 * Imperative MapLibre wrapped in a presentation-only component: props in,
 * callbacks out, zero domain imports. The basemap is the locally served
 * PMTiles archive — every URL in the style resolves to the van server.
 */

initMapLibre();

const PMTILES_URL = "/tiles/basemap.pmtiles";
const ASSETS_URL = "/tiles";

/**
 * The cell signal overlay, provisioned separately from the basemap by a
 * scheduled refresh and therefore legitimately absent on a fresh install.
 * SIGNAL_SOURCE_LAYER is the layer name tippecanoe writes into the archive —
 * get it wrong and the source loads fine while nothing ever draws.
 */
const SIGNAL_SOURCE = "cell-signal";
const SIGNAL_LAYER = "cell-signal-fill";
const SIGNAL_PMTILES_URL = "pmtiles:///tiles/cell-signal.pmtiles";
const SIGNAL_SOURCE_LAYER = "coverage";

/**
 * The legal-camping overlay: a second PMTiles archive on the same volume,
 * prepared out of band by deploy/prepare-legal-overlay.ps1.
 *
 * Separate from the basemap because it is genuinely optional — the map is fully
 * usable without it, and a van that has never run the overlay prep should see an
 * ordinary map plus an honest "not installed" on the Status page, not a broken
 * one. Nothing is added to the style until /tiles/status confirms the archive is
 * actually there.
 */
const LEGAL_ARCHIVE = "legal-camping.pmtiles";
const LEGAL_ARCHIVE_URL = `${ASSETS_URL}/${LEGAL_ARCHIVE}`;
const LEGAL_SOURCE = "legal-land";
/** Layer names inside the archive, set by -nln when it was built. */
const LEGAL_BLM_LAYER = "blm_open_land";
const LEGAL_USFS_LAYER = "usfs_legal_corridor";

/** Keyed like LAND_COLORS, so the legend's checkboxes map straight onto layer ids. */
const LEGAL_LAYER_IDS: Record<string, string[]> = {
  blm: ["legal-blm-fill", "legal-blm-outline"],
  usfs: ["legal-usfs-fill", "legal-usfs-outline"],
};

/**
 * A corridor built from an assumed distance is drawn dashed, a published one
 * solid. Same device as the draft Target ring above, for the same reason: the
 * difference between "this is the rule" and "this is our best guess at the rule"
 * has to survive being looked at quickly.
 */
const legalDashExpr = [
  "case",
  ["==", ["get", "confidence"], "default_buffer"],
  ["literal", [2, 2]],
  ["literal", [1, 0]],
] as unknown as number[];

function routesToGeojson(routes: CandidateRouteView[], highlightedId: number | null) {
  return {
    type: "FeatureCollection" as const,
    features: routes.map((r) => ({
      type: "Feature" as const,
      properties: {
        id: r.id,
        tier: r.tier,
        highlighted: r.id === highlightedId,
      },
      geometry: { type: "LineString" as const, coordinates: r.coordinates },
    })),
  };
}

function projectedToGeojson(routes: CandidateRouteView[]) {
  return {
    type: "FeatureCollection" as const,
    features: routes
      .filter((r) => r.projected && r.projected.length > 1)
      .map((r) => ({
        type: "Feature" as const,
        properties: { id: r.id },
        geometry: { type: "LineString" as const, coordinates: r.projected! },
      })),
  };
}

function poisToGeojson(pois: MapViewProps["pois"]) {
  return {
    type: "FeatureCollection" as const,
    features: pois.map((p) => ({
      type: "Feature" as const,
      properties: { id: p.id, category: p.category, name: p.name },
      geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] as [number, number] },
    })),
  };
}

function targetsToGeojson(targets: MapTargetView[], draft: MapTargetView | null) {
  const all = [...targets, ...(draft ? [draft] : [])];
  return {
    type: "FeatureCollection" as const,
    features: all
      .filter((a) => a.ring && a.ring.length > 3)
      .map((a) => ({
        type: "Feature" as const,
        properties: {
          id: a.id,
          name: a.name,
          depth: a.depth,
          selected: a.selected,
          draft: draft !== null && a.id === draft.id,
          dimmed: a.state !== "pending",
        },
        geometry: { type: "Polygon" as const, coordinates: [a.ring!] },
      })),
  };
}

/** Depth reads as nesting: the broad parent recedes, the narrow child asserts. */
const DEPTH_COLORS = ["#0f766e", "#0891b2", "#6366f1"];

/** The same ramp as targetColorExpr, for DOM markers that can't use expressions. */
function depthColor(depth: number): string {
  return DEPTH_COLORS[depth] ?? DEPTH_COLORS[0]!;
}

const targetColorExpr = [
  "match",
  ["get", "depth"],
  0,
  "#0f766e",
  1,
  "#0891b2",
  2,
  "#6366f1",
  "#0f766e",
] as unknown as string;

const tierColorExpr = [
  "match",
  ["get", "tier"],
  ...Object.entries(ROLE_COLORS).flat(),
  "#64748b",
] as unknown as string;

const categoryColorExpr = [
  "match",
  ["get", "category"],
  ...Object.entries(CATEGORY_COLORS).flat(),
  "#64748b",
] as unknown as string;

/**
 * Colors a hex by one carrier's tier. Which carrier is a property name rather
 * than a filter, because every hex carries a tier for all of them: switching
 * carrier is then a repaint of tiles already in memory, with nothing refetched.
 *
 * The fallback covers tier 0 and any hex missing the property entirely, and is
 * transparent on purpose — a dead zone reads as plain basemap. A grey wash
 * would be indistinguishable from tiles that failed to load.
 */
function signalColorExpr(carrier: string): string {
  const key = isSignalCarrier(carrier) ? carrier : DEFAULT_SIGNAL_CARRIER;
  return [
    "match",
    ["get", key],
    ...SIGNAL_TIERS.flatMap((tier) => [tier, SIGNAL_COLORS[tier] ?? "transparent"]),
    "transparent",
  ] as unknown as string;
}

export function MapView(props: MapViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const targetHandlesRef = useRef<Marker[]>([]);
  const [ready, setReady] = useState(false);
  const [basemapError, setBasemapError] = useState<string | null>(null);
  const [legalError, setLegalError] = useState<string | null>(null);
  /**
   * Null until /tiles/status answers; false means the archive was never installed.
   *
   * Asking first is load-bearing, not tidiness. An unknown path under /tiles
   * does not 404 — it falls through to the SPA's not-found handler and returns
   * index.html with a 200, so pointing the style at a missing archive feeds
   * MapLibre HTML where it expects PMTiles and yields a parse error on every
   * pan. Confirming the file exists is the only way to tell "never installed"
   * apart from "broken", and it keeps the former completely quiet.
   */
  const legalPresent = useTileArchivePresent(LEGAL_ARCHIVE);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const map = new MlMap({
      container,
      style: basemapStyle({ pmtilesUrl: PMTILES_URL, assetsUrl: ASSETS_URL }),
      center: [-120, 41],
      zoom: 5,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");

    // MapLibre reports every style, source, sprite, glyph and tile failure
    // through this event and nowhere else. Without it a broken basemap renders
    // as a silent grey rectangle — exactly the kind of quiet degradation this
    // app is meant not to do.
    map.on("error", (e: { error?: Error; sourceId?: string }) => {
      const message = e.error?.message ?? "unknown map error";
      // The signal overlay is optional and separately provisioned. Reporting
      // its absence as "basemap unavailable" would send someone to check the
      // wrong archive, so it is logged and left to the legend to explain.
      if (e.sourceId === SIGNAL_SOURCE) {
        // eslint-disable-next-line no-console
        console.error("cell signal overlay error:", message);
        return;
      }
      // The legal overlay is a second archive on the same volume, and its
      // failures arrive through this one event too. Reporting them as a basemap
      // problem would misdiagnose an optional layer as the map being broken —
      // the operator would go looking at the wrong file.
      if (e.sourceId === LEGAL_SOURCE) {
        // eslint-disable-next-line no-console
        console.error("legal overlay error:", message);
        setLegalError((prev) => prev ?? message);
        return;
      }
      // eslint-disable-next-line no-console
      console.error("basemap error:", message);
      setBasemapError((prev) => prev ?? message);
    });

    map.on("load", () => {
      map.addSource("targets", { type: "geojson", data: targetsToGeojson([], null) });
      map.addSource("projected", { type: "geojson", data: projectedToGeojson([]) });
      map.addSource("routes", { type: "geojson", data: routesToGeojson([], null) });
      map.addSource("pois", { type: "geojson", data: poisToGeojson([]) });

      // Anchors first, so every route line draws on top of the regions.
      map.addLayer({
        id: "targets-fill",
        type: "fill",
        source: "targets",
        paint: {
          "fill-color": targetColorExpr,
          "fill-opacity": [
            "case",
            ["get", "dimmed"],
            0.04,
            ["get", "selected"],
            0.18,
            0.1,
          ] as unknown as number,
        },
      });
      map.addLayer({
        id: "targets-outline",
        type: "line",
        source: "targets",
        paint: {
          "line-color": targetColorExpr,
          "line-width": ["case", ["get", "selected"], 2.5, 1.5] as unknown as number,
          "line-opacity": ["case", ["get", "dimmed"], 0.3, 0.9] as unknown as number,
          "line-dasharray": ["case", ["get", "draft"], ["literal", [2, 2]], ["literal", [1, 0]]] as unknown as number[],
        },
      });

      map.addLayer({
        id: "projected-lines",
        type: "line",
        source: "projected",
        paint: { "line-color": PROJECTED_COLOR, "line-width": 2, "line-opacity": 0.7, "line-dasharray": [2, 2] },
      });
      map.addLayer({
        id: "routes-casing",
        type: "line",
        source: "routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#ffffff",
          "line-width": ["case", ["get", "highlighted"], 8, 5] as unknown as number,
        },
      });
      map.addLayer({
        id: "routes-lines",
        type: "line",
        source: "routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": tierColorExpr,
          "line-width": ["case", ["get", "highlighted"], 5, 3] as unknown as number,
          "line-opacity": ["case", ["get", "highlighted"], 1, 0.55] as unknown as number,
        },
      });
      map.addLayer({
        id: "routes-hit",
        type: "line",
        source: "routes",
        paint: { "line-color": "#000000", "line-width": 24, "line-opacity": 0 },
      });
      map.addLayer({
        id: "pois-dots",
        type: "circle",
        source: "pois",
        minzoom: 7,
        paint: {
          "circle-radius": 4.5,
          "circle-color": categoryColorExpr,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff",
        },
      });

      map.on("click", "routes-hit", (e: MapLayerMouseEvent) => {
        const id = e.features?.[0]?.properties?.id as number | undefined;
        if (id !== undefined) propsRef.current.onSelectRoute(id);
      });
      map.on("click", "pois-dots", (e: MapLayerMouseEvent) => {
        const id = e.features?.[0]?.properties?.id as number | undefined;
        if (id !== undefined) propsRef.current.onPoiClick(id);
        e.preventDefault();
      });
      map.on("click", "targets-fill", (e: MapLayerMouseEvent) => {
        // Routes and places sit on top and claim the click first; only an
        // otherwise-empty part of a region selects the region.
        if (e.defaultPrevented) return;
        const id = e.features?.[0]?.properties?.id as number | undefined;
        if (id !== undefined) propsRef.current.onTargetClick?.(id);
        e.preventDefault();
      });
      map.on("click", (e: MapLayerMouseEvent) => {
        if (e.defaultPrevented) return;
        propsRef.current.onMapClick?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
      });

      map.on("mouseenter", "routes-hit", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "routes-hit", () => (map.getCanvas().style.cursor = ""));

      let viewportTimer: ReturnType<typeof setTimeout> | null = null;
      map.on("moveend", () => {
        if (viewportTimer) clearTimeout(viewportTimer);
        viewportTimer = setTimeout(() => {
          const b = map.getBounds();
          propsRef.current.onViewportChange(
            { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() },
            map.getZoom(),
          );
        }, 300);
      });

      setReady(true);
    });

    return () => {
      for (const m of markersRef.current) m.remove();
      for (const m of targetHandlesRef.current) m.remove();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Sync data sources.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("routes") as GeoJSONSource | undefined)?.setData(
      routesToGeojson(props.routes, props.highlightedId),
    );
    (map.getSource("projected") as GeoJSONSource | undefined)?.setData(projectedToGeojson(props.routes));
  }, [props.routes, props.highlightedId, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("targets") as GeoJSONSource | undefined)?.setData(
      targetsToGeojson(props.targets ?? [], props.draftTarget ?? null),
    );
  }, [props.targets, props.draftTarget, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("pois") as GeoJSONSource | undefined)?.setData(poisToGeojson(props.pois));
  }, [props.pois, ready]);

  /**
   * Install the overlay under everything else. Added with a beforeId rather than
   * by ordering the calls, because this runs whenever the status fetch resolves
   * — which may be after the style's own layers already exist.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || legalPresent !== true) return;
    if (map.getSource(LEGAL_SOURCE)) return;

    map.addSource(LEGAL_SOURCE, { type: "vector", url: `pmtiles://${LEGAL_ARCHIVE_URL}` });

    // Anchors are the bottom-most domain layer, so everything the planner draws
    // keeps sitting on top of the legality wash.
    const under = map.getLayer("targets-fill") ? "targets-fill" : undefined;
    map.addLayer(
      {
        id: "legal-blm-fill",
        type: "fill",
        source: LEGAL_SOURCE,
        "source-layer": LEGAL_BLM_LAYER,
        paint: { "fill-color": LAND_COLORS.blm!, "fill-opacity": 0.15 },
      },
      under,
    );
    map.addLayer(
      {
        id: "legal-blm-outline",
        type: "line",
        source: LEGAL_SOURCE,
        "source-layer": LEGAL_BLM_LAYER,
        paint: { "line-color": LAND_COLORS.blm!, "line-width": 0.8, "line-opacity": 0.5 },
      },
      under,
    );
    map.addLayer(
      {
        id: "legal-usfs-fill",
        type: "fill",
        source: LEGAL_SOURCE,
        "source-layer": LEGAL_USFS_LAYER,
        paint: { "fill-color": LAND_COLORS.usfs!, "fill-opacity": 0.18 },
      },
      under,
    );
    map.addLayer(
      {
        id: "legal-usfs-outline",
        type: "line",
        source: LEGAL_SOURCE,
        "source-layer": LEGAL_USFS_LAYER,
        paint: {
          "line-color": LAND_COLORS.usfs!,
          "line-width": 1,
          "line-opacity": 0.75,
          "line-dasharray": legalDashExpr,
        },
      },
      under,
    );
  }, [ready, legalPresent]);

  // Legend toggles. Layout visibility rather than removing layers, so switching
  // back on does not re-request tiles that are already in the cache.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || legalPresent !== true) return;
    const hidden = props.hiddenLandLayers;
    for (const [key, ids] of Object.entries(LEGAL_LAYER_IDS)) {
      for (const id of ids) {
        if (!map.getLayer(id)) continue;
        map.setLayoutProperty(id, "visibility", hidden?.has(key) ? "none" : "visible");
      }
    }
  }, [props.hiddenLandLayers, ready, legalPresent]);

  // DOM markers: numbered stops of the highlighted route + position pin.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const m of markersRef.current) m.remove();
    markersRef.current = [];

    const route = props.routes.find((r) => r.id === props.highlightedId);
    if (route) {
      for (const stop of route.stops) {
        const el = document.createElement("button");
        el.className = "vl-stop-marker" + (stop.visited ? " vl-stop-visited" : "");
        el.textContent = String(stop.orderIndex + 1);
        el.title = stop.name;
        el.onclick = (ev) => {
          ev.stopPropagation();
          propsRef.current.onStopClick(route.id, stop.orderIndex);
        };
        markersRef.current.push(
          new Marker({ element: el }).setLngLat([stop.lng, stop.lat]).addTo(map),
        );
      }
    }
    if (props.position) {
      const el = document.createElement("div");
      el.className = "vl-position-pin";
      el.title = "Last recorded position";
      markersRef.current.push(
        new Marker({ element: el })
          .setLngLat([props.position.lng, props.position.lat])
          .addTo(map),
      );
    }

    if (props.origin) {
      const el = document.createElement("div");
      el.className = "vl-origin-pin";
      el.title = `Origin — ${props.origin.name}`;
      markersRef.current.push(
        new Marker({ element: el }).setLngLat([props.origin.lng, props.origin.lat]).addTo(map),
      );
    }

    // Exact-point Targets have no ring, so the fill layer draws nothing for
    // them — including the destination. Pins are what make them exist on the
    // map at all. DOM markers rather than a symbol layer: a symbol layer needs
    // glyphs, and a glyph 404 would leave an unlabelled dot behind.
    for (const t of props.targets ?? []) {
      if (t.radiusMiles > 0 && !t.final) continue;
      const el = document.createElement("button");
      el.className =
        "vl-target-pin" +
        (t.final ? " vl-target-pin-final" : "") +
        (t.selected ? " vl-target-pin-selected" : "") +
        (t.state === "pending" ? "" : " vl-target-pin-dim");
      el.textContent = t.final ? "★" : t.ordinal === null ? "•" : String(t.ordinal);
      el.title = t.final ? `${t.name} — final Target` : t.name;
      if (!t.final) el.style.background = depthColor(t.depth);
      el.onclick = (ev) => {
        ev.stopPropagation();
        propsRef.current.onTargetClick?.(t.id);
      };
      markersRef.current.push(new Marker({ element: el }).setLngLat([t.center.lng, t.center.lat]).addTo(map));
    }
  }, [props.routes, props.highlightedId, props.position, props.origin, props.targets, ready]);

  /**
   * Drag handles for the selected Target: one at the centre to move the region,
   * one on its edge to resize it. The edge handle reports its raw position and
   * the page turns that into a radius — converting here would mean doing
   * geometry, which is exactly what this component does not do.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const m of targetHandlesRef.current) m.remove();
    targetHandlesRef.current = [];

    const selected = (props.targets ?? []).find((a) => a.selected);
    if (!selected || !props.onTargetCenterDrag || selected.radiusMiles <= 0) return;

    const centerEl = document.createElement("div");
    centerEl.className = "vl-anchor-handle vl-anchor-handle-center";
    centerEl.title = `Drag to move "${selected.name}"`;
    const centerMarker = new Marker({ element: centerEl, draggable: true })
      .setLngLat([selected.center.lng, selected.center.lat])
      .addTo(map);
    centerMarker.on("drag", () => {
      const p = centerMarker.getLngLat();
      propsRef.current.onTargetCenterDrag?.(selected.id, { lat: p.lat, lng: p.lng }, false);
    });
    centerMarker.on("dragend", () => {
      const p = centerMarker.getLngLat();
      propsRef.current.onTargetCenterDrag?.(selected.id, { lat: p.lat, lng: p.lng }, true);
    });
    targetHandlesRef.current.push(centerMarker);

    // The ring is generated from due north clockwise, so a quarter of the way
    // round is due east — picked by index, not computed.
    const ring = selected.ring;
    if (ring && ring.length > 4 && props.onTargetRadiusDrag) {
      const east = ring[Math.floor((ring.length - 1) / 4)]!;
      const edgeEl = document.createElement("div");
      edgeEl.className = "vl-anchor-handle vl-anchor-handle-edge";
      edgeEl.title = "Drag to resize";
      const edgeMarker = new Marker({ element: edgeEl, draggable: true })
        .setLngLat(east)
        .addTo(map);
      edgeMarker.on("drag", () => {
        const p = edgeMarker.getLngLat();
        propsRef.current.onTargetRadiusDrag?.(selected.id, { lat: p.lat, lng: p.lng }, false);
      });
      edgeMarker.on("dragend", () => {
        const p = edgeMarker.getLngLat();
        propsRef.current.onTargetRadiusDrag?.(selected.id, { lat: p.lat, lng: p.lng }, true);
      });
      targetHandlesRef.current.push(edgeMarker);
    }
  }, [props.targets, ready]);

  /**
   * Fit when asked. `fitTo` frames exactly what it is given — selecting a
   * Target passes its own ring, so the view does not zoom back out to the whole
   * trip. With no `fitTo`, everything drawn is framed: routes, position, Origin
   * and every Target. Leaving Targets out of that gather is why fitting to one
   * used to do nothing whenever no route was on the map.
   */
  const lastFitKey = useRef("");
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || props.fitKey === lastFitKey.current) return;
    lastFitKey.current = props.fitKey;

    let coords: [number, number][];
    if (props.fitTo && props.fitTo.length > 0) {
      coords = props.fitTo;
    } else {
      coords = props.routes.flatMap((r) => [...r.coordinates, ...(r.projected ?? [])]);
      if (props.position) coords.push([props.position.lng, props.position.lat]);
      if (props.origin) coords.push([props.origin.lng, props.origin.lat]);
      for (const t of props.targets ?? []) {
        if (t.ring && t.ring.length > 3) coords.push(...t.ring);
        else coords.push([t.center.lng, t.center.lat]);
      }
      if (props.draftTarget?.ring) coords.push(...props.draftTarget.ring);
    }

    if (coords.length === 0) return;

    // fitBounds on a zero-area box zooms to maximum, so a lone point is eased
    // to instead of fitted.
    if (coords.length === 1) {
      map.easeTo({ center: coords[0]!, zoom: Math.max(map.getZoom(), 9), duration: 500 });
      return;
    }
    let west = coords[0]![0], east = coords[0]![0], south = coords[0]![1], north = coords[0]![1];
    for (const [lng, lat] of coords) {
      west = Math.min(west, lng); east = Math.max(east, lng);
      south = Math.min(south, lat); north = Math.max(north, lat);
    }
    if (west === east && south === north) {
      map.easeTo({ center: [west, south], zoom: Math.max(map.getZoom(), 9), duration: 500 });
      return;
    }
    map.fitBounds([[west, south], [east, north]], { padding: 48, duration: 500 });
  }, [props.fitKey, props.routes, props.position, props.origin, props.targets, props.fitTo, props.draftTarget, ready]);

  // A small deliberate set of places must not vanish under the catalog's
  // zoom floor — showing nothing would read as "there is nothing here".
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!map.getLayer("pois-dots")) return;
    map.setLayerZoomRange("pois-dots", props.poiMinZoom ?? 7, 24);
  }, [props.poiMinZoom, ready]);

  // Category filter. Done on the layer rather than by rebuilding the source so
  // a toggle repaints on the next frame — the query that narrows the fetch is
  // in flight at the same time, and the dots must not wait for it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!map.getLayer("pois-dots")) return;
    const hidden = props.hiddenCategories;
    map.setFilter(
      "pois-dots",
      hidden === undefined || hidden.size === 0
        ? null
        : (["!", ["in", ["get", "category"], ["literal", [...hidden]]]] as unknown as never),
    );
  }, [props.hiddenCategories, ready]);

  // The signal overlay is added here rather than in the load handler because
  // until the page has asked /tiles/status we do not know the archive exists,
  // and a source pointed at a missing one spends the whole tile budget on 404s.
  // Re-runs when the version changes, which is how a refreshed archive gets
  // picked up: the version is in the URL, so the browser cannot serve the
  // previous archive's byte ranges for the new one.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const version = props.signalVersion;
    if (version === undefined) return;

    if (map.getLayer(SIGNAL_LAYER)) map.removeLayer(SIGNAL_LAYER);
    if (map.getSource(SIGNAL_SOURCE)) map.removeSource(SIGNAL_SOURCE);

    map.addSource(SIGNAL_SOURCE, {
      type: "vector",
      url: `${SIGNAL_PMTILES_URL}?v=${encodeURIComponent(version)}`,
    });
    // Below targets-fill, which is the lowest layer this component adds — so
    // the overlay sits on the basemap and every route, ring and dot stays
    // legible on top of it.
    map.addLayer(
      {
        id: SIGNAL_LAYER,
        type: "fill",
        source: SIGNAL_SOURCE,
        "source-layer": SIGNAL_SOURCE_LAYER,
        layout: { visibility: propsRef.current.showSignal ? "visible" : "none" },
        paint: {
          "fill-color": signalColorExpr(propsRef.current.signalCarrier ?? DEFAULT_SIGNAL_CARRIER),
          // Enough to read the ramp, little enough to leave roads and labels
          // underneath it readable — this is advisory context, not the subject.
          "fill-opacity": 0.5,
        },
      },
      map.getLayer("targets-fill") ? "targets-fill" : undefined,
    );
  }, [props.signalVersion, ready]);

  // Toggled on the layer rather than by adding and removing it: re-adding
  // would re-parse the style and re-request every tile, where this repaints
  // on the next frame from tiles already in memory.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!map.getLayer(SIGNAL_LAYER)) return;
    map.setLayoutProperty(SIGNAL_LAYER, "visibility", props.showSignal ? "visible" : "none");
  }, [props.showSignal, props.signalVersion, ready]);

  // Every hex carries a tier for every carrier, so switching carrier is a
  // repaint of the same tiles — nothing is refetched and nothing reloads.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!map.getLayer(SIGNAL_LAYER)) return;
    map.setPaintProperty(
      SIGNAL_LAYER,
      "fill-color",
      signalColorExpr(props.signalCarrier ?? DEFAULT_SIGNAL_CARRIER),
    );
  }, [props.signalCarrier, props.signalVersion, ready]);

  return (
    <div style={{ position: "relative", width: "100%", height: props.heightStyle }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      {basemapError && (
        <div className="vl-basemap-error" role="status">
          <strong>Basemap unavailable</strong>
          <span>{basemapError}</span>
          <span className="vl-basemap-error-hint">
            Routes and stops below are unaffected. Check the tile archive on the van server.
          </span>
        </div>
      )}
      {/* Only when the archive was advertised and then failed. A van that never
          installed it says so on the Status page and stays quiet here. */}
      {!basemapError && legalError && (
        <div className="vl-legal-error" role="status">
          <strong>Legal camping overlay unavailable</strong>
          <span>Land is unshaded — that is missing data, not "no camping here".</span>
        </div>
      )}
    </div>
  );
}
