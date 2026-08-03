import { useEffect, useState, type JSX } from "react";
import { GeocodeField } from "../components/GeocodeField.js";
import { shortPlaceName } from "../lib/geocode.js";

/**
 * Create or edit a trip: its name, its Origin, its final Target, and the pace.
 *
 * Built on the modal shell rather than FormModal because FormModal handles flat
 * scalar fields and both endpoints here want place search.
 *
 * Neither endpoint is editable by dragging it on the map, deliberately. Moving
 * one resets the frozen baseline and forces a re-route on the next plan; making
 * that a drag would fire it on every frame of a gesture. Area Targets stay
 * draggable — they do not touch the baseline.
 */

export interface TripEditValues {
  name: string;
  originName: string;
  origin: { lat: number; lng: number };
  destName: string;
  dest: { lat: number; lng: number };
  dailyDriveHours: number;
}

export interface TripEditModalProps {
  mode: "create" | "edit";
  initial: TripEditValues | null;
  /** What a new trip starts at, from Settings. Ignored when editing. */
  defaultDailyDriveHours?: number;
  /** Warns before an edit that will reset the frozen baseline. */
  hasBaseline: boolean;
  busy: boolean;
  error: string | null;
  onSubmit: (v: TripEditValues, moved: { origin: boolean; dest: boolean }) => void;
  onClose: () => void;
}

const BLANK: TripEditValues = {
  name: "New adventure",
  originName: "",
  origin: { lat: 0, lng: 0 },
  destName: "",
  dest: { lat: 0, lng: 0 },
  dailyDriveHours: 4,
};

export function TripEditModal(props: TripEditModalProps): JSX.Element {
  const start =
    props.initial ?? { ...BLANK, dailyDriveHours: props.defaultDailyDriveHours ?? BLANK.dailyDriveHours };
  const [v, setV] = useState<TripEditValues>(start);
  const [originSet, setOriginSet] = useState(props.mode === "edit");
  const [destSet, setDestSet] = useState(props.mode === "edit");
  const [paceTouched, setPaceTouched] = useState(false);

  // The operator's default can land after this form opens — the very first trip
  // opens it on page load. Adopt it until someone types their own number.
  const { mode, defaultDailyDriveHours } = props;
  useEffect(() => {
    if (mode !== "create" || paceTouched || defaultDailyDriveHours === undefined) return;
    setV((cur) => ({ ...cur, dailyDriveHours: defaultDailyDriveHours }));
  }, [mode, paceTouched, defaultDailyDriveHours]);

  const movedOrigin = v.origin.lat !== start.origin.lat || v.origin.lng !== start.origin.lng;
  const movedDest = v.dest.lat !== start.dest.lat || v.dest.lng !== start.dest.lng;
  const willReset = props.mode === "edit" && props.hasBaseline && (movedOrigin || movedDest);
  const ready = v.name.trim().length > 0 && originSet && destSet && v.originName.trim() && v.destName.trim();

  return (
    <div className="vl-modal-backdrop" onClick={props.onClose}>
      <div className="vl-modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{props.mode === "create" ? "New trip" : "Edit trip"}</h3>

        <label>
          Trip name
          <input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} style={{ width: "100%" }} />
        </label>

        <fieldset style={{ border: "1px solid #e5e7eb", borderRadius: 8, margin: "10px 0" }}>
          <legend>Origin</legend>
          <GeocodeField
            label={v.originName ? "Change the Origin" : "Set the Origin"}
            placeholder="Portland, OR"
            value={v.originName || null}
            onPick={(h) => {
              setV((cur) => ({
                ...cur,
                originName: shortPlaceName(h.name),
                origin: { lat: h.lat, lng: h.lng },
              }));
              setOriginSet(true);
            }}
          />
        </fieldset>

        <fieldset style={{ border: "1px solid #e5e7eb", borderRadius: 8, margin: "10px 0" }}>
          <legend>Final Target</legend>
          <GeocodeField
            label={v.destName ? "Change the final Target" : "Set the final Target"}
            placeholder="Las Vegas, NV"
            value={v.destName || null}
            onPick={(h) => {
              setV((cur) => ({
                ...cur,
                destName: shortPlaceName(h.name),
                dest: { lat: h.lat, lng: h.lng },
              }));
              setDestSet(true);
            }}
          />
        </fieldset>

        <label>
          Daily drive hours
          <input
            type="number"
            min={1}
            max={12}
            value={v.dailyDriveHours}
            onChange={(e) => {
              setPaceTouched(true);
              setV({ ...v, dailyDriveHours: Number(e.target.value) });
            }}
            style={{ width: "100%" }}
          />
        </label>

        {willReset ? (
          <div className="vl-offline" style={{ marginTop: 10 }}>
            Moving an endpoint resets the direct-drive baseline, so the deviation budget is
            recomputed from the new route rather than kept from the old one. It fills in the next
            time routing is reachable.
          </div>
        ) : null}
        {props.error ? (
          <div className="vl-warning" style={{ marginTop: 10 }}>
            {props.error}
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button type="button" className="vl-checkin-btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="vl-checkin-btn"
            disabled={!ready || props.busy}
            onClick={() => props.onSubmit(v, { origin: movedOrigin, dest: movedDest })}
          >
            {props.mode === "create" ? "Create trip" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
