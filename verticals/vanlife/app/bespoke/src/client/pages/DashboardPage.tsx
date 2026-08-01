import { useEffect, useMemo, useState, type JSX } from "react";
import { trpc } from "../trpc.js";
import type { PageUser } from "../index.js";
import { MapView } from "../map/MapView.js";
import type { CandidateRouteView, MapPoiView } from "../map/types.js";
import { ROLE_LABELS, roleColor, PROJECTED_COLOR } from "../map/palette.js";
import { CandidateCard, type CandidateDetail } from "../components/CandidateList.js";
import { NeedsStrip, type NeedStateView } from "../components/NeedsStrip.js";
import { NeedSearchSheet } from "../components/NeedSearchSheet.js";
import { CheckInBar, type CheckInRequest } from "../components/CheckInBar.js";
import { DigestBanner, type DigestView } from "../components/DigestBanner.js";
import { enqueue, flushQueue, newClientId } from "../lib/checkinQueue.js";
import { VL_STYLES } from "../styles.js";

function parseLine(geometry: string | null): [number, number][] {
  if (!geometry) return [];
  try {
    const parsed = JSON.parse(geometry) as { coordinates?: [number, number][] };
    return parsed.coordinates ?? [];
  } catch {
    return [];
  }
}

interface Bbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export function DashboardPage(_props: { user: PageUser }): JSX.Element {
  const utils = trpc.useUtils();
  const [highlightedId, setHighlightedId] = useState<number | null>(null);
  const [viewport, setViewport] = useState<{ bbox: Bbox; zoom: number } | null>(null);
  const [poiDetailId, setPoiDetailId] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Route-through-needs: the need whose stop search is open, the places it
  // found (so the map can show them), and the row whose pin is in flight.
  const [needSearch, setNeedSearch] = useState<NeedStateView | null>(null);
  const [sheetPois, setSheetPois] = useState<MapPoiView[]>([]);
  const [pendingPoiId, setPendingPoiId] = useState<number | null>(null);

  const activeTrip = trpc.trips.active.useQuery();
  const tripId = activeTrip.data?.id;
  const plan = trpc.plan.today.useQuery(
    { tripId: tripId ?? 0 },
    { enabled: tripId !== undefined, staleTime: 60_000, retry: 2 },
  );
  const needsQ = trpc.needs.list.useQuery(undefined, { staleTime: 60_000, retry: 2 });
  const digestQ = trpc.digest.today.useQuery({ tripId: tripId ?? 0 }, { enabled: tripId !== undefined });
  const poisQ = trpc.pois.byBbox.useQuery(
    { bbox: viewport?.bbox ?? { south: 0, west: 0, north: 0, east: 0 }, limit: 300 },
    { enabled: viewport !== null && viewport.zoom >= 7, placeholderData: (prev) => prev },
  );
  const poiDetail = trpc.pois.byId.useQuery({ id: poiDetailId ?? 0 }, { enabled: poiDetailId !== null });

  const checkin = trpc.needs.checkin.useMutation({
    onSuccess: () => {
      void utils.needs.list.invalidate();
      void utils.plan.today.invalidate();
    },
  });
  const selectMut = trpc.plan.select.useMutation({ onSuccess: () => void utils.plan.today.invalidate() });
  const completeStop = trpc.plan.completeStop.useMutation({
    onSuccess: () => {
      void utils.plan.today.invalidate();
      void utils.needs.list.invalidate();
      void utils.trips.invalidate();
    },
  });
  const markPoi = trpc.plan.markPoi.useMutation({
    onSuccess: () => setToast("Saved — takes effect on the next replan"),
  });
  const replan = trpc.plan.replan.useMutation({
    onSuccess: () => void utils.plan.today.invalidate(),
    onError: (e) => setToast(`Replan unavailable: ${e.message}`),
  });

