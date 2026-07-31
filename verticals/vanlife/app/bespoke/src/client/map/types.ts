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
}
