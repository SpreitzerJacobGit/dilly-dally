import { useState, type JSX } from "react";
import { FULL_LEVEL, isAccumulating, levelQuickPicks, pctLabel } from "../lib/levels.js";
import { byUrgencyThenDeadline, dueDateLabel, isDateTracked, type NeedStateView } from "./NeedsStrip.js";

export interface CheckInRequest {
  needId: number;
  kind: "service" | "set-level";
  quantity?: number;
  note?: string;
}

const SERVICE_VERBS: Record<string, string> = {
  food: "Groceries done",
  gas: "Filled up",
  water: "Filled water",
  electric: "Charged up",
  laundry: "Laundry done",
  trash: "Dumped trash",
  wastewater: "Dumped tanks",
  internet: "Internet OK",
};

/**
 * Level correction and partial service, in percentage points. A real fuel gauge
 * reads in quarters, so the quick-picks are the fast path and "set level" is the
 * default mode — the one-tap button on the bar already covers a full service.
 *
 * A quick-pick fills the numeric field rather than submitting: a mis-tap at a
 * pump should not silently rewrite the level, and the operator keeps the chance
 * to adjust it or attach a note.
 */
export function QuantityModal(props: {
  state: NeedStateView;
  defaultMode?: "service" | "set-level";
  onSubmit: (req: CheckInRequest) => void | Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const { state } = props;
  const accumulates = isAccumulating(state.need);
  const [mode, setMode] = useState<"service" | "set-level">(props.defaultMode ?? "set-level");
  const [quantity, setQuantity] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const value = Number(quantity);
  const invalid = quantity === "" || Number.isNaN(value) || value < 0 || value > FULL_LEVEL;
  const serviceVerb = accumulates ? "Emptied by" : "Topped up by";
  return (
    <div className="vl-modal-backdrop" onClick={props.onClose}>
      <div className="vl-modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{state.need.title}</h3>
        <p style={{ color: "#666", fontSize: ".85rem" }}>
          Estimated {pctLabel(state.level)} full (as of {state.asOf.slice(11, 16)})
        </p>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <button
            className="vl-checkin-btn"
            style={mode === "set-level" ? { fontWeight: 700 } : {}}
            onClick={() => setMode("set-level")}
          >
            Set level
          </button>
          <button
            className="vl-checkin-btn"
            style={mode === "service" ? { fontWeight: 700 } : {}}
            onClick={() => setMode("service")}
          >
            {serviceVerb}
          </button>
        </div>
        {mode === "set-level" ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {levelQuickPicks(state.need).map((pick) => (
              <button
                key={pick.label}
                className="vl-checkin-btn"
                style={!Number.isNaN(value) && quantity !== "" && value === pick.value ? { fontWeight: 700 } : {}}
                onClick={() => setQuantity(String(pick.value))}
              >
                {pick.label}
              </button>
            ))}
          </div>
        ) : null}
        <label style={{ display: "block", fontSize: ".85rem", marginBottom: 8 }}>
          {mode === "set-level" ? "Level right now (%)" : `${serviceVerb} (%)`}
          <input
            type="number"
            min={0}
            max={FULL_LEVEL}
            step="1"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            style={{ display: "block", width: "100%", padding: 6, marginTop: 4 }}
          />
          <span style={{ display: "block", color: "#666", fontSize: ".75rem", marginTop: 2 }}>
            {mode === "set-level"
              ? accumulates
                ? "100% is completely full of waste."
                : "100% is a completely full tank."
              : accumulates
                ? "Percentage points removed — one bag out of four is 25."
                : "Percentage points added — half a tank into a quarter tank is 50."}
          </span>
        </label>
        <label style={{ display: "block", fontSize: ".85rem", marginBottom: 8 }}>
          Note (optional)
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            style={{ display: "block", width: "100%", padding: 6, marginTop: 4 }}
          />
        </label>
        {quantity !== "" && invalid ? (
          <p style={{ color: "#b3261e", fontSize: ".85rem" }}>Enter a number between 0 and 100.</p>
        ) : null}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="vl-checkin-btn"
            style={{ fontWeight: 700 }}
            disabled={invalid}
            onClick={() => {
              void props.onSubmit({
                needId: state.need.id,
                kind: mode,
                quantity: value,
                ...(note.trim() === "" ? {} : { note: note.trim() }),
              });
              props.onClose();
            }}
          >
            Record
          </button>
          <button
            className="vl-checkin-btn"
            onClick={() => {
              void props.onSubmit({
                needId: state.need.id,
                kind: "service",
                ...(note.trim() === "" ? {} : { note: note.trim() }),
              });
              props.onClose();
            }}
          >
            {accumulates ? "Emptied — 0%" : "Filled — 100%"}
          </button>
          <button className="vl-checkin-btn" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One-tap check-ins for the most pressing needs; "…" opens the quantity
 * refinement. The full grid lives on the needs page with the same handlers.
 */
export function CheckInBar(props: {
  states: NeedStateView[];
  /** May be async — the handler stamps the check-in with a free device fix first. */
  onCheckIn: (req: CheckInRequest) => void | Promise<void>;
  compact?: boolean;
}): JSX.Element {
  const [modal, setModal] = useState<NeedStateView | null>(null);
  const shown = props.compact
    ? [...props.states].filter((s) => s.need.routingDriver).sort(byUrgencyThenDeadline).slice(0, 4)
    : props.states;
  return (
    <div className="vl-checkin-bar">
      {shown.map((s) =>
        // A date-tracked need has no quantity to refine — servicing it just rolls
        // its due date forward — so it gets the one-tap button and nothing else.
        isDateTracked(s) ? (
          <button
            key={s.need.id}
            className={`vl-checkin-btn${s.urgency === "urgent" ? " vl-urgent-btn" : ""}`}
            onClick={() => void props.onCheckIn({ needId: s.need.id, kind: "service" })}
            title={`Record: ${s.need.title.toLowerCase()} done${s.need.dueAt ? ` (was due ${dueDateLabel(s.need.dueAt)})` : ""}`}
          >
            {s.need.title} done
          </button>
        ) : (
          <span key={s.need.id} style={{ display: "inline-flex" }}>
            <button
              className={`vl-checkin-btn${s.urgency === "urgent" ? " vl-urgent-btn" : ""}`}
              onClick={() => void props.onCheckIn({ needId: s.need.id, kind: "service" })}
              title={`Record: full ${s.need.title.toLowerCase()} service`}
            >
              {SERVICE_VERBS[s.need.key] ?? `${s.need.title} done`}
            </button>
            <button
              className="vl-checkin-btn"
              style={{ marginLeft: 2, padding: "6px 8px" }}
              onClick={() => setModal(s)}
              title="Correct the level, or record a partial"
            >
              …
            </button>
          </span>
        ),
      )}
      {modal ? <QuantityModal state={modal} onSubmit={props.onCheckIn} onClose={() => setModal(null)} /> : null}
    </div>
  );
}
