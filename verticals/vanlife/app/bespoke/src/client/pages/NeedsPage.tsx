import { useState, type JSX } from "react";
import { DataTable } from "@elements/shell-crud-tables";
import { trpc } from "../trpc.js";
import type { PageUser } from "../index.js";
import { NeedGauge, daysLeftLabel, type NeedStateView } from "../components/NeedsStrip.js";
import { CheckInBar, type CheckInRequest } from "../components/CheckInBar.js";
import { FormModal } from "../components/FormModal.js";
import { newClientId } from "../lib/checkinQueue.js";
import { readGrantedFix } from "../lib/geocode.js";
import { VL_STYLES } from "../styles.js";

export function NeedsPage(_props: { user: PageUser }): JSX.Element {
  const utils = trpc.useUtils();
  const needsQ = trpc.needs.list.useQuery();
  const [historyNeedId, setHistoryNeedId] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const history = trpc.needs.history.useQuery(
    { needId: historyNeedId ?? 0, limit: 50 },
    { enabled: historyNeedId !== null },
  );
  const checkin = trpc.needs.checkin.useMutation({
    onSuccess: () => {
      void utils.needs.list.invalidate();
      void utils.needs.history.invalidate();
      setToast("Check-in recorded");
    },
    onError: (e) => setToast(e.message),
  });
  const undo = trpc.needs.undoCheckin.useMutation({
    onSuccess: () => {
      void utils.needs.list.invalidate();
      void utils.needs.history.invalidate();
    },
  });
  const setRate = trpc.needs.setRate.useMutation({
    onSuccess: () => {
      void utils.needs.list.invalidate();
      setToast("Rate updated — projections recomputed");
    },
  });
  const configure = trpc.needs.configure.useMutation({
    onSuccess: () => void utils.needs.list.invalidate(),
  });
  const acceptSuggestion = trpc.needs.acceptRateSuggestion.useMutation({
    onSuccess: () => {
      void utils.needs.list.invalidate();
      setToast("Suggested rate accepted");
    },
  });

  const states = (needsQ.data ?? []) as (NeedStateView & {
    rate: { ratePerDay: number; ratePerMile: number; source: string };
    suggestion: { ratePerDay: number; ratePerMile: number; samples: number } | null;
  })[];
  const [rateFormFor, setRateFormFor] = useState<(typeof states)[number] | null>(null);
  const [capacityFormFor, setCapacityFormFor] = useState<(typeof states)[number] | null>(null);

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

  if (needsQ.isLoading) return <p>Loading…</p>;

  return (
    <>
      <style>{VL_STYLES}</style>
      <h2>Needs</h2>
      <p style={{ color: "#666", fontSize: ".9rem" }}>
        Levels are estimates derived from your last check-in, the configured rate, elapsed time, and
        recorded miles — never measured. Correct them any time with a check-in.
      </p>
      <div className="vl-needs-strip" style={{ flexWrap: "wrap" }}>
        {states.map((s) => (
          <NeedGauge key={s.need.id} state={s} onClick={() => setHistoryNeedId(s.need.id)} />
        ))}
      </div>

      <h3>Record a check-in</h3>
      <CheckInBar states={states} onCheckIn={handleCheckIn} />

      <h3>Configuration & projections</h3>
      <DataTable
        columns={[
          { key: "need", header: "Need", render: (s) => s.need.title },
          {
            key: "level",
            header: "Estimated level",
            render: (s) => `${String(s.level)} / ${String(s.need.capacity)} ${s.need.unit} (as of ${s.asOf.slice(11, 16)})`,
          },
          {
            key: "rate",
            header: "Rate",
            render: (s) =>
              s.rate.ratePerMile > 0
                ? `${String(s.rate.ratePerMile)} ${s.need.unit}/mi`
                : `${String(s.rate.ratePerDay)} ${s.need.unit}/day`,
          },
          { key: "deadline", header: "Runs out", render: (s) => daysLeftLabel(s.deadlineAt) },
          { key: "urgency", header: "Status", render: (s) => s.urgency.toUpperCase() },
          {
            key: "suggestion",
            header: "Suggested rate",
            render: (s) =>
              s.suggestion ? (
                <button
                  className="vl-checkin-btn"
                  onClick={() => acceptSuggestion.mutate({ needId: s.need.id })}
                  title={`From ${String(s.suggestion.samples)} check-in samples — applies only if you accept`}
                >
                  Accept {s.suggestion.ratePerMile !== s.rate.ratePerMile
                    ? `${String(Math.round(s.suggestion.ratePerMile * 1000) / 1000)} ${s.need.unit}/mi`
                    : `${String(Math.round(s.suggestion.ratePerDay * 100) / 100)} ${s.need.unit}/day`}
                </button>
              ) : (
                "—"
              ),
          },
          {
            key: "edit",
            header: "",
            render: (s) => (
              <button className="vl-checkin-btn" onClick={() => setRateFormFor(s)}>
                Edit rate
              </button>
            ),
          },
          {
            key: "capacity",
            header: "",
            render: (s) => (
              <button className="vl-checkin-btn" onClick={() => setCapacityFormFor(s)}>
                Edit capacity
              </button>
            ),
          },
        ]}
        rows={states}
        rowKey={(s) => s.need.id}
        emptyMessage="No needs configured."
      />

      {historyNeedId !== null ? (
        <>
          <h3>History — {states.find((s) => s.need.id === historyNeedId)?.need.title}</h3>
          <DataTable
            columns={[
              { key: "when", header: "When", render: (c) => c.occurredAt.slice(0, 16).replace("T", " ") },
              {
                key: "what",
                header: "What",
                render: (c) =>
                  c.kind === "set-level"
                    ? `Corrected level to ${String(c.quantity)}`
                    : c.quantity === null
                      ? "Full service"
                      : `Partial service: ${String(c.quantity)}`,
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
      {rateFormFor ? (
        <FormModal
          title={`${rateFormFor.need.title} — consumption rate`}
          hint="Projections everywhere recompute immediately."
          fields={[
            { name: "ratePerDay", label: `Per day (${rateFormFor.need.unit}/day)`, type: "number", min: 0, defaultValue: String(rateFormFor.rate.ratePerDay), required: true },
            { name: "ratePerMile", label: `Per mile (${rateFormFor.need.unit}/mi, 0 for none)`, type: "number", min: 0, defaultValue: String(rateFormFor.rate.ratePerMile), required: true },
          ]}
          onSubmit={(v) =>
            setRate.mutate({ needId: rateFormFor.need.id, ratePerDay: Number(v.ratePerDay), ratePerMile: Number(v.ratePerMile) })
          }
          onClose={() => setRateFormFor(null)}
        />
      ) : null}
      {capacityFormFor ? (
        <FormModal
          title={`${capacityFormFor.need.title} — capacity`}
          fields={[
            { name: "capacity", label: `Capacity (${capacityFormFor.need.unit})`, type: "number", min: 0.1, defaultValue: String(capacityFormFor.need.capacity), required: true },
          ]}
          onSubmit={(v) => configure.mutate({ needId: capacityFormFor.need.id, capacity: Number(v.capacity) })}
          onClose={() => setCapacityFormFor(null)}
        />
      ) : null}
      {toast ? <div className="vl-toast">{toast}</div> : null}
    </>
  );
}
