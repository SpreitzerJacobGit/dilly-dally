import type { JSX } from "react";
import { RADIUS_STOPS, nearestStop, type TargetNode } from "./types.js";

/**
 * The selected area Target: rename it, resize it, date it, and pick what
 * inside it the route should actually go through.
 */

export interface SuggestedPlace {
  id: number;
  name: string;
  category: string;
  lat: number;
  lng: number;
}

export interface TargetDetailProps {
  target: TargetNode;
  suggestions: SuggestedPlace[];
  suggestionsLoading: boolean;
  onRename: (name: string) => void;
  onRadius: (radiusMiles: number) => void;
  onArriveBy: (date: string | null) => void;
  onClearPin: () => void;
  onNarrowToPlace: (poiId: number) => void;
  onPinPlace: (place: SuggestedPlace) => void;
}

export function TargetDetail(props: TargetDetailProps): JSX.Element {
  const t = props.target;
  return (
    <div className="vl-anchor-detail">
      <h4>{t.name}</h4>
      <p className="vl-drop-hint" style={{ marginTop: 0 }}>
        Drag the centre dot on the map to move this area, or the edge dot to resize it.
      </p>
      <label>
        Name
        <input
          defaultValue={t.name}
          key={`name-${String(t.id)}`}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== t.name) props.onRename(v);
          }}
          style={{ width: "100%" }}
        />
      </label>
      <label>
        Radius: <strong>{String(t.radiusMiles)} mi</strong>
        <input
          type="range"
          min={0}
          max={RADIUS_STOPS.length - 1}
          step={1}
          value={nearestStop(t.radiusMiles)}
          onChange={(e) => props.onRadius(RADIUS_STOPS[Number(e.target.value)]!)}
          style={{ width: "100%" }}
        />
      </label>
      <label>
        Be there by
        <input
          type="date"
          value={t.arriveBy ?? ""}
          onChange={(e) => props.onArriveBy(e.target.value || null)}
        />
      </label>
      {t.pinned ? (
        <button type="button" onClick={props.onClearPin}>
          Clear pinned spot
        </button>
      ) : null}

      <h5>Places inside this area</h5>
      {props.suggestionsLoading ? <small>loading…</small> : null}
      {!props.suggestionsLoading && props.suggestions.length === 0 ? (
        <small>
          Nothing known here yet. The hourly place sweep prioritises Target areas, so this usually
          fills in within the hour.
        </small>
      ) : null}
      <ul className="vl-suggestions">
        {props.suggestions.slice(0, 20).map((p) => (
          <li key={p.id}>
            <span>
              {p.name} <small>{p.category}</small>
            </span>
            <span>
              <button
                type="button"
                title="Make this a narrower Target inside the area"
                onClick={() => props.onNarrowToPlace(p.id)}
                disabled={t.depth >= 2}
              >
                Narrow to this
              </button>
              <button type="button" title="Route through exactly this spot" onClick={() => props.onPinPlace(p)}>
                📌
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
