import type { JSX } from "react";

/**
 * Where the trip starts.
 *
 * Shown above the Targets rather than as one of them, because it is not a place
 * the route is steered through — it is the end the route is measured from. Once
 * a position has been recorded the van is somewhere else entirely, and the row
 * says so rather than implying the trip still begins here.
 */

export interface OriginRowProps {
  name: string;
  /** The last recorded position, when it differs from the Origin. */
  movedOn: boolean;
  onEdit: () => void;
}

export function OriginRow(props: OriginRowProps): JSX.Element {
  return (
    <div className="vl-origin-row">
      <span className="vl-target-ordinal" aria-hidden="true">
        ▸
      </span>
      <div style={{ flex: 1 }}>
        <strong>{props.name}</strong>
        <div className="vl-anchor-sub">
          {props.movedOn ? "Origin — the van has since moved on" : "Origin"}
        </div>
      </div>
      <button type="button" className="vl-checkin-btn" onClick={props.onEdit}>
        Edit
      </button>
    </div>
  );
}
