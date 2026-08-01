import type { JSX } from "react";
import { StatCard, DashboardGrid } from "@elements/output-dashboard-cards";
import { DataTable } from "@elements/shell-crud-tables";

/**
 * The bookkeeping tab: the budget, the trip-level actions, the corridor of
 * places the deviation budget allows, and the digest history.
 */

function minutesToH(m: number | null | undefined): string {
  if (m === null || m === undefined) return "—";
  return `${(m / 60).toFixed(1)} h`;
}

export interface CorridorPlace {
  id: number;
  name: string;
  category: string;
  source: string;
  score: number;
}

export interface TripStatsPanelProps {
  status: string;
  destName: string;
  deviationBudgetRatio: number;
  usage: {
    baselineMinutes: number | null;
    budgetMinutes: number | null;
    spentMinutes: number;
    remainingMinutes: number | null;
  } | null;
  places: CorridorPlace[];
  placesLoading: boolean;
  marks: { poiId: number; mark: string }[];
  digests: { id: number; date: string; priority: string; body?: unknown }[];
  previewOpen: boolean;
  preview: { priority: string; body: unknown } | null;
  onComplete: () => void;
  onSetPosition: () => void;
  onSendDigest: () => void;
  onTogglePreview: () => void;
  onMarkPoi: (poiId: number, mark: "pinned" | "rejected" | null) => void;
}

export function TripStatsPanel(props: TripStatsPanelProps): JSX.Element {
  const budget = props.usage;
  return (
    <>
      <DashboardGrid>
        <StatCard
          label="Direct drive (baseline)"
          value={minutesToH(budget?.baselineMinutes)}
          detail={
            budget?.baselineMinutes === null
              ? "computed when routing is reachable"
              : "frozen until an endpoint moves"
          }
        />
        <StatCard
          label="Deviation budget"
          value={minutesToH(budget?.budgetMinutes)}
          detail={`${String(props.deviationBudgetRatio)}× the direct duration`}
        />
        <StatCard
          label="Driving recorded"
          value={minutesToH(budget?.spentMinutes)}
          tone={budget?.budgetMinutes != null && budget.spentMinutes > budget.budgetMinutes ? "alert" : "neutral"}
          detail={
            budget?.remainingMinutes != null ? `${minutesToH(budget.remainingMinutes)} of budget left` : undefined
          }
        />
      </DashboardGrid>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0" }}>
        {props.status === "active" ? (
          <button className="vl-checkin-btn" onClick={props.onComplete}>
            Complete trip
          </button>
        ) : null}
        <button className="vl-checkin-btn" onClick={props.onSetPosition}>
          Set position
        </button>
        <button className="vl-checkin-btn" onClick={props.onSendDigest}>
          Send digest now
        </button>
        <button className="vl-checkin-btn" onClick={props.onTogglePreview}>
          {props.previewOpen ? "Hide digest preview" : "Preview digest"}
        </button>
      </div>

      {props.previewOpen && props.preview ? (
        <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <strong>Digest preview ({props.preview.priority})</strong>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: ".85rem", margin: "6px 0 0" }}>
            {JSON.stringify(props.preview.body, null, 2)}
          </pre>
        </div>
      ) : null}

      <h3>Corridor places — pin the cool, reject the noise</h3>
      <p style={{ color: "#666", fontSize: ".9rem" }}>
        Everything the deviation budget allows between here and {props.destName}, ranked by your
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
              const mark = props.marks.find((m) => m.poiId === p.id)?.mark ?? null;
              return (
                <span style={{ display: "inline-flex", gap: 6 }}>
                  <button
                    className="vl-checkin-btn"
                    style={mark === "pinned" ? { fontWeight: 700 } : {}}
                    onClick={() => props.onMarkPoi(p.id, mark === "pinned" ? null : "pinned")}
                  >
                    📌
                  </button>
                  <button
                    className="vl-checkin-btn"
                    style={mark === "rejected" ? { fontWeight: 700 } : {}}
                    onClick={() => props.onMarkPoi(p.id, mark === "rejected" ? null : "rejected")}
                  >
                    ✕
                  </button>
                </span>
              );
            },
          },
        ]}
        rows={props.places}
        rowKey={(p) => p.id}
        emptyMessage={
          props.placesLoading ? "Scanning the corridor…" : "No places in the corridor yet — check the sources page."
        }
      />

      <h3>Digests</h3>
      {props.digests.length === 0 ? (
        <p style={{ color: "#666" }}>
          No digests yet — the first one is generated at the configured morning hour, or on “Send
          digest now”.
        </p>
      ) : null}
      {props.digests.map((d) => (
        <details key={d.id} style={{ marginBottom: 8 }}>
          <summary>
            {d.date} · {d.priority}
          </summary>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: ".85rem" }}>{JSON.stringify(d.body, null, 2)}</pre>
        </details>
      ))}
    </>
  );
}
