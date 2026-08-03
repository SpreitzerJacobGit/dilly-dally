import { useState, type JSX } from "react";
import {
  ALL_CATEGORIES,
  categoryColor,
  categoryLabel,
  PROJECTED_COLOR,
  ROLE_LABELS,
  roleColor,
} from "../map/palette.js";

/**
 * The map's key, and the only place to switch categories of place on and off.
 *
 * Legend and filter are one control on purpose: a swatch that explains what a
 * colour means is already the thing you want to click when there is too much of
 * it on screen. Splitting them would mean saying "campground is green" twice.
 *
 * The full category list is always shown, not just the ones currently in view.
 * A list that changed as you panned would move the checkbox out from under the
 * cursor, and a category with nothing in view is exactly the one whose absence
 * you want to be able to tell apart from being switched off.
 */

export interface MapLegendProps {
  /** Categories switched off. Empty means everything shows. */
  hidden: Set<string>;
  /**
   * Whether the dots on screen are the catalog. The search sheet and a
   * Target's suggestions are small deliberate answers to a question that was
   * just asked, so the filter does not apply to them and the checkboxes are
   * withheld rather than left present and lying.
   */
  filterable: boolean;
  /** Says which set of places the dots are, so their vanishing is never a mystery. */
  poiSourceLabel: string;
  onToggle: (category: string) => void;
  onSetAll: (visible: boolean) => void;
}

export function MapLegend(props: MapLegendProps): JSX.Element {
  // Expanded where there is room. The map pane is 55dvh on a phone, and a
  // fifteen-row panel over half of that hides more than it explains.
  const [open, setOpen] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 900px)").matches,
  );

  // Only meaningful while the filter is actually in force — the count would
  // otherwise sit there claiming to hide places that are all on screen.
  const hiddenCount = props.filterable ? props.hidden.size : 0;

  return (
    <div className="vl-legend">
      <button
        type="button"
        className="vl-legend-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>Legend</span>
        {hiddenCount > 0 ? <span className="vl-chip">{hiddenCount} hidden</span> : null}
        <span className="vl-legend-caret">{open ? "▾" : "▸"}</span>
      </button>

      {open ? (
        <div className="vl-legend-body">
          {props.filterable ? (
            <>
              <div className="vl-legend-section">
                <span>Places</span>
                <span className="vl-legend-all">
                  <button type="button" onClick={() => props.onSetAll(true)}>
                    All
                  </button>
                  <button type="button" onClick={() => props.onSetAll(false)}>
                    None
                  </button>
                </span>
              </div>
              <div className="vl-legend-list">
                {ALL_CATEGORIES.map((category) => (
                  <label key={category} className="vl-legend-row">
                    <input
                      type="checkbox"
                      checked={!props.hidden.has(category)}
                      onChange={() => props.onToggle(category)}
                    />
                    <span className="vl-tierdot" style={{ background: categoryColor(category) }} />
                    {categoryLabel(category)}
                  </label>
                ))}
              </div>
            </>
          ) : null}

          <div className="vl-legend-section">
            <span>Routes</span>
          </div>
          {Object.entries(ROLE_LABELS).map(([tier, label]) => (
            <div key={tier} className="vl-legend-row">
              <span className="vl-line" style={{ background: roleColor(tier) }} /> {label}
            </div>
          ))}
          <div className="vl-legend-row">
            <span className="vl-line" style={{ background: PROJECTED_COLOR }} /> Projected future
          </div>
        </div>
      ) : null}

      <div className="vl-legend-source">{props.poiSourceLabel}</div>
    </div>
  );
}
