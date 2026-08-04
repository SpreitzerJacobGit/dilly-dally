/**
 * System status — from any browser, no server access needed: whether the
 * installation is healthy and ready, what recurring jobs have actually done,
 * whether the offline basemap bundle is present, and what recently went wrong.
 */
import { useCallback, useEffect, useState, type JSX } from "react";
import { StatCard, DashboardGrid } from "@elements/output-dashboard-cards";
import { DataTable } from "@elements/shell-crud-tables";
import type { PageUser } from "../index.js";
import { readCellSignalManifest } from "../lib/cellSignal.js";
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
  manifests?: Record<string, unknown>;
}

/** The overlay archive and the sidecar written beside it by the overlay prep. */
const LEGAL_ARCHIVE = "legal-camping.pmtiles";

interface LegalProvenance {
  generatedAt?: string;
  defaultBufferFeet?: number;
  verifiedForests?: { forest: string }[];
  sources?: { name: string; retrieved: string }[];
}

function timeOrNever(value: string | null | undefined): string {
  return value ? value.replace("T", " ").slice(0, 19) : "Never";
}

/**
 * The coverage archive is built by a scheduled task on the host rather than by
 * the deploy, so "not installed" is an ordinary state on a fresh van and reads
 * neutral. The state worth shouting about is the opposite one: an archive that
 * is present, looks fine on the map, and has not successfully refreshed since
 * March. That is the failure this card exists to make visible.
 */
function coverageStatus(tiles: TilesInfo | null): {
  value: string;
  tone: "neutral" | "good" | "alert";
  detail: string;
} {
  if (tiles === null) return { value: "…", tone: "neutral", detail: "" };
  if (!tiles.archives.includes("cell-signal.pmtiles")) {
    return {
      value: "Not installed",
      tone: "neutral",
      detail: "Run deploy/refresh-cell-signal.ps1 to build it",
    };
  }
  const manifest = readCellSignalManifest(tiles);
  if (manifest === null) return { value: "Present", tone: "good", detail: "no manifest — age unknown" };
  const asOf = manifest.asOfDate ?? "unknown date";
  if (manifest.lastError !== null) {
    return {
      value: "Stale",
      tone: "alert",
      detail: `as of ${asOf} · last success ${timeOrNever(manifest.lastSuccess)} · ${manifest.lastError}`,
    };
  }
  return {
    value: "Present",
    tone: "good",
    detail: `as of ${asOf} · last checked ${timeOrNever(manifest.lastRun)}`,
  };
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
  const [legal, setLegal] = useState<LegalProvenance | null>(null);

  const load = useCallback(async () => {
    setHealth(await fetchJson<HealthInfo>("/healthz"));
    setReady((await fetchJson<{ ok: boolean }>("/readyz"))?.ok ?? false);
    setDiag(await fetchJson<DiagInfo>("/__diag"));
    const t = await fetchJson<TilesInfo>("/tiles/status");
    setTiles(t);
    // Only asked for when the archive is actually there — a 404 for the sidecar
    // of an overlay nobody installed is noise, not a finding.
    setLegal(
      t?.archives.includes(LEGAL_ARCHIVE) === true
        ? await fetchJson<LegalProvenance>("/tiles/legal-camping.json")
        : null,
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const coverage = coverageStatus(tiles);

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
        {/* Never "alert": an overlay nobody installed is a choice, not a fault.
            The map simply draws no legality wash, and unshaded already means
            "unverified" rather than "illegal". */}
        <StatCard
          label="Legal camping overlay"
          value={tiles === null ? "…" : tiles.archives.includes(LEGAL_ARCHIVE) ? "Present" : "Not installed"}
          tone={tiles?.archives.includes(LEGAL_ARCHIVE) ? "good" : undefined}
          detail={
            legal
              ? `built ${timeOrNever(legal.generatedAt)} · ${String(legal.verifiedForests?.length ?? 0)} forest(s) with a published distance · ${String(legal.defaultBufferFeet ?? 0)} ft assumed elsewhere`
              : tiles?.archives.includes(LEGAL_ARCHIVE)
                ? "archive present, provenance sidecar missing"
                : "run deploy/prepare-legal-overlay.ps1 to build it"
          }
        />
        <StatCard
          label="Cell coverage data"
          value={coverage.value}
          tone={coverage.tone}
          detail={coverage.detail || undefined}
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
