/** Plain presentation types — MapView must stay free of tRPC/domain imports. */

/**
 * The synthesized final Target's id, mirroring engine/targets.ts.
 *
 * Duplicated rather than imported because this module is deliberately free of
 * server imports; the map keys DOM markers by number and needs the sentinel.
 */
export const FINAL_TARGET_ID = -1;

/**
 * The id carried by the live draft ring while placing or dragging. Distinct
 * from FINAL_TARGET_ID so the two sentinels can never be confused for each
 * other when the map keys markers by id.
 */
export const DRAFT_TARGET_ID = -2;

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
  /** Gray continuation to the final Target. */
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
 * A Target to draw. The ring arrives pre-computed — the map never does
 * geometry, which is what keeps this component presentation-only.
 */
export interface MapTargetView {
  id: number;
  name: string;
  center: { lat: number; lng: number };
  radiusMiles: number;
  /** Closed ring in [lng, lat] order. Null for an exact-point Target. */
  ring: [number, number][] | null;
  depth: number;
  state: "pending" | "visited" | "skipped";
  /** Where the route actually passes through, if resolved. */
  resolved: { lat: number; lng: number } | null;
  selected: boolean;
  /** The trip's destination. Drawn as a star rather than a number. */
  final: boolean;
  /** Its place in the list, for the pin label. Null for a nested narrowing. */
  ordinal: number | null;
}

/** Where the trip starts, as distinct from where the van is now. */
export interface MapOriginView {
  name: string;
  lat: number;
  lng: number;
}

export interface MapViewProps {
  routes: CandidateRouteView[];
  highlightedId: number | null;
  pois: MapPoiView[];
  /** Where the van is now — the last recorded position. */
  position: { lat: number; lng: number } | null;
  /** Bump to re-fit the viewport. */
  fitKey: string;
  /**
   * Exactly what to frame on the next fit, in [lng, lat] order. Null fits
   * everything on the map, which is what a trip switch wants; a selected
   * Target passes its own ring so the fit does not zoom back out to the trip.
   */
  fitTo?: [number, number][] | null;
  /**
   * Zoom below which places stop drawing. The default keeps a catalog of
   * hundreds from smearing the map when zoomed out; a caller showing a small
   * deliberate set — an open place search, say — can lower it so the set is
   * actually visible.
   */
  poiMinZoom?: number;
  /**
   * Place categories to hide. Undefined applies no filter at all, which is
   * what a caller showing a small deliberate set wants — those places were
   * asked for by name and must not be silently withheld.
   */
  hiddenCategories?: Set<string>;
  /**
   * Whether to draw the cell signal overlay. The layer is added either way —
   * toggling visibility repaints on the next frame, where adding and removing
   * the layer would re-parse the style and re-request tiles every time.
   */
  showSignal?: boolean;
  /**
   * Which carrier's coverage the overlay colors by: one of the keys in
   * SIGNAL_CARRIERS. Undefined means the default, "best of any carrier".
   */
  signalCarrier?: string;
  /**
   * Identifies the installed overlay archive — in practice the FCC "as of"
   * date. Undefined means not known yet, or no archive installed at all, and
   * the overlay is not added to the map until it is known: a source pointed at
   * a missing archive would spend the tile budget on 404s.
   *
   * It also travels in the tile URL, so an archive replaced in place by the
   * scheduled refresh is not masked by the browser's cache of the old one.
   */
  signalVersion?: string;
  onSelectRoute: (id: number) => void;
  onStopClick: (routeId: number, orderIndex: number) => void;
  onPoiClick: (id: number) => void;
  onViewportChange: (bbox: { south: number; west: number; north: number; east: number }, zoom: number) => void;
  heightStyle: string;
  /** Targets to draw beneath the routes. */
  targets?: MapTargetView[];
  /** Live preview while placing or resizing, drawn dashed. */
  draftTarget?: MapTargetView | null;
  /** Where the trip starts, drawn as a static pin. */
  origin?: MapOriginView | null;
  onTargetClick?: (id: number) => void;
  /** Fires on any map click the layers did not consume; the page decides if it cares. */
  onMapClick?: (point: { lat: number; lng: number }) => void;
  /**
   * Centre handle dragged. Fires continuously with `done: false` for a live
   * preview, then once with `done: true` to commit.
   */
  onTargetCenterDrag?: (id: number, center: { lat: number; lng: number }, done: boolean) => void;
  /**
   * Edge handle dragged, reporting the handle's raw position — the caller
   * converts that to a radius, so this component stays free of geometry.
   */
  onTargetRadiusDrag?: (id: number, handle: { lat: number; lng: number }, done: boolean) => void;
}
