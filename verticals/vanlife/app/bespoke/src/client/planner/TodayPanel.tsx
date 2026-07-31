import type { JSX } from "react";
import { CandidateCard, type CandidateDetail } from "../components/CandidateList.js";

/** Today's candidate legs, and the controls for picking and walking one. */

export interface TodayPanelProps {
  candidates: CandidateDetail[];
  highlightedId: number | null;
  loading: boolean;
  message: string | null;
  stale: boolean;
  offline: boolean;
  replanPending: boolean;
  /** Set when the screen is showing a trip the van is not on. */
  nonActiveNote: string | null;
  /** Set when an endpoint moved but the chosen plan still ends at the old one. */
  selectionStale: boolean;
  onReplan: () => void;
  onHighlight: (id: number) => void;
  onSelect: (id: number) => void;
  onStopDone: (candidateId: number, orderIndex: number) => void;
}

export function TodayPanel(props: TodayPanelProps): JSX.Element {
  return (
    <>
      {props.offline ? <div className="vl-offline">Offline — showing last known state.</div> : null}
      {props.stale ? (
        <div className="vl-offline">
          Route computation unavailable — showing the last generated plan (stale).
        </div>
      ) : null}
      {props.selectionStale ? (
        <div className="vl-offline">
          Today’s chosen plan still ends at the old final Target — replan when you’re ready.
        </div>
      ) : null}
      {props.nonActiveNote ? <div className="vl-offline">{props.nonActiveNote}</div> : null}

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <h3 style={{ margin: "8px 0" }}>Today’s candidates</h3>
        <button className="vl-checkin-btn" disabled={props.replanPending} onClick={props.onReplan}>
          {props.replanPending ? "Replanning…" : "Replan"}
        </button>
      </div>

      {props.loading ? <p>Planning routes…</p> : null}
      {props.candidates.length === 0 && !props.loading ? (
        <p>No candidates yet{props.message ? ` — ${props.message}` : ""}.</p>
      ) : null}
      {props.candidates.map((c) => (
        <CandidateCard
          key={c.id}
          candidate={c}
          highlighted={c.id === props.highlightedId}
          onHighlight={() => props.onHighlight(c.id)}
          onSelect={() => props.onSelect(c.id)}
          onStopDone={(orderIndex) => props.onStopDone(c.id, orderIndex)}
        />
      ))}
    </>
  );
}
