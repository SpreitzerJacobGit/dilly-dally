import { useState, type JSX } from "react";
import { StatCard, DashboardGrid } from "@elements/output-dashboard-cards";
import { DataTable } from "@elements/shell-crud-tables";
import { trpc } from "../trpc.js";
import type { PageUser } from "../index.js";
import { FormModal } from "../components/FormModal.js";
import { VL_STYLES } from "../styles.js";

function minutesToH(m: number | null | undefined): string {
  if (m === null || m === undefined) return "—";
  return `${(m / 60).toFixed(1)} h`;
}

export function TripPage(_props: { user: PageUser }): JSX.Element {
  const utils = trpc.useUtils();
  const active = trpc.trips.active.useQuery();
  const allTrips = trpc.trips.list.useQuery();
  const tripId = active.data?.id;
  const trip = trpc.trips.get.useQuery({ id: tripId ?? 0 }, { enabled: tripId !== undefined });
  const digests = trpc.digest.history.useQuery({ tripId: tripId ?? 0, limit: 7 }, { enabled: tripId !== undefined });
  const fanout = trpc.plan.fanout.useQuery({ tripId: tripId ?? 0 }, { enabled: tripId !== undefined });
  const [toast, setToast] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const preview = trpc.digest.preview.useQuery(
    { tripId: tripId ?? 0 },
    { enabled: tripId !== undefined && showPreview },
  );

  const create = trpc.trips.create.useMutation({
    onSuccess: () => {
      void utils.trips.invalidate();
      setToast("Trip created");
    },
    onError: (e) => setToast(e.message),
  });
  const setStatus = trpc.trips.setStatus.useMutation({ onSuccess: () => void utils.trips.invalidate() });
  const markTarget = trpc.trips.markTarget.useMutation({ onSuccess: () => void utils.trips.invalidate() });
  const markPoi = trpc.plan.markPoi.useMutation({ onSuccess: () => void utils.plan.fanout.invalidate() });
  const setPosition = trpc.trips.setPosition.useMutation({
    onSuccess: () => {
      void utils.trips.invalidate();
      setToast("Position updated — next plans start here");
    },
  });
  const sendDigest = trpc.digest.sendNow.useMutation({
    onSuccess: (r) => {
      const p = r.push;
      const detail = p.ok ? "sent" : "skipped" in p && p.skipped ? `skipped (${p.skipped})` : "error" in p ? p.error : "failed";
      setToast(p.ok ? "Digest sent" : `Digest saved; push ${detail}`);
    },
  });

  const [activeForm, setActiveForm] = useState<"new-trip" | "set-position" | null>(null);

  const forms: JSX.Element | null =
    activeForm === "new-trip" ? (
      <FormModal
        title="New trip"
        hint="The direct drive duration is computed on creation; the deviation budget is twice it."
        fields={[
          { name: "name", label: "Trip name", defaultValue: "New adventure", required: true },
          { name: "originName", label: "Origin (label)", placeholder: "Portland, OR", required: true },
          { name: "originLat", label: "Origin latitude", type: "number", min: -90, max: 90, required: true },
          { name: "originLng", label: "Origin longitude", type: "number", min: -180, max: 180, required: true },
          { name: "destName", label: "Anchor destination (label)", placeholder: "Las Vegas, NV", required: true },
          { name: "destLat", label: "Destination latitude", type: "number", min: -90, max: 90, required: true },
          { name: "destLng", label: "Destination longitude", type: "number", min: -180, max: 180, required: true },
          { name: "dailyDriveHours", label: "Daily drive hours", type: "number", min: 1, max: 12, defaultValue: "4", required: true },
        ]}
        submitLabel="Create trip"
        onSubmit={(v) =>
          create.mutate({
            name: v.name!,
            originName: v.originName!,
            origin: { lat: Number(v.originLat), lng: Number(v.originLng) },
            destName: v.destName!,
            dest: { lat: Number(v.destLat), lng: Number(v.destLng) },
            dailyDriveHours: Number(v.dailyDriveHours),
            deviationBudgetRatio: 2,
          })
        }
        onClose={() => setActiveForm(null)}
      />
    ) : activeForm === "set-position" && active.data ? (
      <FormModal
        title="We are here"
        hint="Plans generated after this start from the given position."
        fields={[
          { name: "lat", label: "Latitude", type: "number", min: -90, max: 90, required: true },
          { name: "lng", label: "Longitude", type: "number", min: -180, max: 180, required: true },
          { name: "miles", label: "Miles driven since last recorded position (approx.)", type: "number", min: 0, defaultValue: "0", required: true },
        ]}
        submitLabel="Set position"
        onSubmit={(v) =>
          setPosition.mutate({
            tripId: active.data!.id,
            lat: Number(v.lat),
            lng: Number(v.lng),
            milesSinceLast: Number(v.miles),
          })
        }
        onClose={() => setActiveForm(null)}
      />
    ) : null;

  if (active.isLoading) return <p>Loading…</p>;

  if (!active.data) {
    return (
      <>
        <style>{VL_STYLES}</style>
        <h2>Trip</h2>
        <p>No active trip.</p>
        <button className="vl-checkin-btn" onClick={() => setActiveForm("new-trip")}>New trip</button>
        {forms}
        {toast ? <div className="vl-toast">{toast}</div> : null}
      </>
    );
  }

  const t = trip.data;
  // Resolution is computed server-side per read, so flatten the tree to look
  // up what each anchor actually routes through.
  const anchorById = new Map(
    (function flat(ns: NonNullable<typeof t>["targets"]): NonNullable<typeof t>["targets"] {
      return ns.flatMap((n) => [n, ...flat(n.children)]);
    })(t?.targets ?? []).map((a) => [a.id, a] as const),
  );
  const budget = t?.usage;

  return (
    <>
      <style>{VL_STYLES}</style>
      <h2>
        {active.data.name} <small style={{ color: "#666" }}>({active.data.status})</small>
      </h2>
      <DashboardGrid>
        <StatCard
          label="Direct drive (baseline)"
          value={minutesToH(budget?.baselineMinutes)}
          detail={budget?.baselineMinutes === null ? "computed when routing is reachable" : "frozen at trip creation"}
        />
        <StatCard
          label="Deviation budget"
          value={minutesToH(budget?.budgetMinutes)}
          detail={`${String(active.data.deviationBudgetRatio)}× the direct duration`}
        />
        <StatCard
          label="Driving recorded"
          value={minutesToH(budget?.spentMinutes)}
          tone={
            budget?.budgetMinutes != null && budget.spentMinutes > budget.budgetMinutes ? "alert" : "neutral"
          }
          detail={budget?.remainingMinutes != null ? `${minutesToH(budget.remainingMinutes)} of budget left` : undefined}
        />
      </DashboardGrid>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <button className="vl-checkin-btn" onClick={() => setActiveForm("new-trip")}>New trip</button>
        {active.data.status === "active" ? (
          <button className="vl-checkin-btn" onClick={() => setStatus.mutate({ id: active.data!.id, status: "completed" })}>
            Complete trip
          </button>
        ) : null}
        <button className="vl-checkin-btn" onClick={() => setActiveForm("set-position")}>
          Set position
        </button>
        <button className="vl-checkin-btn" onClick={() => tripId !== undefined && sendDigest.mutate({ tripId })}>
          Send digest now
        </button>
        <button className="vl-checkin-btn" onClick={() => setShowPreview(!showPreview)}>
          {showPreview ? "Hide digest preview" : "Preview digest"}
        </button>
      </div>

      {showPreview && preview.data ? (
        <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <strong>Digest preview ({preview.data.priority})</strong>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: ".85rem", margin: "6px 0 0" }}>
            {JSON.stringify(preview.data.body, null, 2)}
          </pre>
        </div>
      ) : null}

      <h3>Route anchors</h3>
      <p style={{ color: "#666", fontSize: ".9rem", marginTop: 0 }}>
        Regions the route has to pass through. Draw and narrow them on the{" "}
        <a href="/anchors">Anchors page</a> — this table is the quick view.
      </p>
      <DataTable
        columns={[
          { key: "order", header: "#", render: (w) => w.orderIndex + 1 },
          { key: "name", header: "Anchor", render: (w) => w.name },
          {
            key: "radius",
            header: "Area",
            render: (w) => (w.radiusMiles > 0 ? `${String(w.radiusMiles)} mi` : "exact"),
          },
          {
            key: "resolved",
            header: "Routing via",
            render: (w) => {
              const a = anchorById.get(w.id);
              if (!a?.resolved) return w.radiusMiles > 0 ? "narrowed below" : "—";
              if (a.resolved.via === "poi") return a.resolved.poiName ?? "a place";
              if (a.resolved.via === "pinned") return "your pinned spot";
              if (a.resolved.via === "geometric") return "nearest point (no places known)";
              return "—";
            },
          },
          { key: "kind", header: "Kind", render: (w) => w.kind },
          { key: "status", header: "Status", render: (w) => w.status },
          {
            key: "actions",
            header: "",
            render: (w) =>
              w.status === "pending" ? (
                <span style={{ display: "inline-flex", gap: 6 }}>
                  <button className="vl-checkin-btn" onClick={() => markTarget.mutate({ id: w.id, status: "visited" })}>
                    Visited
                  </button>
                  <button className="vl-checkin-btn" onClick={() => markTarget.mutate({ id: w.id, status: "skipped" })}>
                    Skip
                  </button>
                </span>
              ) : (
                <button className="vl-checkin-btn" onClick={() => markTarget.mutate({ id: w.id, status: "pending" })}>
                  Restore
                </button>
              ),
          },
        ]}
        rows={t?.waypoints ?? []}
        rowKey={(w) => w.id}
        emptyMessage="No anchors — the plan heads straight for the destination."
      />

      <h3>Corridor places — pin the cool, reject the noise</h3>
      <p style={{ color: "#666", fontSize: ".9rem" }}>
        Everything the deviation budget allows between here and {active.data.destName}, ranked by your
        interests. Narrowing here shapes every future day.
      </p>
      <DataTable
        columns={[
          { key: "name", header: "Place", render: (p) => p.name },
          { key: "category", header: "Category", render: (p) => p.category },
          { key: "source", header: "Source", render: (p) => p.source },
          { key: "score", header: "Score", render: (p) => p.score.toFixed(2), sortValue: (p) => p.score },
          {
            key: "mark",
            header: "Mark",
            render: (p) => {
              const mark = fanout.data?.marks.find((m) => m.poiId === p.id)?.mark ?? null;
              return (
                <span style={{ display: "inline-flex", gap: 6 }}>
                  <button
                    className="vl-checkin-btn"
                    style={mark === "pinned" ? { fontWeight: 700 } : {}}
                    onClick={() =>
                      markPoi.mutate({ tripId: active.data!.id, poiId: p.id, mark: mark === "pinned" ? null : "pinned" })
                    }
                  >
                    📌
                  </button>
                  <button
                    className="vl-checkin-btn"
                    style={mark === "rejected" ? { fontWeight: 700 } : {}}
                    onClick={() =>
                      markPoi.mutate({ tripId: active.data!.id, poiId: p.id, mark: mark === "rejected" ? null : "rejected" })
                    }
                  >
                    ✕
                  </button>
                </span>
              );
            },
          },
        ]}
        rows={fanout.data?.pois ?? []}
        rowKey={(p) => p.id}
        emptyMessage={fanout.isLoading ? "Scanning the corridor…" : "No places in the corridor yet — check the sources page."}
      />

      <h3>Digests</h3>
      {(digests.data ?? []).length === 0 ? (
        <p style={{ color: "#666" }}>
          No digests yet — the first one is generated at the configured morning hour, or on "Send digest now".
        </p>
      ) : null}
      {(digests.data ?? []).map((d) => (
        <details key={d.id} style={{ marginBottom: 8 }}>
          <summary>
            {d.date} · {d.priority}
          </summary>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: ".85rem" }}>{JSON.stringify(d.body, null, 2)}</pre>
        </details>
      ))}

      <h3>All trips</h3>
      <DataTable
        columns={[
          { key: "name", header: "Trip", render: (row) => row.name },
          { key: "route", header: "Route", render: (row) => `${row.originName} → ${row.destName}` },
          { key: "status", header: "Status", render: (row) => row.status },
          {
            key: "actions",
            header: "",
            render: (row) =>
              row.status === "active" ? (
                "current"
              ) : (
                <span style={{ display: "inline-flex", gap: 6 }}>
                  {row.status === "planning" ? (
                    <button
                      className="vl-checkin-btn"
                      onClick={() => setStatus.mutate({ id: row.id, status: "active" })}
                    >
                      Activate
                    </button>
                  ) : null}
                  {row.status === "completed" ? (
                    <button
                      className="vl-checkin-btn"
                      onClick={() => setStatus.mutate({ id: row.id, status: "archived" })}
                    >
                      Archive
                    </button>
                  ) : null}
                </span>
              ),
          },
        ]}
        rows={allTrips.data ?? []}
        rowKey={(row) => row.id}
        emptyMessage="No trips yet."
      />
      {forms}
      {toast ? <div className="vl-toast">{toast}</div> : null}
    </>
  );
}
