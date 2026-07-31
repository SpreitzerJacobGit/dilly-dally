/**
 * System status — from any browser, no server access needed: whether the
 * installation is healthy and ready, what recurring jobs have actually done,
 * whether the offline basemap bundle is present, and what recently went wrong.
 */
import { useCallback, useEffect, useState, type JSX } from "react";
import { StatCard, DashboardGrid } from "@elements/output-dashboard-cards";
import { DataTable } from "@elements/shell-crud-tables";
import type { PageUser } from "../index.js";
import { VL_STYLES } from "../styles.js";

interface HealthInfo {
  ok: boolean;
}

interface JobRow {
  name: string;
  enabled: boolean;
  runCount: number;
  failCount: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

/** Sections (like job statuses) are merged top-level into /__diag. */
interface DiagInfo {
  identity?: Record<string, string>;
  uptimeSeconds?: number;
  recentProblems?: { time: string; level: string; msg: string }[];
  jobs?: JobRow[];
}

interface TilesInfo {
  present: boolean;
  archives: string[];
  glyphs: boolean;
  sprites: boolean;
}

function timeOrNever(value: string | null | undefined): string {
  return value ? value.replace("T", " ").slice(0, 19) : "Never";
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function StatusPage(_props: { user: PageUser }): JSX.Element {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [ready, setReady] = useState<boolean | null>(null);
  const [diag, setDiag] = useState<DiagInfo | null>(null);
  const [tiles, setTiles] = useState<TilesInfo | null>(null);

  const load = useCallback(async () => {
    setHealth(await fetchJson<HealthInfo>("/healthz"));
    setReady((await fetchJson<{ ok: boolean }>("/readyz"))?.ok ?? false);
    setDiag(await fetchJson<DiagInfo>("/__diag"));
    setTiles(await fetchJson<TilesInfo>("/tiles/status"));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <style>{VL_STYLES}</style>
      <h2>System status</h2>
      <DashboardGrid>
        <StatCard
          label="Health"
          value={health === null ? "unreachable" : health.ok ? "Healthy" : "Unhealthy"}
          tone={health?.ok ? "good" : "alert"}
        />
        <StatCard
          label="Ready for traffic"
          value={ready === null ? "…" : ready ? "Yes" : "No"}
          tone={ready ? "good" : "alert"}
        />
        <StatCard
          label="Offline basemap"
          value={tiles?.present && tiles.archives.length > 0 ? "Present" : "Missing"}
          tone={tiles?.present && tiles.archives.length > 0 ? "good" : "alert"}
          detail={tiles ? `${tiles.archives.join(", ") || "no archive"} · glyphs ${tiles.glyphs ? "✓" : "✗"} · sprites ${tiles.sprites ? "✓" : "✗"}` : undefined}
        />
        <StatCard
          label="Uptime"
          value={diag?.uptimeSeconds !== undefined ? `${String(Math.floor(diag.uptimeSeconds / 3600))}h ${String(Math.floor((diag.uptimeSeconds % 3600) / 60))}m` : "—"}
          detail={diag?.identity ? Object.values(diag.identity).join(" · ") : undefined}
        />
      </DashboardGrid>

      <h3>Recurring jobs</h3>
      <DataTable
        columns={[
          { key: "name", header: "Job", render: (j) => j.name },
          { key: "enabled", header: "Enabled", render: (j) => (j.enabled ? "yes" : "no") },
          { key: "runs", header: "Runs / fails", render: (j) => `${String(j.runCount)} / ${String(j.failCount)}` },
          { key: "lastRun", header: "Last real attempt", render: (j) => timeOrNever(j.lastRunAt) },
          { key: "lastOk", header: "Last success", render: (j) => timeOrNever(j.lastSuccessAt) },
          { key: "err", header: "Last error", render: (j) => j.lastError ?? "—" },
        ]}
        rows={diag?.jobs ?? []}
        rowKey={(j) => j.name}
        emptyMessage="No job status yet."
      />

      <h3>Recent problems</h3>
      <DataTable
        columns={[
          { key: "time", header: "When", render: (p) => timeOrNever(p.time) },
          { key: "level", header: "Level", render: (p) => p.level },
          { key: "msg", header: "Message", render: (p) => p.msg },
        ]}
        rows={diag?.recentProblems ?? []}
        rowKey={(p) => `${p.time}-${p.msg}`}
        emptyMessage="Nothing has gone wrong recently."
      />
      <button className="vl-checkin-btn" onClick={() => void load()} style={{ marginTop: 8 }}>
        Refresh
      </button>
    </>
  );
}
