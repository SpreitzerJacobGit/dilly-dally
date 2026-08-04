import { useEffect, useState, type JSX } from "react";
import { CandidateCard, type CandidateDetail } from "../components/CandidateList.js";

/** Today's candidate legs, and the controls for picking and walking one. */

export interface DriveHours {
  /** What today's plan is actually paced at. */
  effective: number;
  /** Set only when today is overriding the trip's pace. */
  override: number | null;
  tripHours: number;
}

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
  /** Null until today's plan has loaded. */
  driveHours: DriveHours | null;
  /** The hours changed since the last replan, so the cards below are stale. */
  paceDirty: boolean;
  onDriveHours: (hours: number | null) => void;
  onReplan: () => void;
  onHighlight: (id: number) => void;
  onSelect: (id: number) => void;
  onStopDone: (candidateId: number, orderIndex: number) => void;
}

/**
 * How long we mean to be driving today.
 *
 * The trip has a pace; this overrides it for today alone, because "today I feel
 * like driving eight hours" should not re-pace the rest of the trip. Committed
 * on blur rather than per keystroke — typing "10" passes through "1" on the way,
 * and saving that would rebuild the day around an hour nobody asked for.
 */
function DriveHoursRow(props: {
  driveHours: DriveHours;
  onDriveHours: (hours: number | null) => void;
}): JSX.Element {
  const { effective, override, tripHours } = props.driveHours;
  const [text, setText] = useState(String(effective));
  useEffect(() => setText(String(effective)), [effective]);

  const commit = (): void => {
    const n = Number(text);
    // Out of range or unparseable is a typo, not an instruction — put the real
    // value back rather than saving nonsense or silently clamping it.
    if (!Number.isFinite(n) || n < 1 || n > 12) {
      setText(String(effective));
      return;
    }
    if (n === effective) return;
    props.onDriveHours(n);
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "0 0 10px" }}>
      <label style={{ fontSize: ".85rem" }}>
        Hours to drive today{" "}
        <input
          type="number"
          min={1}
          max={12}
          step={0.5}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          style={{ width: 64 }}
        />{" "}
        h
      </label>
      <span style={{ color: "#555", fontSize: ".8rem" }}>trip pace {tripHours}h</span>
      {override !== null ? (
        <button type="button" className="vl-checkin-btn" onClick={() => props.onDriveHours(null)}>
          Use trip pace
        </button>
      ) : null}
    </div>
  );
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
      {props.paceDirty ? (
        <div className="vl-offline">
          Hours to drive today changed — replan to build the day around it.
        </div>
      ) : null}
      {props.nonActiveNote ? <div className="vl-offline">{props.nonActiveNote}</div> : null}

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <h3 style={{ margin: "8px 0" }}>Today’s candidates</h3>
        <button className="vl-checkin-btn" disabled={props.replanPending} onClick={props.onReplan}>
          {props.replanPending ? "Replanning…" : "Replan"}
        </button>
      </div>

      {props.driveHours ? (
        <DriveHoursRow driveHours={props.driveHours} onDriveHours={props.onDriveHours} />
      ) : null}

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
