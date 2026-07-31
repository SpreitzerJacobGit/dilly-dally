/** Plain presentation types — MapView must stay free of tRPC/domain imports. */

export interface RouteStopView {
  orderIndex: number;
  name: string;
  lat: number;
  lng: number;
  purpose: string;
  needId: number | null;
  poiId: number | null;
  etaMinutesFromStart: number;
  visited?: boolean;
}

export interface CandidateRouteView {
  id: number;
  tier: string;
  title: string;
  /** GeoJSON LineString coordinates of today's leg. */
  coordinates: [number, number][];
  /** Gray continuation to the anchor. */
  projected: [number, number][] | null;
  stops: RouteStopView[];
  selected: boolean;
}

export interface MapPoiView {
  id: number;
  name: string;
  category: string;
  lat: number;
  lng: number;
}

/**
 * An anchor region to draw. The ring arrives pre-computed — the map never does
 * geometry, which is what keeps this component presentation-only.
 */
export interface MapAnchorView {
  id: number;
  name: string;
  center: { lat: number; lng: number };
  radiusMiles: number;
  /** Closed ring in [lng, lat] order. Null for an exact-point anchor. */
  ring: [number, number][] | null;
  depth: number;
  state: "pending" | "visited" | "skipped";
  /** Where the route actually passes through, if resolved. */
  resolved: { lat: number; lng: number } | null;
  selected: boolean;
}

export interface MapViewProps {
  routes: CandidateRouteView[];
  highlightedId: number | null;
  pois: MapPoiView[];
  position: { lat: number; lng: number } | null;
  /** Bump to re-fit the viewport to the routes. */
  fitKey: string;
  onSelectRoute: (id: number) => void;
  onStopClick: (routeId: number, orderIndex: number) => void;
  onPoiClick: (id: number) => void;
  onViewportChange: (bbox: { south: number; west: number; north: number; east: number }, zoom: number) => void;
  heightStyle: string;
  /** Anchor regions to draw beneath the routes. */
  anchors?: MapAnchorView[];
  /** Live preview while placing or resizing, drawn dashed. */
  draftAnchor?: MapAnchorView | null;
  onAnchorClick?: (id: number) => void;
  /** Fires on any map click the layers did not consume; the page decides if it cares. */
  onMapClick?: (point: { lat: number; lng: number }) => void;
}
