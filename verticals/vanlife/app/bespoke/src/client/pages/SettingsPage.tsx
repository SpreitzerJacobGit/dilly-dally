import { useState, type JSX } from "react";
import { DataTable } from "@elements/shell-crud-tables";
import { trpc } from "../trpc.js";
import type { PageUser } from "../index.js";
import { FormModal } from "../components/FormModal.js";
import { VL_STYLES } from "../styles.js";

type SettingsForm =
  | "api-keys"
  | "import"
  | "ntfy"
  | "digest-hour"
  | "add-operator"
  | "default-drive-hours"
  | "trip-drive-hours"
  | null;

export function SettingsPage(_props: { user: PageUser }): JSX.Element {
  const utils = trpc.useUtils();
  const [toast, setToast] = useState<string | null>(null);
  const [activeForm, setActiveForm] = useState<SettingsForm>(null);

  const interests = trpc.interests.list.useQuery();
  const setWeight = trpc.interests.setWeight.useMutation({
    onSuccess: () => {
      void utils.interests.list.invalidate();
      setToast("Weight saved — re-ranks on the next plan generation");
    },
  });

  const poiStatus = trpc.sources.poiSources.status.useQuery();
  const saveKeys = trpc.sources.poiSources.saveKeys.useMutation({
    onSuccess: () => {
      void utils.sources.poiSources.status.invalidate();
      setToast("API keys saved");
    },
  });
  const refreshNow = trpc.sources.poiSources.refreshNow.useMutation({
    onSuccess: (r) => setToast(r.started ? "Refresh started" : `Not started: ${r.reason ?? "unknown"}`),
  });

  const ntfy = trpc.sources.ntfy.status.useQuery();
  const saveNtfy = trpc.sources.ntfy.saveSettings.useMutation({
    onSuccess: () => {
      void utils.sources.ntfy.status.invalidate();
      setToast("Push settings saved");
    },
  });
  const testPush = trpc.sources.ntfy.testPublish.useMutation({
    onSuccess: (r) => setToast(r.ok ? "Test notification sent" : `Failed: ${"error" in r ? r.error : (r.skipped ?? "unknown")}`),
  });

  const tripDefaults = trpc.trips.defaults.useQuery();
  const saveTripDefaults = trpc.trips.saveDefaults.useMutation({
    onSuccess: () => {
      void utils.trips.defaults.invalidate();
      setToast("Saved — applies to trips created from now on");
    },
    onError: (e) => setToast(e.message),
  });
  const activeTrip = trpc.trips.active.useQuery();
  const updateTrip = trpc.trips.update.useMutation({
    onSuccess: () => {
      void utils.trips.invalidate();
      setToast("Pace saved — replan to build today around it");
    },
    onError: (e) => setToast(e.message),
  });

  const digestSettings = trpc.digest.settings.useQuery();
  const saveDigest = trpc.digest.saveSettings.useMutation({
    onSuccess: () => {
      void utils.digest.settings.invalidate();
      setToast("Digest hour saved");
    },
  });

  const clearNtfy = trpc.sources.ntfy.clearSettings.useMutation({
    onSuccess: () => {
      void utils.sources.ntfy.status.invalidate();
      setToast("Push disabled — the in-app digest banner keeps working");
    },
  });
  const importDataset = trpc.pois.importDataset.useMutation({
    onSuccess: (r) => setToast(`Imported ${String(r.imported)} places, rejected ${String(r.rejected.length)}`),
    onError: (e) => setToast(e.message),
  });
  const usersQ = trpc.users.list.useQuery();
  const createUser = trpc.users.create.useMutation({
    onSuccess: () => {
      void utils.users.list.invalidate();
      setToast("Account created");
    },
    onError: (e) => setToast(e.message),
  });
  const setRole = trpc.users.setRole.useMutation({
    onSuccess: () => void utils.users.list.invalidate(),
  });
  const deactivate = trpc.users.deactivate.useMutation({
    onSuccess: () => {
      void utils.users.list.invalidate();
      setToast("Account deactivated and signed out");
    },
  });

  return (
    <>
      <style>{VL_STYLES}</style>
      <h2>Settings</h2>

      <h3>Interest weights</h3>
      <p style={{ color: "#666", fontSize: ".9rem" }}>
        Bias side-quest suggestions toward what you love. Zero removes a category entirely.
      </p>
      <DataTable
        columns={[
          { key: "category", header: "Category", render: (w) => w.category },
          {
            key: "weight",
            header: "Weight",
            render: (w) => (
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                defaultValue={w.weight}
                onMouseUp={(e) => setWeight.mutate({ category: w.category, weight: Number((e.target as HTMLInputElement).value) })}
                onTouchEnd={(e) => setWeight.mutate({ category: w.category, weight: Number((e.target as HTMLInputElement).value) })}
              />
            ),
          },
          { key: "value", header: "", render: (w) => w.weight.toFixed(1) },
        ]}
        rows={interests.data ?? []}
        rowKey={(w) => w.category}
        emptyMessage="No interest categories seeded."
      />

      <h3>Place sources</h3>
      <DataTable
        columns={[
          { key: "source", header: "Source", render: (s) => s.source },
          { key: "state", header: "State", render: (s) => s.state },
          { key: "lastRun", header: "Last checked", render: (s) => s.lastRunAt?.slice(0, 16).replace("T", " ") ?? "never" },
          { key: "lastOk", header: "Last succeeded", render: (s) => s.lastSuccessAt?.slice(0, 16).replace("T", " ") ?? "never" },
          { key: "fetched", header: "Places fetched", render: (s) => s.fetchedCount ?? "—" },
          { key: "err", header: "Error", render: (s) => s.lastError ?? "—" },
        ]}
        rows={poiStatus.data ?? []}
        rowKey={(s) => s.source}
        emptyMessage="Loading source states…"
      />
      <div style={{ display: "flex", gap: 8, margin: "8px 0", flexWrap: "wrap" }}>
        <button className="vl-checkin-btn" onClick={() => setActiveForm("api-keys")}>
          Set API keys
        </button>
        <button className="vl-checkin-btn" onClick={() => refreshNow.mutate()}>
          Refresh places now
        </button>
        <button
          className="vl-checkin-btn"
          title="Paste a JSON array of PoiRecords (e.g. converted from an iOverlander export)"
          onClick={() => setActiveForm("import")}
        >
          Import dataset (JSON)
        </button>
      </div>

      <h3>Push notifications (ntfy)</h3>
      {ntfy.data ? (
        <p style={{ fontSize: ".9rem" }}>
          {ntfy.data.configured ? (
            <>
              Publishing to <code>{ntfy.data.serverUrl}/{ntfy.data.topic}</code>
              {ntfy.data.hasToken ? " (with token)" : ""} — subscribe to this topic in the ntfy app on both phones.
            </>
          ) : (
            "Not configured — the digest banner still works; push is off."
          )}
        </p>
      ) : null}
      <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <button className="vl-checkin-btn" onClick={() => setActiveForm("ntfy")}>
          Configure push
        </button>
        <button className="vl-checkin-btn" onClick={() => testPush.mutate()}>
          Send test notification
        </button>
        {ntfy.data?.configured ? (
          <button className="vl-checkin-btn" onClick={() => clearNtfy.mutate()}>
            Disable push
          </button>
        ) : null}
      </div>
      {(ntfy.data?.recent.length ?? 0) > 0 ? (
        <DataTable
          columns={[
            { key: "when", header: "When", render: (r) => r.createdAt.slice(0, 16).replace("T", " ") },
            { key: "title", header: "Title", render: (r) => r.title },
            { key: "status", header: "Status", render: (r) => r.status },
            { key: "detail", header: "Detail", render: (r) => r.detail ?? "—" },
          ]}
          rows={ntfy.data?.recent ?? []}
          rowKey={(r) => r.id}
          emptyMessage=""
        />
      ) : null}

      <h3>Accounts</h3>
      <p style={{ color: "#666", fontSize: ".9rem" }}>
        Two co-equal operators; everyone is an operator — no per-person access control.
      </p>
      <DataTable
        columns={[
          { key: "email", header: "Email", render: (u) => u.email },
          { key: "role", header: "Role", render: (u) => u.role },
          { key: "active", header: "Status", render: (u) => (u.active ? "active" : "deactivated") },
          {
            key: "actions",
            header: "",
            render: (u) => (
              <span style={{ display: "inline-flex", gap: 6 }}>
                {u.role !== "operator" ? (
                  <button
                    className="vl-checkin-btn"
                    onClick={() => setRole.mutate({ userId: u.id, role: "operator" })}
                  >
                    Make operator
                  </button>
                ) : null}
                {u.active ? (
                  <button className="vl-checkin-btn" onClick={() => deactivate.mutate({ userId: u.id })}>
                    Deactivate
                  </button>
                ) : null}
              </span>
            ),
          },
        ]}
        rows={usersQ.data ?? []}
        rowKey={(u) => u.id}
        emptyMessage="Loading accounts…"
      />
      <button
        className="vl-checkin-btn"
        style={{ margin: "8px 0" }}
        onClick={() => setActiveForm("add-operator")}
      >
        Add operator account
      </button>

      <h3>Planning</h3>
      <p style={{ fontSize: ".9rem" }}>
        Daily drive hours for a new trip: <strong>{tripDefaults.data?.defaultDailyDriveHours ?? 4}h</strong>{" "}
        <button className="vl-checkin-btn" onClick={() => setActiveForm("default-drive-hours")}>
          Change
        </button>
      </p>
      {activeTrip.data ? (
        <p style={{ fontSize: ".9rem" }}>
          Daily drive hours on “{activeTrip.data.name}”: <strong>{activeTrip.data.dailyDriveHours}h</strong>{" "}
          <button className="vl-checkin-btn" onClick={() => setActiveForm("trip-drive-hours")}>
            Change
          </button>
          <br />
          <span style={{ color: "#666" }}>
            The trip’s pace. To drive more or less than this on one day only, set the hours on the
            planner’s Today tab.
          </span>
        </p>
      ) : null}

      <h3>Digest</h3>
      <p style={{ fontSize: ".9rem" }}>
        Morning digest hour: <strong>{digestSettings.data?.hour ?? 7}:00</strong> (server local time){" "}
        <button className="vl-checkin-btn" onClick={() => setActiveForm("digest-hour")}>
          Change
        </button>
      </p>

      {activeForm === "api-keys" ? (
        <FormModal
          title="Place source API keys"
          hint="Free keys: developer.nps.gov, ridb.recreation.gov, openchargemap.org. Blank fields keep their stored value."
          fields={[
            { name: "nps", label: "NPS API key", type: "password" },
            { name: "recgov", label: "Recreation.gov (RIDB) API key", type: "password" },
            { name: "ocm", label: "OpenChargeMap API key", type: "password" },
          ]}
          onSubmit={(v) => {
            const patch: Record<string, string> = {};
            if (v.nps) patch.npsApiKey = v.nps;
            if (v.recgov) patch.recreationGovApiKey = v.recgov;
            if (v.ocm) patch.openChargeMapApiKey = v.ocm;
            if (Object.keys(patch).length > 0) saveKeys.mutate(patch);
          }}
          onClose={() => setActiveForm(null)}
        />
      ) : null}
      {activeForm === "import" ? (
        <FormModal
          title="Import places dataset"
          hint="A JSON array of records: { source, sourceId, name, category, lat, lng, popularity?, url? }."
          fields={[{ name: "json", label: "JSON array", type: "textarea", required: true }]}
          submitLabel="Import"
          onSubmit={(v) => {
            try {
              const records = JSON.parse(v.json ?? "") as unknown[];
              importDataset.mutate({ records: records as never, label: "manual-import" });
            } catch {
              setToast("Not valid JSON");
            }
          }}
          onClose={() => setActiveForm(null)}
        />
      ) : null}
      {activeForm === "ntfy" ? (
        <FormModal
          title="Configure push (ntfy)"
          hint="Treat the topic like a password — pick something unguessable, then subscribe to it in the ntfy app on both phones."
          fields={[
            { name: "server", label: "ntfy server URL", defaultValue: ntfy.data?.serverUrl ?? "https://ntfy.sh", required: true },
            { name: "topic", label: "Topic", defaultValue: ntfy.data?.topic ?? "", required: true },
            { name: "token", label: "Access token (optional)", type: "password" },
          ]}
          onSubmit={(v) =>
            saveNtfy.mutate({ serverUrl: v.server!, topic: v.topic!, token: v.token ? v.token : undefined })
          }
          onClose={() => setActiveForm(null)}
        />
      ) : null}
      {activeForm === "default-drive-hours" ? (
        <FormModal
          title="Daily drive hours for a new trip"
          hint="Only the starting value for trips created from now on — existing trips keep their own pace."
          fields={[
            {
              name: "hours",
              label: "Hours (1–12)",
              type: "number",
              min: 1,
              max: 12,
              step: "0.5",
              defaultValue: String(tripDefaults.data?.defaultDailyDriveHours ?? 4),
              required: true,
            },
          ]}
          onSubmit={(v) => saveTripDefaults.mutate({ defaultDailyDriveHours: Number(v.hours) })}
          onClose={() => setActiveForm(null)}
        />
      ) : null}
      {activeForm === "trip-drive-hours" && activeTrip.data ? (
        <FormModal
          title={`Daily drive hours on “${activeTrip.data.name}”`}
          hint="The pace every day of this trip is planned around. It also re-times when each Target is expected."
          fields={[
            {
              name: "hours",
              label: "Hours (1–12)",
              type: "number",
              min: 1,
              max: 12,
              step: "0.5",
              defaultValue: String(activeTrip.data.dailyDriveHours),
              required: true,
            },
          ]}
          onSubmit={(v) => updateTrip.mutate({ id: activeTrip.data!.id, dailyDriveHours: Number(v.hours) })}
          onClose={() => setActiveForm(null)}
        />
      ) : null}
      {activeForm === "digest-hour" ? (
        <FormModal
          title="Digest hour"
          fields={[
            { name: "hour", label: "Hour (0–23, server local time)", type: "number", min: 0, max: 23, defaultValue: String(digestSettings.data?.hour ?? 7), required: true },
          ]}
          onSubmit={(v) => saveDigest.mutate({ hour: Number(v.hour) })}
          onClose={() => setActiveForm(null)}
        />
      ) : null}
      {activeForm === "add-operator" ? (
        <FormModal
          title="Add operator account"
          fields={[
            { name: "email", label: "Email", required: true },
            { name: "password", label: "Password (min 8 characters)", type: "password", required: true },
          ]}
          submitLabel="Create"
          onSubmit={(v) => createUser.mutate({ email: v.email!, password: v.password!, role: "operator" })}
          onClose={() => setActiveForm(null)}
        />
      ) : null}
      {toast ? <div className="vl-toast">{toast}</div> : null}
    </>
  );
}
