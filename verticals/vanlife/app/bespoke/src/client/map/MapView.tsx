import { useEffect, useRef, useState, type JSX } from "react";
import {
  Map as MlMap,
  Marker,
  NavigationControl,
  type GeoJSONSource,
  type MapLayerMouseEvent,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { basemapStyle, registerPmtilesProtocol } from "@elements/shell-map-view/client";
import { CATEGORY_COLORS, PROJECTED_COLOR, ROLE_COLORS } from "./palette.js";
import type { CandidateRouteView, MapViewProps } from "./types.js";

/**
 * Imperative MapLibre wrapped in a presentation-only component: props in,
 * callbacks out, zero domain imports. The basemap is the locally served
 * PMTiles archive — every URL in the style resolves to the van server.
 */

registerPmtilesProtocol();

const PMTILES_URL = "/tiles/basemap.pmtiles";
const ASSETS_URL = "/tiles";

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

export function MapView(props: MapViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const [ready, setReady] = useState(false);
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

    map.on("load", () => {
      map.addSource("projected", { type: "geojson", data: projectedToGeojson([]) });
      map.addSource("routes", { type: "geojson", data: routesToGeojson([], null) });
      map.addSource("pois", { type: "geojson", data: poisToGeojson([]) });

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
    (map.getSource("pois") as GeoJSONSource | undefined)?.setData(poisToGeojson(props.pois));
  }, [props.pois, ready]);

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
      markersRef.current.push(
        new Marker({ element: el })
          .setLngLat([props.position.lng, props.position.lat])
          .addTo(map),
      );
    }
  }, [props.routes, props.highlightedId, props.position, ready]);

  // Fit to routes when asked.
  const lastFitKey = useRef("");
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || props.fitKey === lastFitKey.current) return;
    lastFitKey.current = props.fitKey;
    const coords = props.routes.flatMap((r) => [...r.coordinates, ...(r.projected ?? [])]);
    if (props.position) coords.push([props.position.lng, props.position.lat]);
    if (coords.length < 2) return;
    let west = coords[0]![0], east = coords[0]![0], south = coords[0]![1], north = coords[0]![1];
    for (const [lng, lat] of coords) {
      west = Math.min(west, lng); east = Math.max(east, lng);
      south = Math.min(south, lat); north = Math.max(north, lat);
    }
    map.fitBounds([[west, south], [east, north]], { padding: 48, duration: 500 });
  }, [props.fitKey, props.routes, props.position, ready]);

  return <div ref={containerRef} style={{ width: "100%", height: props.heightStyle }} />;
}
