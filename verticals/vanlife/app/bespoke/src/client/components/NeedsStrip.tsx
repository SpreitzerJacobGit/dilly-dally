import type { JSX } from "react";
import { useNavigate } from "react-router-dom";

export interface NeedStateView {
  need: {
    id: number;
    key: string;
    title: string;
    unit: string;
    capacity: number;
    routingDriver: boolean;
  };
  level: number;
  runway: number;
  runwayRatio: number;
  urgency: string;
  deadlineAt: string | null;
  asOf: string;
}

export function daysLeftLabel(deadlineAt: string | null): string {
  if (!deadlineAt) return "—";
  const days = (Date.parse(deadlineAt) - Date.now()) / 86_400_000;
  if (days <= 0) return "now";
  return days < 1 ? `${String(Math.round(days * 24))}h` : `${days.toFixed(1)}d`;
}

export function NeedGauge(props: { state: NeedStateView; onClick?: () => void }): JSX.Element {
  const { state } = props;
  const cls = state.urgency === "urgent" ? "vl-urgent" : state.urgency === "warn" ? "vl-warn" : "vl-ok";
  return (
    <div className="vl-gauge" onClick={props.onClick} role="button" title={`${state.need.title}: estimated ${String(state.level)} ${state.need.unit} as of ${state.asOf.slice(11, 16)}`}>
      <div style={{ fontSize: ".8rem", fontWeight: 600 }}>{state.need.title}</div>
      <div className="vl-gauge-bar">
        <div className={`vl-gauge-fill ${cls}`} style={{ width: `${String(Math.round(state.runwayRatio * 100))}%` }} />
      </div>
      <small>
        {state.need.routingDriver
          ? `${String(state.runway)} ${state.need.unit} · ${daysLeftLabel(state.deadlineAt)}`
          : "checklist"}
        {state.urgency !== "ok" ? ` · ${state.urgency.toUpperCase()}` : ""}
      </small>
    </div>
  );
}

/** Most-pressing first: urgency class, then soonest deadline within a class. */
export function byUrgencyThenDeadline(a: NeedStateView, b: NeedStateView): number {
  const rank = (s: NeedStateView): number => (s.urgency === "urgent" ? 0 : s.urgency === "warn" ? 1 : 2);
  const deadline = (s: NeedStateView): number =>
    s.deadlineAt ? Date.parse(s.deadlineAt) : Number.MAX_SAFE_INTEGER;
  return rank(a) - rank(b) || deadline(a) - deadline(b) || a.need.id - b.need.id;
}

export function NeedsStrip(props: { states: NeedStateView[] }): JSX.Element {
  const navigate = useNavigate();
  const sorted = [...props.states].sort(byUrgencyThenDeadline);
  return (
    <div className="vl-needs-strip">
      {sorted.map((s) => (
        <NeedGauge key={s.need.id} state={s} onClick={() => void navigate("/needs")} />
      ))}
    </div>
  );
}
