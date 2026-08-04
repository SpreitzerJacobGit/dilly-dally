import { useState, type JSX } from "react";
import { DataTable } from "@elements/shell-crud-tables";
import { trpc } from "../trpc.js";
import type { PageUser } from "../index.js";
import {
  NeedGauge,
  daysLeftLabel,
  dueDateLabel,
  isDateTracked,
  type NeedStateView,
} from "../components/NeedsStrip.js";
import { CheckInBar, QuantityModal, type CheckInRequest } from "../components/CheckInBar.js";
import { FormModal, type FieldSpec } from "../components/FormModal.js";
import { ConfirmModal } from "../components/ConfirmModal.js";
import { newClientId } from "../lib/checkinQueue.js";
import {
  daysPerTank,
  isAccumulating,
  milesPerTank,
  pctLabel,
  percentPer100Miles,
  round1,
} from "../lib/levels.js";
import { rateFromRange } from "../../shared/levels.js";
import { readGrantedFix } from "../lib/geocode.js";
import { VL_STYLES } from "../styles.js";

/**
 * The statuses screen: what every tracked need is at right now, and — behind an
 * edit toggle — the manager for the set of needs itself.
 *
 * The two modes are deliberately separate. Reading a level and recording a
 * check-in is the thing done daily, often one-handed at a gas pump; creating,
 * renaming and retuning needs is rare, fiddly, and unpleasant to do by accident.
 * Keeping the destructive affordances behind the toggle keeps the daily screen
 * uncluttered without hiding the management anywhere obscure.
 */

type NeedRowView = NeedStateView & {
  need: NeedStateView["need"] & {
    warnRatio: number;
    urgentRatio: number;
    warnDays: number | null;
    urgentDays: number | null;
    serviceIntervalDays: number | null;
  };
  rate: { ratePerDay: number; ratePerMile: number; source: string };
  suggestion: {
    ratePerDay: number;
    ratePerMile: number;
    samples: number;
    currentPerDay: number;
    currentPerMile: number;
  } | null;
};

type Dialog =
  | { kind: "add-level" }
  | { kind: "add-date" }
  | { kind: "rename"; row: NeedRowView }
  | { kind: "set-level"; row: NeedRowView }
  | { kind: "thresholds"; row: NeedRowView }
  | { kind: "rate"; row: NeedRowView }
  | { kind: "due"; row: NeedRowView }
  | { kind: "lead-times"; row: NeedRowView }
  | { kind: "to-date"; row: NeedRowView }
  | { kind: "to-level"; row: NeedRowView }
  | { kind: "delete"; row: NeedRowView }
  | null;

/**
 * A drain rate, asked for as the range an operator actually knows: how long a
 * full tank lasts. A select picks the driver rather than two optional fields,
 * because FormModal validates strictly per-field — "exactly one of these" is
 * unexpressible there, and a need that drained 22%/mile AND 15%/day would be
 * saveable and wrong.
 *
 * Direction-neutral wording on purpose: `direction` is itself editable on the
 * create form, and FieldSpec.label is a static string, so it cannot follow.
 */
function rateFields(rate: { ratePerDay: number; ratePerMile: number }): FieldSpec[] {
  const days = daysPerTank(rate.ratePerDay);
  const miles = milesPerTank(rate.ratePerMile);
  return [
    {
      name: "driver",
      label: "What uses it up",
      type: "select",
      defaultValue: miles !== null ? "miles" : days !== null ? "days" : "none",
      options: [
        { value: "days", label: "Time — it changes whether you drive or not" },
        { value: "miles", label: "Driving — it changes with the miles" },
        { value: "none", label: "Nothing — it never changes on its own" },
      ],
    },
    {
      name: "daysPerTank",
      label: "A full tank lasts (days)",
      type: "number",
      min: 0.1,
      max: 3650,
      step: "0.1",
      required: true,
      defaultValue: days === null ? "" : String(round1(days)),
      hint: "How many days it takes to go from completely full to completely empty.",
      showIf: (v) => v.driver === "days",
    },
    {
      name: "milesPerTank",
      label: "A full tank lasts (miles)",
      type: "number",
      min: 1,
      max: 10000,
      step: "1",
      required: true,
      defaultValue: miles === null ? "" : String(Math.round(miles)),
      hint: "How far you can drive on a completely full tank.",
      showIf: (v) => v.driver === "miles",
    },
  ];
}

