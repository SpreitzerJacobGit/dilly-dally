import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { isAccumulating, pctLabel } from "../lib/levels.js";

export interface NeedStateView {
  need: {
    id: number;
    key: string;
    title: string;
    /** "depletes" (water, fuel) or "accumulates" (trash, waste water). */
    direction: string;
    routingDriver: boolean;
    /** Which place category services this need; null for checklist-only concerns. */
    poiCategory: string | null;
    /** "level" = a 0-100% consumable; "date" = simply due on a day. */
    trackingMode: string;
    dueAt: string | null;
    active: boolean;
  };
  level: number;
  runway: number;
  runwayRatio: number;
  urgency: string;
  deadlineAt: string | null;
  asOf: string;
}

export function isDateTracked(s: NeedStateView): boolean {
  return s.need.trackingMode === "date";
}

export function daysLeftLabel(deadlineAt: string | null): string {
  if (!deadlineAt) return "—";
  const days = (Date.parse(deadlineAt) - Date.now()) / 86_400_000;
  if (days <= 0) return "now";
  return days < 1 ? `${String(Math.round(days * 24))}h` : `${days.toFixed(1)}d`;
}

/** "Sep 15" / "Sep 15 2027" — the day itself, which is what a due date means. */
export function dueDateLabel(dueAt: string | null): string {
  if (!dueAt) return "not scheduled";
  const d = new Date(dueAt);
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
    timeZone: "UTC",
  });
}

/** The one-line summary under a gauge, which differs by how the need is tracked. */
export function gaugeSummary(s: NeedStateView): string {
  if (isDateTracked(s)) {
    return s.need.dueAt ? `due ${dueDateLabel(s.need.dueAt)} · ${daysLeftLabel(s.deadlineAt)}` : "not scheduled";
  }
  // `level` rather than `runway`: level is how full it physically is in BOTH
  // directions, so trash three-quarters full reads 75% rather than 25.
  return s.need.routingDriver ? `${pctLabel(s.level)} · ${daysLeftLabel(s.deadlineAt)}` : "checklist";
}

export function NeedGauge(props: { state: NeedStateView; onClick?: () => void }): JSX.Element {
  const { state } = props;
  const cls = state.urgency === "urgent" ? "vl-urgent" : state.urgency === "warn" ? "vl-warn" : "vl-ok";
  const title = isDateTracked(state)
    ? `${state.need.title}: ${state.need.dueAt ? `due ${dueDateLabel(state.need.dueAt)}` : "no due date set"}`
    : `${state.need.title}: estimated ${pctLabel(state.level)} full as of ${state.asOf.slice(11, 16)}`;
  // An accumulating need fills as it gets worse, so its bar tracks the level and
  // agrees with the caption; a can 75% full of trash showing a quarter-full bar
  // was only ever legible to someone who knew "runway" meant headroom. Colour
  // still comes from urgency, so no threshold or routing behaviour moves.
  const fillRatio =
    !isDateTracked(state) && isAccumulating(state.need) ? state.level / 100 : state.runwayRatio;
  return (
    <div className="vl-gauge" onClick={props.onClick} role="button" title={title}>
      <div style={{ fontSize: ".8rem", fontWeight: 600 }}>{state.need.title}</div>
      <div className="vl-gauge-bar">
        <div className={`vl-gauge-fill ${cls}`} style={{ width: `${String(Math.round(fillRatio * 100))}%` }} />
      </div>
      <small>
        {gaugeSummary(state)}
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

/** A need that drives routing and has a place category can be searched for. */
export function canSearchStops(s: NeedStateView): boolean {
  return s.need.routingDriver && s.need.poiCategory !== null;
}

/** Where a gauge click lands when it is not a stop search. */
export const STATUSES_PATH = "/statuses";

export function NeedsStrip(props: {
  states: NeedStateView[];
  /** Given, a routing need opens the stop search instead of the needs screen. */
  onNeedSearch?: (state: NeedStateView) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const sorted = [...props.states].sort(byUrgencyThenDeadline);
  return (
    <div className="vl-needs-strip">
      {sorted.map((s) => (
        <NeedGauge
          key={s.need.id}
          state={s}
          onClick={() =>
            props.onNeedSearch && canSearchStops(s)
              ? props.onNeedSearch(s)
              : void navigate(STATUSES_PATH)
          }
        />
      ))}
    </div>
  );
}
