import { useState, type JSX } from "react";
import { GeocodeField } from "../components/GeocodeField.js";
import { coordLabel, type GeocodeHit } from "../lib/geocode.js";

/**
 * "We are here" — where the van is right now, plus how far it drove to get here.
 *
 * This is the screen that most wanted the device's own position and had it
 * least: it used to be two number fields, filled in by reading coordinates off
 * a phone and typing them back into the phone. Built on the modal shell rather
 * than FormModal for the same reason TripEditModal is — FormModal handles flat
 * scalar fields, and this one wants place search.
 *
 * The mileage stays a manual number on purpose. It is the odometer delta the
 * operator actually drove, not the straight line between two pins, and levels
 * that drain per mile are derived from it — guessing it from geometry would
 * quietly make every fuel and water estimate wrong.
 */

export interface SetPositionModalProps {
  busy: boolean;
  onSubmit: (v: { lat: number; lng: number; milesSinceLast: number }) => void;
  onClose: () => void;
}

export function SetPositionModal(props: SetPositionModalProps): JSX.Element {
  const [at, setAt] = useState<GeocodeHit | null>(null);
  const [miles, setMiles] = useState("0");

  const milesNum = Number(miles);
  const milesValid = miles.trim() !== "" && Number.isFinite(milesNum) && milesNum >= 0;
  const ready = at !== null && milesValid;

  return (
    <div className="vl-modal-backdrop" onClick={props.onClose}>
      <div className="vl-modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>We are here</h3>
        <p style={{ color: "#666", fontSize: ".85rem" }}>
          Plans generated after this start from the given position.
        </p>

        <GeocodeField
          label="Where are we?"
          placeholder="City, address, or place"
          value={at ? at.name : null}
          autoFocus
          onPick={setAt}
        />

        <label style={{ display: "block", fontSize: ".85rem", marginTop: 12 }}>
          Miles driven since last recorded position (approx.)
          <input
            type="number"
            min={0}
            step="any"
            value={miles}
            onChange={(e) => setMiles(e.target.value)}
            style={{ display: "block", width: "100%", padding: 6, marginTop: 4 }}
          />
        </label>
        {!milesValid ? <p className="field-error">Enter the miles driven — 0 if we have not moved.</p> : null}

        {at ? (
          <p style={{ color: "#666", fontSize: ".8rem", marginTop: 8 }}>
            Recording {coordLabel(at.lat, at.lng)}
          </p>
        ) : null}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button type="button" className="vl-checkin-btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="vl-checkin-btn"
            style={{ fontWeight: 700 }}
            disabled={!ready || props.busy}
            onClick={() => {
              if (!at) return;
              props.onSubmit({ lat: at.lat, lng: at.lng, milesSinceLast: milesNum });
            }}
          >
            Set position
          </button>
        </div>
      </div>
    </div>
  );
}