/**
 * The stored rates a submitted rate form implies. Unrounded on purpose, so
 * opening the dialog and saving it unchanged returns the same displayed range.
 */
function rateValues(v: Record<string, string>): { ratePerDay: number; ratePerMile: number } {
  return {
    ratePerDay: v.driver === "days" ? rateFromRange(Number(v.daysPerTank)) : 0,
    ratePerMile: v.driver === "miles" ? rateFromRange(Number(v.milesPerTank)) : 0,
  };
}

const POI_CATEGORIES = [
  "campground",
  "water-fill",
  "dump-station",
  "laundry",
  "grocery",
  "fuel",
  "ev-charge",
  "restroom",
  "other",
];

/** A date input wants YYYY-MM-DD; the server stores the end of that day. */
function toDateInput(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

function optionalNumber(raw: string | undefined): number | undefined {
  const trimmed = (raw ?? "").trim();
  return trimmed === "" ? undefined : Number(trimmed);
}

/** Blank clears the stored value rather than leaving the old one in place. */
function nullableNumber(raw: string | undefined): number | null {
  const trimmed = (raw ?? "").trim();
  return trimmed === "" ? null : Number(trimmed);
}

export function StatusesPage(_props: { user: PageUser }): JSX.Element {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [historyNeedId, setHistoryNeedId] = useState<number | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Archived statuses are only ever loaded by the manager, so the daily view
  // never pays for them and can never accidentally act on one. The view-mode
  // query deliberately passes no input, so it shares the planner's cache entry
  // (and its offline optimistic patch) rather than opening a second one.
  const needsQ = trpc.needs.list.useQuery(editing ? { includeArchived: true } : undefined);
  const history = trpc.needs.history.useQuery(
    { needId: historyNeedId ?? 0, limit: 50 },
    { enabled: historyNeedId !== null },
  );

  function refresh(): void {
    void utils.needs.list.invalidate();
  }
  function refreshAll(): void {
    refresh();
    void utils.needs.history.invalidate();
  }
  function showError(e: { message: string }): void {
    setToast(e.message);
  }

  const checkin = trpc.needs.checkin.useMutation({
    onSuccess: () => {
      refreshAll();
      setToast("Check-in recorded");
    },
    onError: showError,
  });
  const undo = trpc.needs.undoCheckin.useMutation({ onSuccess: refreshAll, onError: showError });
  const setRate = trpc.needs.setRate.useMutation({
    onSuccess: () => {
      refresh();
      setToast("Rate updated — projections recomputed");
    },
    onError: showError,
  });
  const configure = trpc.needs.configure.useMutation({ onSuccess: refresh, onError: showError });
  const create = trpc.needs.create.useMutation({
    onSuccess: () => {
      refresh();
      setToast("Status added");
    },
    onError: showError,
  });
  const remove = trpc.needs.remove.useMutation({
    onSuccess: () => {
      refreshAll();
      setToast("Status deleted");
    },
    onError: showError,
  });
  const acceptSuggestion = trpc.needs.acceptRateSuggestion.useMutation({
    onSuccess: () => {
      refresh();
      setToast("Suggested rate accepted");
    },
    onError: showError,
  });

  const all = (needsQ.data ?? []) as NeedRowView[];
  const live = all.filter((s) => s.need.active);
  const archived = all.filter((s) => !s.need.active);

  /** Stamp where we were, when that is free — see readGrantedFix. */
  async function handleCheckIn(req: CheckInRequest): Promise<void> {
    const clientId = newClientId();
    const occurredAt = new Date().toISOString();
    const fix = await readGrantedFix();
    checkin.mutate({
      ...req,
      clientId,
      occurredAt,
      ...(fix ? { location: { lat: fix.lat, lng: fix.lng } } : {}),
    });
  }

  function settingCell(s: NeedRowView): string {
    if (isDateTracked(s)) {
      if (!s.need.dueAt) return "not scheduled";
      const repeat = s.need.serviceIntervalDays ? ` · every ${String(s.need.serviceIntervalDays)}d` : "";
      return `due ${dueDateLabel(s.need.dueAt)}${repeat}`;
    }
    // "est." carries the never-a-measurement requirement into the table, which
    // otherwise leans entirely on the paragraph at the top of the page.
    return `est. ${pctLabel(s.level)} full (as of ${s.asOf.slice(11, 16)})`;
  }

  /**
   * Both halves of the rate: the stored percentage, and the range it was
   * entered as. The range is what makes the number checkable against the van.
   */
  function rateCell(s: NeedRowView): string {
    if (isDateTracked(s)) return "—";
    const verb = isAccumulating(s.need) ? "fills" : "drains";
    const miles = milesPerTank(s.rate.ratePerMile);
    if (miles !== null) {
      const span = isAccumulating(s.need) ? `full in ${String(Math.round(miles))} mi` : `${String(Math.round(miles))} mi per tank`;
      return `${verb} ${String(round1(percentPer100Miles(s.rate.ratePerMile)))}% per 100 mi · ${span}`;
    }
    const days = daysPerTank(s.rate.ratePerDay);
    if (days !== null) {
      const span = isAccumulating(s.need) ? `full in ${String(round1(days))} days` : `${String(round1(days))} days per tank`;
      return `${verb} ${String(round1(s.rate.ratePerDay))}% per day · ${span}`;
    }
    return isAccumulating(s.need) ? "never fills" : "never drains";
  }

  /**
   * A refined rate, restated as a range. The "you have" half comes from the
   * suggestion's own currentPer* — the values its >15% test compared against —
   * rather than re-reading the rate, and both go through the null-guarded
   * inversions because a never-rated need carries a current of 0.
   */
  function suggestionCell(
    s: NeedRowView,
    suggestion: NonNullable<NeedRowView["suggestion"]>,
  ): JSX.Element {
    const perMile = suggestion.ratePerMile > 0;
    const proposed = perMile ? milesPerTank(suggestion.ratePerMile) : daysPerTank(suggestion.ratePerDay);
    const current = perMile ? milesPerTank(suggestion.currentPerMile) : daysPerTank(suggestion.currentPerDay);
    const unitWord = perMile ? "mi" : "days";
    const fmt = (n: number): string => (perMile ? String(Math.round(n)) : String(round1(n)));
    const span = isAccumulating(s.need) ? "to fill" : "per tank";
    return (
      <span style={{ display: "inline-flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
        <small style={{ color: "#666" }}>
          Your last {String(suggestion.samples)} {isAccumulating(s.need) ? "dumps" : "fills"} suggest{" "}
          {proposed === null ? "no drain" : `${fmt(proposed)} ${unitWord} ${span}`}
          {current === null ? " (none set)" : ` — you have ${fmt(current)}`}.
        </small>
        <button
          className="vl-checkin-btn"
          onClick={() => acceptSuggestion.mutate({ needId: s.need.id })}
          title={`From the ${String(suggestion.samples)} most recent full-service intervals — nothing changes unless you accept.`}
        >
          Accept
        </button>
      </span>
    );
  }

  function trackedByCell(s: NeedRowView): JSX.Element {
    return <span className="vl-chip">{isDateTracked(s) ? "date" : "level"}</span>;
  }

  if (needsQ.isLoading) return <p>Loading…</p>;

  return (
    <>
      <style>{VL_STYLES}</style>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <h2 style={{ marginBottom: 4 }}>Statuses</h2>
        <button
          className="vl-checkin-btn"
          style={editing ? { fontWeight: 700 } : {}}
          onClick={() => {
            setEditing(!editing);
            setDialog(null);
          }}
        >
          {editing ? "Done" : "Edit"}
        </button>
      </div>
      <p style={{ color: "#666", fontSize: ".9rem", marginTop: 0 }}>
        {editing
          ? "Add, rename, retune and archive what this van tracks. Archiving hides a status everywhere but keeps its history; deleting is permanent."
          : "Levels are estimates derived from your last check-in, the configured rate, elapsed time, and recorded miles — never measured. Date statuses count down to the day they fall due. Correct either any time with a check-in."}
      </p>

      {!editing ? (
        <>
          <div className="vl-needs-strip" style={{ flexWrap: "wrap" }}>
            {live.map((s) => (
              <NeedGauge key={s.need.id} state={s} onClick={() => setHistoryNeedId(s.need.id)} />
            ))}
          </div>

          <h3>Record a check-in</h3>
          <CheckInBar states={live} onCheckIn={handleCheckIn} />

          <h3>Projections</h3>
          <DataTable
            columns={[
              { key: "need", header: "Status", render: (s) => s.need.title },
              { key: "tracking", header: "Tracked by", render: trackedByCell },
              { key: "setting", header: "Now", render: settingCell },
              { key: "rate", header: "Rate", render: rateCell },
              { key: "deadline", header: "Due", render: (s) => daysLeftLabel(s.deadlineAt) },
              { key: "urgency", header: "Status", render: (s) => s.urgency.toUpperCase() },
              {
                key: "suggestion",
                header: "Suggested rate",
                render: (s) => (s.suggestion ? suggestionCell(s, s.suggestion) : "—"),
              },
              {
                key: "history",
                header: "",
                render: (s) => (
                  <button className="vl-checkin-btn" onClick={() => setHistoryNeedId(s.need.id)}>
                    History
                  </button>
                ),
              },
            ]}
            rows={live}
            rowKey={(s) => s.need.id}
            emptyMessage="Nothing tracked yet — use Edit to add a status."
          />
        </>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0 4px" }}>
            <button
              className="vl-checkin-btn"
              style={{ fontWeight: 700 }}
              onClick={() => setDialog({ kind: "add-level" })}
            >
              + Level status
            </button>
            <button
              className="vl-checkin-btn"
              style={{ fontWeight: 700 }}
              onClick={() => setDialog({ kind: "add-date" })}
            >
              + Date status
            </button>
          </div>

          <DataTable
            columns={[
              { key: "need", header: "Status", render: (s) => s.need.title },
              { key: "tracking", header: "Tracked by", render: trackedByCell },
              { key: "setting", header: "Setting", render: settingCell },
              {
                key: "thresholds",
                header: "Warn / urgent",
                render: (s) =>
                  isDateTracked(s)
                    ? `${String(s.need.warnDays ?? 14)}d / ${String(s.need.urgentDays ?? 3)}d`
                    : `${String(Math.round(s.need.warnRatio * 100))}% / ${String(Math.round(s.need.urgentRatio * 100))}%`,
              },
              {
                key: "actions",
                header: "",
                render: (s) => (
                  <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                    <button className="vl-checkin-btn" onClick={() => setDialog({ kind: "rename", row: s })}>
                      Rename
                    </button>
                    {isDateTracked(s) ? (
                      <>
                        <button className="vl-checkin-btn" onClick={() => setDialog({ kind: "due", row: s })}>
                          Set due date
                        </button>
                        <button className="vl-checkin-btn" onClick={() => setDialog({ kind: "lead-times", row: s })}>
                          Lead times
                        </button>
                        <button className="vl-checkin-btn" onClick={() => setDialog({ kind: "to-level", row: s })}>
                          → Level
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="vl-checkin-btn" onClick={() => setDialog({ kind: "set-level", row: s })}>
                          Set level
                        </button>
                        <button className="vl-checkin-btn" onClick={() => setDialog({ kind: "thresholds", row: s })}>
                          Thresholds
                        </button>
                        <button className="vl-checkin-btn" onClick={() => setDialog({ kind: "rate", row: s })}>
                          Rate
                        </button>
                        <button className="vl-checkin-btn" onClick={() => setDialog({ kind: "to-date", row: s })}>
                          → Date
                        </button>
                      </>
                    )}
                    <button
                      className="vl-checkin-btn"
                      onClick={() => configure.mutate({ needId: s.need.id, active: false })}
                      title="Hide this status everywhere but keep its history"
                    >
                      Archive
                    </button>
                  </span>
                ),
              },
            ]}
            rows={live}
            rowKey={(s) => s.need.id}
            emptyMessage="Nothing tracked yet."
          />

          <h3>Archived</h3>
          <DataTable
            columns={[
              { key: "need", header: "Status", render: (s) => s.need.title },
              { key: "tracking", header: "Tracked by", render: trackedByCell },
              {
                key: "actions",
                header: "",
                render: (s) => (
                  <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                    <button
                      className="vl-checkin-btn"
                      onClick={() => configure.mutate({ needId: s.need.id, active: true })}
                    >
                      Restore
                    </button>
                    <button
                      className="vl-checkin-btn"
                      style={{ color: "#b3261e", borderColor: "#b3261e" }}
                      onClick={() => setDialog({ kind: "delete", row: s })}
                    >
                      Delete forever
                    </button>
                  </span>
                ),
              },
            ]}
            rows={archived}
            rowKey={(s) => s.need.id}
            emptyMessage="Nothing archived."
          />
        </>
      )}

      {historyNeedId !== null ? (
        <>
          <h3>
            History — {all.find((s) => s.need.id === historyNeedId)?.need.title}
            <button
              className="vl-checkin-btn"
              style={{ marginLeft: 8, fontSize: ".8rem" }}
              onClick={() => setHistoryNeedId(null)}
            >
              Close
            </button>
          </h3>
          <DataTable
            columns={[
              { key: "when", header: "When", render: (c) => c.occurredAt.slice(0, 16).replace("T", " ") },
              {
                key: "what",
                header: "What",
                render: (c) => {
                  const row = all.find((s) => s.need.id === historyNeedId);
                  const emptying = row ? isAccumulating(row.need) : false;
                  if (c.kind === "set-level") return `Corrected level to ${pctLabel(c.quantity ?? 0)}`;
                  if (c.quantity === null) return emptying ? "Emptied" : "Filled up";
                  return `${emptying ? "Emptied by" : "Topped up by"} ${pctLabel(c.quantity)}`;
                },
              },
              { key: "who", header: "Who", render: (c) => c.recordedByEmail },
              { key: "note", header: "Note", render: (c) => c.note ?? "—" },
              {
                key: "undo",
                header: "",
                render: (c) => (
                  <button className="vl-checkin-btn" onClick={() => undo.mutate({ id: c.id })}>
                    Undo
                  </button>
                ),
              },
            ]}
            rows={history.data ?? []}
            rowKey={(c) => c.id}
            emptyMessage="No check-ins yet."
          />
        </>
      ) : null}

      {dialog?.kind === "add-level" ? (
        <FormModal
          title="New level status"
          hint="Something with a tank or a shelf. Its level is a plain 0-100%, and it drains or fills over time."
          submitLabel="Add"
          fields={[
            { name: "title", label: "Name", placeholder: "Propane", required: true },
            {
              name: "direction",
              label: "Direction",
              type: "select",
              defaultValue: "depletes",
              options: [
                { value: "depletes", label: "Depletes toward empty (water, fuel)" },
                { value: "accumulates", label: "Accumulates toward full (trash, waste)" },
              ],
            },
            ...rateFields({ ratePerDay: 0, ratePerMile: 0 }),
            {
              name: "poiCategory",
              label: "Serviced by",
              type: "select",
              defaultValue: "",
              options: [
                { value: "", label: "Nothing — checklist only" },
                ...POI_CATEGORIES.map((c) => ({ value: c, label: c })),
              ],
              hint: "A place category lets this status generate route stops.",
            },
          ]}
          onSubmit={(v) =>
            create.mutate({
              title: v.title ?? "",
              trackingMode: "level",
              direction: v.direction === "accumulates" ? "accumulates" : "depletes",
              ...rateValues(v),
              poiCategory: (v.poiCategory ?? "") === "" ? null : (v.poiCategory ?? null),
            })
          }
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === "add-date" ? (
        <FormModal
          title="New date status"
          hint="Something that simply falls due — an oil change, a registration renewal, an inspection."
          submitLabel="Add"
          fields={[
            { name: "title", label: "Name", placeholder: "Oil change", required: true },
            { name: "dueAt", label: "Due date", type: "date", required: true },
            {
              name: "serviceIntervalDays",
              label: "Repeats every (days)",
              type: "number",
              min: 0,
              hint: "Leave blank for a one-off. Otherwise a check-in rolls the due date forward this far.",
            },
            { name: "warnDays", label: "Warn this many days ahead", type: "number", min: 0, defaultValue: "14" },
            { name: "urgentDays", label: "Urgent this many days ahead", type: "number", min: 0, defaultValue: "3" },
          ]}
          onSubmit={(v) =>
            create.mutate({
              title: v.title ?? "",
              trackingMode: "date",
              dueAt: v.dueAt ?? "",
              serviceIntervalDays: optionalNumber(v.serviceIntervalDays),
              warnDays: optionalNumber(v.warnDays),
              urgentDays: optionalNumber(v.urgentDays),
            })
          }
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === "rename" ? (
        <FormModal
          title={`Rename ${dialog.row.need.title}`}
          fields={[{ name: "title", label: "Name", defaultValue: dialog.row.need.title, required: true }]}
          onSubmit={(v) => configure.mutate({ needId: dialog.row.need.id, title: v.title })}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {/* The same modal the daily bar uses, rather than a second level-correction
          UI that has to be kept in agreement with it — and the manager gets the
          quick-picks for free. */}
      {dialog?.kind === "set-level" ? (
        <QuantityModal
          state={dialog.row}
          defaultMode="set-level"
          onSubmit={handleCheckIn}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === "thresholds" ? (
        <FormModal
          title={`${dialog.row.need.title} — warning thresholds`}
          hint="Thresholds are a percentage of the tank — the same 0-100 the level uses."
          fields={[
            {
              name: "warnRatio",
              label: isAccumulating(dialog.row.need) ? "Warn with less space left than (%)" : "Warn below (%)",
              type: "number",
              min: 0,
              max: 90,
              defaultValue: String(Math.round(dialog.row.need.warnRatio * 100)),
              required: true,
              hint: "How little headroom is left before this starts asking for attention.",
            },
            {
              name: "urgentRatio",
              label: isAccumulating(dialog.row.need) ? "Urgent with less space left than (%)" : "Urgent below (%)",
              type: "number",
              min: 0,
              max: 50,
              defaultValue: String(Math.round(dialog.row.need.urgentRatio * 100)),
              required: true,
              hint: "How little headroom is left before this jumps the queue.",
            },
          ]}
          onSubmit={(v) =>
            configure.mutate({
              needId: dialog.row.need.id,
              warnRatio: Number(v.warnRatio) / 100,
              urgentRatio: Number(v.urgentRatio) / 100,
            })
          }
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === "rate" ? (
        <FormModal
          title={`${dialog.row.need.title} — how fast it ${isAccumulating(dialog.row.need) ? "fills" : "drains"}`}
          hint="Enter it the way you actually know it: how long a full tank lasts. Projections everywhere recompute immediately."
          fields={rateFields(dialog.row.rate)}
          onSubmit={(v) => setRate.mutate({ needId: dialog.row.need.id, ...rateValues(v) })}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === "due" ? (
        <FormModal
          title={`${dialog.row.need.title} — due date`}
          fields={[
            {
              name: "dueAt",
              label: "Due date",
              type: "date",
              defaultValue: toDateInput(dialog.row.need.dueAt),
              required: true,
            },
          ]}
          onSubmit={(v) => configure.mutate({ needId: dialog.row.need.id, dueAt: v.dueAt })}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === "lead-times" ? (
        <FormModal
          title={`${dialog.row.need.title} — lead times`}
          hint="How far ahead this status starts asking for attention."
          fields={[
            {
              name: "warnDays",
              label: "Warn this many days ahead",
              type: "number",
              min: 0,
              defaultValue: String(dialog.row.need.warnDays ?? 14),
              required: true,
            },
            {
              name: "urgentDays",
              label: "Urgent this many days ahead",
              type: "number",
              min: 0,
              defaultValue: String(dialog.row.need.urgentDays ?? 3),
              required: true,
            },
            {
              name: "serviceIntervalDays",
              label: "Repeats every (days)",
              type: "number",
              min: 0,
              defaultValue:
                dialog.row.need.serviceIntervalDays === null ? "" : String(dialog.row.need.serviceIntervalDays),
              hint: "Blank for a one-off.",
            },
          ]}
          onSubmit={(v) =>
            configure.mutate({
              needId: dialog.row.need.id,
              warnDays: Number(v.warnDays),
              urgentDays: Number(v.urgentDays),
              serviceIntervalDays: nullableNumber(v.serviceIntervalDays),
            })
          }
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === "to-date" ? (
        <FormModal
          title={`Track ${dialog.row.need.title} by date`}
          hint="It stops draining and starts counting down to a day. Its check-in history is kept."
          submitLabel="Switch"
          fields={[
            { name: "dueAt", label: "Due date", type: "date", required: true },
            {
              name: "serviceIntervalDays",
              label: "Repeats every (days)",
              type: "number",
              min: 0,
              hint: "Blank for a one-off.",
            },
            {
              name: "warnDays",
              label: "Warn this many days ahead",
              type: "number",
              min: 0,
              defaultValue: "14",
              required: true,
            },
            {
              name: "urgentDays",
              label: "Urgent this many days ahead",
              type: "number",
              min: 0,
              defaultValue: "3",
              required: true,
            },
          ]}
          onSubmit={(v) =>
            configure.mutate({
              needId: dialog.row.need.id,
              trackingMode: "date",
              dueAt: v.dueAt,
              serviceIntervalDays: nullableNumber(v.serviceIntervalDays),
              warnDays: Number(v.warnDays),
              urgentDays: Number(v.urgentDays),
            })
          }
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === "to-level" ? (
        <FormModal
          title={`Track ${dialog.row.need.title} by level`}
          hint="It stops counting down to a day and starts tracking a level from 0 to 100%. Set how fast it drains with Rate — until then it holds at full."
          submitLabel="Switch"
          fields={[
            {
              name: "direction",
              label: "Direction",
              type: "select",
              defaultValue: "depletes",
              options: [
                { value: "depletes", label: "Depletes toward empty" },
                { value: "accumulates", label: "Accumulates toward full" },
              ],
            },
          ]}
          onSubmit={(v) =>
            configure.mutate({
              needId: dialog.row.need.id,
              trackingMode: "level",
              direction: v.direction === "accumulates" ? "accumulates" : "depletes",
              dueAt: null,
            })
          }
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === "delete" ? (
        <ConfirmModal
          title={`Delete ${dialog.row.need.title}?`}
          body={`This removes ${dialog.row.need.title} and every check-in and rate ever recorded against it. It cannot be restored from the archive afterwards.`}
          confirmLabel="Delete forever"
          destructive
          onConfirm={() => remove.mutate({ needId: dialog.row.need.id })}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {toast ? <div className="vl-toast">{toast}</div> : null}
    </>
  );
}
