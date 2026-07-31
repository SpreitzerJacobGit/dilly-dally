import type { JSX } from "react";
import { ROLE_LABELS, roleColor } from "../map/palette.js";
import { buildHandoffUrls, nextStopUrl } from "../lib/gmaps.js";
import type { CandidateRouteView } from "../map/types.js";

export interface CandidateWarningView {
  severity: "urgent" | "info";
  message: string;
}

export interface CandidateDetail extends CandidateRouteView {
  summary: string | null;
  warnings: CandidateWarningView[];
  durationMinutes: number;
  distanceMiles: number;
  remainingBudgetMinutes: number | null;
}

function GoogleMapsButtons(props: { candidate: CandidateDetail }): JSX.Element | null {
  const pending = props.candidate.stops.filter((s) => !s.visited);
  if (pending.length === 0) return null;
  const urls = buildHandoffUrls(pending.map((s) => ({ lat: s.lat, lng: s.lng })));
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
      <button
        className="vl-checkin-btn"
        onClick={(e) => {
          e.stopPropagation();
          window.open(nextStopUrl({ lat: pending[0]!.lat, lng: pending[0]!.lng }), "_blank");
        }}
      >
        Navigate next stop ↗
      </button>
      {urls.map((u, i) => (
        <button
          key={u}
          className="vl-checkin-btn"
          onClick={(e) => {
            e.stopPropagation();
            window.open(u, "_blank");
          }}
        >
          Full leg{urls.length > 1 ? ` (part ${String(i + 1)}/${String(urls.length)})` : ""} ↗
        </button>
      ))}
    </div>
  );
}

export function CandidateCard(props: {
  candidate: CandidateDetail;
  highlighted: boolean;
  onHighlight: () => void;
  onSelect: () => void;
  onStopDone: (orderIndex: number) => void;
}): JSX.Element {
  const c = props.candidate;
  return (
    <div
      className={`vl-candidate${props.highlighted ? " vl-highlighted" : ""}`}
      style={{ borderLeftColor: roleColor(c.tier) }}
      onClick={props.onHighlight}
    >
      <h4>
        <span className="vl-tierdot" style={{ background: roleColor(c.tier) }} />
        {ROLE_LABELS[c.tier] ?? c.tier}
        {c.selected ? " · TODAY'S PLAN" : ""}
      </h4>
      <div style={{ fontWeight: 600 }}>{c.title}</div>
      {c.summary ? <div className="vl-summary">{c.summary}</div> : null}
      {c.warnings.map((w, i) => (
        <div key={i} className={w.severity === "urgent" ? "vl-warning" : "vl-summary"}>
          {w.severity === "urgent" ? "⚠ " : ""}
          {w.message}
        </div>
      ))}
      {props.highlighted ? (
        <ol className="vl-stops">
          {c.stops.map((s) => (
            <li key={s.orderIndex} className={s.visited ? "vl-visited" : ""}>
              {s.name}
              <span style={{ color: "#888" }}> · {s.purpose} · +{String(Math.round(s.etaMinutesFromStart / 60 * 10) / 10)}h</span>
              {c.selected && !s.visited ? (
                <button
                  className="vl-checkin-btn"
                  style={{ marginLeft: 8, padding: "1px 8px" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onStopDone(s.orderIndex);
                  }}
                >
                  done
                </button>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {!c.selected ? (
        <button
          className="vl-checkin-btn"
          style={{ marginTop: 6, fontWeight: 600 }}
          onClick={(e) => {
            e.stopPropagation();
            props.onSelect();
          }}
        >
          Pick this route
        </button>
      ) : null}
      {props.highlighted || c.selected ? <GoogleMapsButtons candidate={c} /> : null}
    </div>
  );
}
