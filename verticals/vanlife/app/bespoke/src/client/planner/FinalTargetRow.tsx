import type { JSX } from "react";
import type { TargetNode } from "./types.js";

/**
 * The last Target: where the trip ends.
 *
 * Rendered alongside the tree rather than inside it, which is what pins it to
 * the end of the list — it has no drag handlers, so there is no ordering rule
 * to enforce and no special case in the tree.
 *
 * It carries no radius control at all. The deviation budget is measured against
 * the direct drive to exactly this point, so it has to be an exact one; an
 * absent control states that, where a disabled one would only raise the
 * question. Arriving "somewhere around" a place is an area Target placed just
 * before this row, which the route already passes through.
 */

export interface FinalTargetRowProps {
  target: TargetNode;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
}

export function FinalTargetRow(props: FinalTargetRowProps): JSX.Element {
  return (
    <div
      className={`vl-anchor-row vl-target-final${props.selected ? " vl-anchor-selected" : ""}`}
      onClick={props.onSelect}
    >
      <div className="vl-anchor-head">
        <span className="vl-drag-grip" aria-hidden="true" style={{ visibility: "hidden" }}>
          ⠿
        </span>
        <span className="vl-target-ordinal" aria-hidden="true">
          {props.target.ordinal === null ? "" : `${String(props.target.ordinal)}.`}
        </span>
        <strong>{props.target.name}</strong>
        <span className="vl-chip">exact</span>
        <span className="vl-chip vl-chip-final">★ final</span>
      </div>
      <div className="vl-anchor-sub">
        The deviation budget is measured against the direct drive here. To arrive “somewhere
        around” a place, add an area Target just before this one.
      </div>
      <div className="vl-anchor-actions">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            props.onEdit();
          }}
        >
          Edit
        </button>
      </div>
    </div>
  );
}
