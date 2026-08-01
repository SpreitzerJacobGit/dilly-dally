import { useEffect, useMemo, useState, type JSX } from "react";
import { trpc } from "../trpc.js";
import type { MapPoiView } from "../map/types.js";

/**
 * NEED-6: the places that can service one need, measured two ways — how far
 * from the van, and how many minutes onto today's route. The list comes from
 * places already stored on the van server, so it answers with no uplink; when
 * the router is down the added-time figures say they are estimates rather than
 * the sheet going blank (OFF-3).
 *
 * The sheet owns the read; the page owns the writes, so pinning reuses the
 * dashboard's existing mark-and-replan path.
 */

type SortMode = "route" | "distance";

export function NeedSearchSheet(props: {
  tripId: number;
  need: { id: number; title: string; poiCategory: string | null };
  /** Rank against this candidate; null falls back to the day's selection. */
  candidateId: number | null;
  /** The row whose pin write is in flight, if any. */
  pendingPoiId: number | null;
  onPin: (poiId: number) => void;
  onUnpin: (poiId: number) => void;
  onShowDetails: (poiId: number) => void;
  onOptionsChange: (options: MapPoiView[]) => void;
  onClose: () => void;
}): JSX.Element {
  const [sort, setSort] = useState<SortMode>("route");
  const query = trpc.plan.needOptions.useQuery(
    {
      tripId: props.tripId,
      needId: props.need.id,
      candidateId: props.candidateId ?? undefined,
      radiusMiles: 60,
      limit: 20,
    },
    { retry: 1 },
  );

  const data = query.data;
  const routeless = data?.detourSource === "none";

  // Sorting is client-side on the same array: instant, and it keeps working
  // after the uplink drops with the results already in hand.
  const options = useMemo(() => {
    if (!data) return [];
    const rows = [...data.options];
    if (sort === "distance" || routeless) {
      rows.sort((a, b) => a.milesFromHere - b.milesFromHere || a.poiId - b.poiId);
    } else {
      rows.sort(
        (a, b) =>
          (a.detourMinutes ?? Number.POSITIVE_INFINITY) -
            (b.detourMinutes ?? Number.POSITIVE_INFINITY) || a.poiId - b.poiId,
      );
    }
    return rows;
  }, [data, sort, routeless]);

  const { onOptionsChange } = props;
  useEffect(() => {
    onOptionsChange(
      options.map((o) => ({ id: o.poiId, name: o.name, category: o.category, lat: o.lat, lng: o.lng })),
    );
  }, [options, onOptionsChange]);

  return (
    <div className="vl-modal-backdrop" onClick={props.onClose}>
      <div className="vl-modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0, display: "flex", alignItems: "center", gap: 8 }}>
          {props.need.title}
          {props.need.poiCategory ? <span className="vl-badge">{props.need.poiCategory}</span> : null}
        </h3>

        {data?.message ? <div className="vl-offline">{data.message}</div> : null}

        {query.isError ? (
          <div className="vl-offline">
            Couldn&rsquo;t load places: {query.error.message}{" "}
            <button className="vl-checkin-btn" onClick={() => void query.refetch()}>
              Retry
            </button>
          </div>
        ) : null}

        {data && data.options.length > 0 ? (
          <div className="vl-sheet-sorts">
            <button
              className="vl-checkin-btn"
              style={sort === "route" && !routeless ? { fontWeight: 700 } : {}}
              disabled={routeless}
              title={routeless ? "Pick a route for today first" : undefined}
              onClick={() => setSort("route")}
            >
              On the way
            </button>
            <button
              className="vl-checkin-btn"
              style={sort === "distance" || routeless ? { fontWeight: 700 } : {}}
              onClick={() => setSort("distance")}
            >
              Nearby
            </button>
          </div>
        ) : null}

        {query.isPending ? <p style={{ color: "#666", fontSize: ".85rem" }}>Looking…</p> : null}

        {data && data.options.length === 0 && !query.isError ? (
          <p style={{ color: "#666", fontSize: ".85rem" }}>
            {props.need.poiCategory === null
              ? "This need is a checklist item — it never generates route stops."
              : `No stored ${props.need.poiCategory} places within 60 miles. Places refresh when the van has internet.`}
          </p>
        ) : null}

        {options.map((o) => (
          <div key={o.poiId} className={`vl-sheet-row${o.pinned ? " vl-pinned" : ""}`}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{o.name}</div>
              <div className="vl-meta">
                {o.milesFromHere.toFixed(0)} mi away
                {o.detourMinutes !== null
                  ? ` · +${String(o.detourMinutes)} min${data?.detourSource === "estimated" ? " est." : ""}`
                  : ""}
                {" · "}
                {o.source}
              </div>
              <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
                {o.pinned ? <span className="vl-badge">📌 Pinned</span> : null}
                {o.plannedToday ? <span className="vl-badge">On today&rsquo;s plan</span> : null}
              </div>
            </div>
            <div className="vl-sheet-actions">
              <button className="vl-checkin-btn" onClick={() => props.onShowDetails(o.poiId)}>
                Details
              </button>
              <button
                className="vl-checkin-btn"
                disabled={props.pendingPoiId === o.poiId}
                onClick={() => (o.pinned ? props.onUnpin(o.poiId) : props.onPin(o.poiId))}
              >
                {props.pendingPoiId === o.poiId ? "…" : o.pinned ? "Un-pin" : "Add"}
              </button>
            </div>
          </div>
        ))}

        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className="vl-checkin-btn" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
