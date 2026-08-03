import { useState, type JSX } from "react";
import { byUrgencyThenDeadline, type NeedStateView } from "./NeedsStrip.js";

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

function QuantityModal(props: {
  state: NeedStateView;
  onSubmit: (req: CheckInRequest) => void | Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const { state } = props;
  const [mode, setMode] = useState<"service" | "set-level">("service");
  const [quantity, setQuantity] = useState<string>("");
  return (
    <div className="vl-modal-backdrop" onClick={props.onClose}>
      <div className="vl-modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{state.need.title}</h3>
        <p style={{ color: "#666", fontSize: ".85rem" }}>
          Estimated {String(state.level)} {state.need.unit} of {String(state.need.capacity)} (as of {state.asOf.slice(11, 16)})
        </p>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <button
            className="vl-checkin-btn"
            style={mode === "service" ? { fontWeight: 700 } : {}}
            onClick={() => setMode("service")}
          >
            Partial service
          </button>
          <button
            className="vl-checkin-btn"
            style={mode === "set-level" ? { fontWeight: 700 } : {}}
            onClick={() => setMode("set-level")}
          >
            Correct level
          </button>
        </div>
        <label style={{ display: "block", fontSize: ".85rem", marginBottom: 8 }}>
          {mode === "service" ? `Amount serviced (${state.need.unit})` : `Actual level right now (${state.need.unit})`}
          <input
            type="number"
            min={0}
            max={state.need.capacity}
            step="any"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            style={{ display: "block", width: "100%", padding: 6, marginTop: 4 }}
          />
        </label>
        {quantity !== "" && (Number.isNaN(Number(quantity)) || Number(quantity) < 0 || Number(quantity) > state.need.capacity) ? (
          <p style={{ color: "#b3261e", fontSize: ".85rem" }}>
            Enter a number between 0 and {String(state.need.capacity)} {state.need.unit}.
          </p>
        ) : null}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="vl-checkin-btn"
            style={{ fontWeight: 700 }}
            disabled={
              quantity === "" ||
              Number.isNaN(Number(quantity)) ||
              Number(quantity) < 0 ||
              Number(quantity) > state.need.capacity
            }
            onClick={() => {
              void props.onSubmit({ needId: state.need.id, kind: mode, quantity: Number(quantity) });
              props.onClose();
            }}
          >
            Record
          </button>
          <button
            className="vl-checkin-btn"
            onClick={() => {
              void props.onSubmit({ needId: state.need.id, kind: "service" });
              props.onClose();
            }}
          >
            Full {state.need.key === "trash" || state.need.key === "wastewater" || state.need.key === "laundry" ? "empty" : "fill"}
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
      {shown.map((s) => (
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
            title="Partial amount / correction"
          >
            …
          </button>
        </span>
      ))}
      {modal ? <QuantityModal state={modal} onSubmit={props.onCheckIn} onClose={() => setModal(null)} /> : null}
    </div>
  );
}
