import { useState, type JSX } from "react";

/**
 * Which trip is on screen, and what can be done to it.
 *
 * A native <select>: the list is short, it is genuinely good on a phone, and it
 * is keyboard-accessible without any work. "Make active" is deliberately an
 * item in the menu rather than a side effect of switching — changing which trip
 * the van is on is a different act from looking at one.
 */

export interface TripPickerProps {
  trips: { id: number; name: string; status: string }[];
  tripId: number | null;
  activeTripId: number | null;
  onSelect: (id: number) => void;
  onNew: () => void;
  onEdit: () => void;
  onMakeActive: () => void;
  onDelete: () => void;
}

export function TripPicker(props: TripPickerProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const current = props.trips.find((t) => t.id === props.tripId) ?? null;
  const isActive = current !== null && current.id === props.activeTripId;

  return (
    <div>
      <div className="vl-trip-picker">
        <select
          value={props.tripId ?? ""}
          onChange={(e) => props.onSelect(Number(e.target.value))}
          aria-label="Trip"
        >
          {props.trips.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} — {t.status}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="vl-checkin-btn"
          title="Trip actions"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          ⋯
        </button>
      </div>

      {menuOpen ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {!isActive && current ? (
            <button
              type="button"
              className="vl-checkin-btn"
              onClick={() => {
                props.onMakeActive();
                setMenuOpen(false);
              }}
            >
              Make active
            </button>
          ) : null}
          <button
            type="button"
            className="vl-checkin-btn"
            onClick={() => {
              props.onEdit();
              setMenuOpen(false);
            }}
            disabled={!current}
          >
            Edit trip
          </button>
          <button
            type="button"
            className="vl-checkin-btn"
            onClick={() => {
              props.onNew();
              setMenuOpen(false);
            }}
          >
            New trip
          </button>
          <button
            type="button"
            className="vl-checkin-btn"
            onClick={() => {
              props.onDelete();
              setMenuOpen(false);
            }}
            disabled={!current || isActive}
            title={
              isActive
                ? "The trip the van is on can't be deleted — complete it first."
                : "Delete this trip and its history"
            }
          >
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}
