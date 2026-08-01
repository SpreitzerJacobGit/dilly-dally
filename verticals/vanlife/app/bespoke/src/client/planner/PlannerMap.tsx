import type { JSX } from "react";
import { MapView } from "../map/MapView.js";
import type { CandidateRouteView, MapOriginView, MapPoiView, MapTargetView } from "../map/types.js";
import { ROLE_LABELS, roleColor, PROJECTED_COLOR } from "../map/palette.js";
import { DigestBanner, type DigestView } from "../components/DigestBanner.js";

/**
 * The map pane: the map itself plus the three things that overlay it.
 *
 * The banner slot is shared and never stacked. Two absolutely-positioned
 * banners would push the second one over the basemap-error overlay below them,
 * and that error exists precisely so a broken map cannot look like an empty
 * one. While placing a Target the placement hint wins — it is a thing the
 * operator started seconds ago, where the digest is ambient and its dismissal
 * is remembered anyway.
 */

export interface PlannerMapProps {
  routes: CandidateRouteView[];
  highlightedId: number | null;
  pois: MapPoiView[];
  /** Says which set of places the dots are, so their vanishing is never a mystery. */
  poiSourceLabel: string;
  /** Lowered when the dots are a small deliberate set rather than the catalog. */
  poiMinZoom?: number;
  position: { lat: number; lng: number } | null;
  origin: MapOriginView | null;
  targets: MapTargetView[];
  draftTarget: MapTargetView | null;
  fitKey: string;
  fitTo: [number, number][] | null;
  placingLabel: string | null;
  digest: DigestView | null;
  userKey: string;
  detail: JSX.Element | null;
  onSelectRoute: (id: number) => void;
  onStopClick: (routeId: number, orderIndex: number) => void;
  onPoiClick: (id: number) => void;
  onTargetClick: (id: number) => void;
  onMapClick: (point: { lat: number; lng: number }) => void;
  onTargetCenterDrag: (id: number, center: { lat: number; lng: number }, done: boolean) => void;
  onTargetRadiusDrag: (id: number, handle: { lat: number; lng: number }, done: boolean) => void;
  onViewportChange: (bbox: { south: number; west: number; north: number; east: number }, zoom: number) => void;
}

export function PlannerMap(props: PlannerMapProps): JSX.Element {
  return (
    <div className="vl-map-pane">
      {props.placingLabel !== null ? (
        <div className="vl-banner">
          <h4>{props.placingLabel}</h4>
          <div style={{ fontSize: ".85rem" }}>Search for a place or click the map to set the centre.</div>
        </div>
      ) : (
        <DigestBanner digest={props.digest} userKey={props.userKey} />
      )}

      <MapView
        routes={props.routes}
        highlightedId={props.highlightedId}
        pois={props.pois}
        poiMinZoom={props.poiMinZoom}
        position={props.position}
        origin={props.origin}
        targets={props.targets}
        draftTarget={props.draftTarget}
        fitKey={props.fitKey}
        fitTo={props.fitTo}
        onSelectRoute={props.onSelectRoute}
        onStopClick={props.onStopClick}
        onPoiClick={props.onPoiClick}
        onTargetClick={props.onTargetClick}
        onMapClick={props.onMapClick}
        onTargetCenterDrag={props.onTargetCenterDrag}
        onTargetRadiusDrag={props.onTargetRadiusDrag}
        onViewportChange={props.onViewportChange}
        heightStyle="100%"
      />

      <div className="vl-legend">
        {Object.entries(ROLE_LABELS).map(([tier, label]) => (
          <div key={tier}>
            <span className="vl-line" style={{ background: roleColor(tier) }} /> {label}
          </div>
        ))}
        <div>
          <span className="vl-line" style={{ background: PROJECTED_COLOR }} /> Projected future
        </div>
        <div style={{ marginTop: 4, color: "#555" }}>{props.poiSourceLabel}</div>
      </div>

      {props.detail}
    </div>
  );
}
