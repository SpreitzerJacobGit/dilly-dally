import { useState, type JSX } from "react";
import {
  ALL_CATEGORIES,
  ALL_LAND_LAYERS,
  categoryColor,
  categoryLabel,
  landColor,
  landLabel,
  PROJECTED_COLOR,
  ROLE_LABELS,
  roleColor,
  signalColor,
  signalLabel,
  SIGNAL_CARRIERS,
  SIGNAL_SOURCE_LABEL,
  SIGNAL_TIERS,
} from "../map/palette.js";
import { useTileArchivePresent } from "../lib/tileStatus.js";

/** The overlay archive, prepared out of band; absent on a van that never ran the prep. */
const LEGAL_ARCHIVE = "legal-camping.pmtiles";

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
  /** Whether the cell signal overlay is drawn. */
  signalOn: boolean;
  /** Which carrier it colors by — one of the SIGNAL_CARRIERS keys. */
  signalCarrier: string;
  /**
   * Why the overlay cannot be shown, or null when it can. The archive is
   * provisioned by a scheduled refresh and is legitimately absent on a fresh
   * install, so the reason is stated in place of the controls rather than
   * leaving a switch that would silently do nothing.
   */
  signalUnavailable: string | null;
  /** When the installed coverage data was current, if it is installed. */
  signalAsOf: string | null;
  onToggleSignal: (on: boolean) => void;
  onSignalCarrier: (carrier: string) => void;
  /** Legal-camping land layers switched off, keyed like LAND_COLORS. */
  hiddenLand: Set<string>;
  onToggleLand: (layer: string) => void;
}

export function MapLegend(props: MapLegendProps): JSX.Element {
  // Expanded where there is room. The map pane is 55dvh on a phone, and a
  // fifteen-row panel over half of that hides more than it explains.
  const [open, setOpen] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 900px)").matches,
  );

  // Withheld rather than shown dead when the overlay was never installed: a
  // switch for a layer that cannot draw is the same lie as a category checkbox
  // over places the filter does not apply to.
  const legalAvailable = useTileArchivePresent(LEGAL_ARCHIVE) === true;

  // Only meaningful while the filter is actually in force — the count would
  // otherwise sit there claiming to hide places that are all on screen.
  const hiddenCount =
    (props.filterable ? props.hidden.size : 0) + (legalAvailable ? props.hiddenLand.size : 0);

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

          {legalAvailable ? (
            <>
              <div className="vl-legend-section">
                <span>Legal camping</span>
              </div>
              {ALL_LAND_LAYERS.map((layer) => (
                <label key={layer} className="vl-legend-row">
                  <input
                    type="checkbox"
                    checked={!props.hiddenLand.has(layer)}
                    onChange={() => props.onToggleLand(layer)}
                  />
                  <span className="vl-landswatch" style={{ background: landColor(layer) }} />
                  {landLabel(layer)}
                </label>
              ))}
              <div className="vl-legend-advisory">
                A dashed edge means the width is assumed, not published. Advisory only — unshaded
                is "unverified", never "illegal". Check the current MVUM and local closures.
              </div>
            </>
          ) : null}

          <div className="vl-legend-section">
            <span>Cell signal</span>
          </div>
          {props.signalUnavailable !== null ? (
            <div className="vl-legend-note">{props.signalUnavailable}</div>
          ) : (
            <>
              <label className="vl-legend-row">
                <input
                  type="checkbox"
                  checked={props.signalOn}
                  onChange={(e) => props.onToggleSignal(e.target.checked)}
                />
                Show coverage
              </label>
              <div className="vl-legend-carrier">
                <select
                  aria-label="Carrier"
                  value={props.signalCarrier}
                  disabled={!props.signalOn}
                  onChange={(e) => props.onSignalCarrier(e.target.value)}
                >
                  {SIGNAL_CARRIERS.map((carrier) => (
                    <option key={carrier.key} value={carrier.key}>
                      {carrier.label}
                    </option>
                  ))}
                </select>
              </div>
              {/* The ramp only means anything while it is on the map, and the
                  switch above it does not move when these appear. */}
              {props.signalOn
                ? SIGNAL_TIERS.map((tier) => (
                    <div key={tier} className="vl-legend-row">
                      <span className="vl-legend-swatch" style={{ background: signalColor(tier) }} />
                      {signalLabel(tier)}
                    </div>
                  ))
                : null}
              <div className="vl-legend-source">
                {SIGNAL_SOURCE_LABEL}
                {props.signalAsOf !== null ? ` · as of ${props.signalAsOf}` : ""}
              </div>
            </>
          )}

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