  // Flush the offline check-in queue on start / reconnect / refocus.
  useEffect(() => {
    const flush = (): void => {
      void flushQueue((item) => checkin.mutateAsync(item)).then((r) => {
        if (r.flushed > 0) setToast(`Synced ${String(r.flushed)} offline check-in${r.flushed > 1 ? "s" : ""}`);
      });
    };
    flush();
    window.addEventListener("online", flush);
    window.addEventListener("focus", flush);
    return () => {
      window.removeEventListener("online", flush);
      window.removeEventListener("focus", flush);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const candidates: CandidateDetail[] = useMemo(() => {
    return (plan.data?.candidates ?? []).map((c) => ({
      id: c.id,
      tier: c.tier,
      title: c.title,
      summary: c.summary,
      coordinates: parseLine(c.geometry),
      projected: parseLine(c.projectedGeometry),
      warnings: c.warnings,
      durationMinutes: c.durationMinutes,
      distanceMiles: c.distanceMiles,
      remainingBudgetMinutes: c.remainingBudgetMinutes,
      selected: c.selected,
      stops: c.stops.map((s) => ({
        orderIndex: s.orderIndex,
        name: s.toName,
        lat: s.toLat,
        lng: s.toLng,
        purpose: s.purpose,
        needId: s.needId,
        poiId: s.poiId,
        etaMinutesFromStart: s.etaMinutesFromStart,
      })),
    }));
  }, [plan.data]);

  useEffect(() => {
    if (highlightedId === null && candidates.length > 0) {
      const selected = candidates.find((c) => c.selected);
      setHighlightedId((selected ?? candidates[0]!).id);
    }
  }, [candidates, highlightedId]);

  const mapRoutes: CandidateRouteView[] = candidates;
  // While a need's stop search is open the map shows exactly those places —
  // the catalog underneath would bury a twenty-place answer.
  const mapPois: MapPoiView[] =
    needSearch !== null
      ? sheetPois
      : (poisQ.data ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          category: p.category,
          lat: p.lat,
          lng: p.lng,
        }));
  const needStates = (needsQ.data ?? []) as NeedStateView[];
  const digest = (digestQ.data ?? null) as DigestView | null;
  const searchFit = `${needSearch === null ? "" : `need${String(needSearch.need.id)}:${String(sheetPois.length)}`}`;
  const fitKey = `${String(tripId)}-${plan.data?.date ?? ""}-${String(candidates.length)}-${searchFit}`;
  const fitCoords: [number, number][] | undefined =
    needSearch !== null && sheetPois.length > 0
      ? sheetPois.map((p) => [p.lng, p.lat] as [number, number])
      : undefined;

  /**
   * Pin the place for the trip, then replan so it lands in today's candidates.
   * Not queued when offline: check-ins are the one write this app stores for
   * later — everything else fails visibly.
   */
  function setPin(poiId: number, mark: "pinned" | null): void {
    if (tripId === undefined) return;
    setPendingPoiId(poiId);
    markPoi.mutate(
      { tripId, poiId, mark },
      {
        onSuccess: () => {
          void utils.plan.needOptions.invalidate();
          setToast(mark === null ? "Un-pinned — replanning…" : "Pinned — replanning…");
          replan.mutate({ tripId });
        },
        onError: (e) => setToast(`Couldn't save: ${e.message}`),
        onSettled: () => setPendingPoiId(null),
      },
    );
  }

  const offline = plan.isError || needsQ.isError;

  function handleCheckIn(req: CheckInRequest): void {
    const clientId = newClientId();
    const occurredAt = new Date().toISOString();
    checkin.mutate(
      { ...req, clientId, occurredAt },
      {
        onSuccess: () => setToast("Check-in recorded"),
        onError: (err) => {
          if (err.data?.code === "BAD_REQUEST") {
            setToast(err.message);
            return;
          }
          enqueue({ clientId, occurredAt, ...req });
          // Optimistic patch so the strip reflects the reset immediately.
          utils.needs.list.setData(undefined, (prev) =>
            prev?.map((s) =>
              s.need.id === req.needId && req.kind === "service" && req.quantity === undefined
                ? { ...s, runway: s.need.capacity, runwayRatio: 1, urgency: "ok" as const }
                : s,
            ),
          );
          setToast("Offline — check-in saved, will sync");
        },
      },
    );
  }

  if (activeTrip.isLoading) return <p>Loading…</p>;
  if (!activeTrip.data) {
    return (
      <div style={{ padding: 24 }}>
        <h2>No active trip</h2>
        <p>Create one on the Trip page to start planning.</p>
      </div>
    );
  }

  return (
    <div className="vl-dash">
      <style>{VL_STYLES}</style>
      <div className="vl-layout">
        <div className="vl-map-pane">
          <DigestBanner digest={digest} userKey={_props.user.email} />
          <MapView
            routes={mapRoutes}
            highlightedId={highlightedId}
            pois={mapPois}
            position={
              activeTrip.data
                ? { lat: activeTrip.data.originLat, lng: activeTrip.data.originLng }
                : null
            }
            fitKey={fitKey}
            fitCoords={fitCoords}
            poiMinZoom={needSearch !== null ? 0 : 7}
            onSelectRoute={setHighlightedId}
            onStopClick={(_routeId, orderIndex) => {
              const c = candidates.find((x) => x.id === highlightedId);
              const stop = c?.stops.find((s) => s.orderIndex === orderIndex);
              if (stop?.poiId) setPoiDetailId(stop.poiId);
            }}
            onPoiClick={setPoiDetailId}
            onViewportChange={(bbox, zoom) => setViewport({ bbox, zoom })}
            heightStyle="100%"
          />
          <div className="vl-legend">
            {Object.entries(ROLE_LABELS).map(([tier, label]) => (
              <div key={tier}>
                <span className="vl-line" style={{ background: roleColor(tier) }} /> {label}
              </div>
            ))}
            <div>
              <span className="vl-line" style={{ background: PROJECTED_COLOR }} /> Projected future
            </div>
          </div>
          {poiDetailId !== null && poiDetail.data ? (
            <div className="vl-popover">
              <h4>{poiDetail.data.name}</h4>
              <div className="vl-meta">
                {poiDetail.data.category} · source: {poiDetail.data.source}
              </div>
              <div className="vl-actions">
                {poiDetail.data.url ? (
                  <a href={poiDetail.data.url} target="_blank" rel="noreferrer" className="vl-checkin-btn">
                    Open at source ↗
                  </a>
                ) : null}
                {tripId !== undefined ? (
                  <>
                    <button
                      className="vl-checkin-btn"
                      onClick={() => markPoi.mutate({ tripId, poiId: poiDetailId, mark: "pinned" })}
                    >
                      📌 Pin
                    </button>
                    <button
                      className="vl-checkin-btn"
                      onClick={() => markPoi.mutate({ tripId, poiId: poiDetailId, mark: "rejected" })}
                    >
                      Reject
                    </button>
                  </>
                ) : null}
                <button className="vl-checkin-btn" onClick={() => setPoiDetailId(null)}>
                  Close
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="vl-panel">
          {offline ? (
            <div className="vl-offline">Offline — showing last known state.</div>
          ) : null}
          {plan.data?.stale ? (
            <div className="vl-offline">
              Route computation unavailable — showing the last generated plan (stale).
            </div>
          ) : null}
          <NeedsStrip states={needStates} onNeedSearch={setNeedSearch} />
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <h3 style={{ margin: "8px 0" }}>Today's candidates</h3>
            <button
              className="vl-checkin-btn"
              disabled={replan.isPending || tripId === undefined}
              onClick={() => tripId !== undefined && replan.mutate({ tripId })}
            >
              {replan.isPending ? "Replanning…" : "Replan"}
            </button>
          </div>
          {plan.isLoading ? <p>Planning routes…</p> : null}
          {candidates.length === 0 && !plan.isLoading ? (
            <p>No candidates yet{plan.data?.message ? ` — ${plan.data.message}` : ""}.</p>
          ) : null}
          {candidates.map((c) => (
            <CandidateCard
              key={c.id}
              candidate={c}
              highlighted={c.id === highlightedId}
              onHighlight={() => setHighlightedId(c.id)}
              onSelect={() => selectMut.mutate({ candidateId: c.id })}
              onStopDone={(orderIndex) => completeStop.mutate({ candidateId: c.id, orderIndex })}
            />
          ))}
          <CheckInBar states={needStates} onCheckIn={handleCheckIn} compact />
        </div>
      </div>
      {needSearch !== null && tripId !== undefined ? (
        <NeedSearchSheet
          tripId={tripId}
          need={needSearch.need}
          candidateId={highlightedId}
          pendingPoiId={pendingPoiId}
          onPin={(poiId) => setPin(poiId, "pinned")}
          onUnpin={(poiId) => setPin(poiId, null)}
          onShowDetails={setPoiDetailId}
          onOptionsChange={setSheetPois}
          onClose={() => {
            setNeedSearch(null);
            setSheetPois([]);
          }}
        />
      ) : null}
      {toast ? <div className="vl-toast">{toast}</div> : null}
    </div>
  );
}
