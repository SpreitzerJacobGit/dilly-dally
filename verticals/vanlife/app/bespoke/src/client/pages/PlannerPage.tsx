import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { trpc } from "../trpc.js";
import type { PageUser } from "../index.js";
import { FINAL_TARGET_ID, type CandidateRouteView, type MapPoiView, type MapTargetView } from "../map/types.js";
import { haversineMiles } from "../../server/engine/geo.js";
import { type CandidateDetail } from "../components/CandidateList.js";
import { NeedsStrip, type NeedStateView } from "../components/NeedsStrip.js";
import { NeedSearchSheet } from "../components/NeedSearchSheet.js";
import { CheckInBar, type CheckInRequest } from "../components/CheckInBar.js";
import { FormModal } from "../components/FormModal.js";
import { ConfirmModal } from "../components/ConfirmModal.js";
import type { DigestView } from "../components/DigestBanner.js";
import type { TargetTreeNode, DropZone } from "../components/TargetTree.js";
import { enqueue, flushQueue, newClientId } from "../lib/checkinQueue.js";
import { readHiddenPoiCategories, writeHiddenPoiCategories } from "../lib/prefs.js";
import { ALL_CATEGORIES } from "../map/palette.js";
import { VL_STYLES } from "../styles.js";
import { PlannerMap } from "../planner/PlannerMap.js";
import { TripPicker } from "../planner/TripPicker.js";
import { TargetsPanel } from "../planner/TargetsPanel.js";
import { TodayPanel } from "../planner/TodayPanel.js";
import { TripStatsPanel } from "../planner/TripStatsPanel.js";
import { TripEditModal, type TripEditValues } from "../planner/TripEditModal.js";
import { usePlannerTrip } from "../planner/usePlannerTrip.js";
import { useTargetDraft } from "../planner/useTargetDraft.js";
import { flattenTargets, type TargetNode } from "../planner/types.js";

/**
 * The planning screen: one map, one Targets list, one trip at a time.
 *
 * This replaces three screens that all read the same rows — a map that drew no
 * Targets, a Target editor that drew no routes, and a table of both with no map
 * at all. The map is constant across the three panel tabs, so switching tabs
 * never costs the spatial context.
 */

type Tab = "targets" | "today" | "trip";

interface Bbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

function parseLine(geometry: string | null): [number, number][] {
  if (!geometry) return [];
  try {
    const parsed = JSON.parse(geometry) as { coordinates?: [number, number][] };
    return parsed.coordinates ?? [];
  } catch {
    return [];
  }
}

export function PlannerPage(props: { user: PageUser }): JSX.Element {
  const utils = trpc.useUtils();
  const picker = usePlannerTrip();
  const tripId = picker.tripId;
  const enabled = tripId !== null;

  const [tab, setTab] = useState<Tab | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [highlightedId, setHighlightedId] = useState<number | null>(null);
  const [viewport, setViewport] = useState<{ bbox: Bbox; zoom: number } | null>(null);
  const [poiDetailId, setPoiDetailId] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fitKey, setFitKey] = useState("init");
  const [fitTo, setFitTo] = useState<[number, number][] | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  // Route-through-needs: the need whose stop search is open, the places it
  // found (so the map can show them), and the row whose pin is in flight.
  const [needSearch, setNeedSearch] = useState<NeedStateView | null>(null);
  const [sheetPois, setSheetPois] = useState<MapPoiView[]>([]);
  const [hiddenCategories, setHiddenCategories] = useState<Set<string>>(readHiddenPoiCategories);
  const [pendingPoiId, setPendingPoiId] = useState<number | null>(null);
  const [modal, setModal] = useState<
    | null
    | { kind: "trip-create" }
    | { kind: "trip-edit" }
    | { kind: "set-position" }
    | { kind: "confirm-delete-trip" }
    | { kind: "confirm-delete-target"; id: number; name: string; kids: number }
  >(null);

  const draft = useTargetDraft();

  const tripQ = trpc.trips.get.useQuery({ id: tripId ?? 0 }, { enabled, staleTime: 15_000 });
  const planQ = trpc.plan.today.useQuery(
    { tripId: tripId ?? 0 },
    { enabled, staleTime: 60_000, retry: 2 },
  );
  const needsQ = trpc.needs.list.useQuery(undefined, { staleTime: 60_000, retry: 2 });
  const digestQ = trpc.digest.today.useQuery({ tripId: tripId ?? 0 }, { enabled });
  const digestHistoryQ = trpc.digest.history.useQuery({ tripId: tripId ?? 0, limit: 7 }, { enabled: enabled && tab === "trip" });
  // A corridor scan of up to 300 places; only the bookkeeping tab shows it.
  const fanoutQ = trpc.plan.fanout.useQuery({ tripId: tripId ?? 0 }, { enabled: enabled && tab === "trip" });
  const previewQ = trpc.digest.preview.useQuery({ tripId: tripId ?? 0 }, { enabled: enabled && showPreview });

  const targets: TargetNode[] = (tripQ.data?.targets ?? []) as unknown as TargetNode[];
  const editable = targets.filter((t) => !t.final);
  const finalTarget = targets.find((t) => t.final) ?? null;
  const flat = useMemo(() => flattenTargets(targets), [targets]);
  const selected = flat.find((t) => t.id === selectedId) ?? null;

  const suggestionsQ = trpc.trips.targetSuggestions.useQuery(
    { targetId: selectedId ?? 0 },
    { enabled: selectedId !== null && selectedId !== FINAL_TARGET_ID && (selected?.radiusMiles ?? 0) > 0 },
  );

  // Places in view, unless a specific area's suggestions are on screen.
  const showingSuggestions =
    tab === "targets" && selected !== null && !selected.final && selected.radiusMiles > 0;
  const visibleCategories = useMemo(
    () => ALL_CATEGORIES.filter((c) => !hiddenCategories.has(c)),
    [hiddenCategories],
  );
  // The categories go to the server as well as to the layer filter. The scan is
  // capped at 300 rows by popularity, so narrowing it is what makes a rare
  // category — a dump station, say — actually appear once it is the only thing
  // asked for, instead of being crowded out by campgrounds and never drawn.
  // Undefined while nothing is hidden, so the unfiltered query keeps one cache
  // entry rather than acquiring a second identical one.
  //
  // This names the visible categories where the layer filter names the hidden
  // ones, so a row whose category is outside the palette entirely would be
  // fetched but not drawn. The column is a closed enum in data-model.yaml, so
  // there is no such row to worry about.
  const poisQ = trpc.pois.byBbox.useQuery(
    {
      bbox: viewport?.bbox ?? { south: 0, west: 0, north: 0, east: 0 },
      limit: 300,
      categories: hiddenCategories.size === 0 ? undefined : visibleCategories,
    },
    {
      // An empty category list would reach the server as "no filter" and bring
      // back everything, so nothing-visible does not ask.
      enabled:
        viewport !== null &&
        viewport.zoom >= 7 &&
        !showingSuggestions &&
        visibleCategories.length > 0,
      placeholderData: (prev) => prev,
    },
  );
  const poiDetailQ = trpc.pois.byId.useQuery({ id: poiDetailId ?? 0 }, { enabled: poiDetailId !== null });

  /* ── mutations ─────────────────────────────────────────────────────────── */

  const invalidateTargets = (): void => {
    void utils.trips.get.invalidate();
    void utils.plan.today.invalidate();
  };
  const onErr = (e: { message: string }): void => setError(e.message);

  const addMut = trpc.trips.addTarget.useMutation({
    onSuccess: () => {
      draft.cancel();
      setError(null);
      invalidateTargets();
    },
    onError: onErr,
  });
  const updateMut = trpc.trips.updateTarget.useMutation({ onSuccess: invalidateTargets, onError: onErr });
  const removeMut = trpc.trips.removeTarget.useMutation({
    onSuccess: () => {
      setSelectedId(null);
      invalidateTargets();
    },
    onError: onErr,
  });
  const promoteMut = trpc.trips.promotePoiToTarget.useMutation({ onSuccess: invalidateTargets, onError: onErr });
  const pinMut = trpc.trips.pinTargetPoint.useMutation({ onSuccess: invalidateTargets, onError: onErr });
  const markMut = trpc.trips.markTarget.useMutation({ onSuccess: invalidateTargets, onError: onErr });
  const reparentMut = trpc.trips.reparentTarget.useMutation({
    onSuccess: () => {
      setError(null);
      invalidateTargets();
    },
    onError: onErr,
  });
  const reorderMut = trpc.trips.reorderTargets.useMutation({ onSuccess: invalidateTargets, onError: onErr });

  const createTripMut = trpc.trips.create.useMutation({
    onSuccess: (r) => {
      setModal(null);
      setError(null);
      picker.adopt(r.id);
      void utils.trips.invalidate();
      setToast("Trip created");
    },
    onError: onErr,
  });
  const [selectionStale, setSelectionStale] = useState(false);
  const updateTripMut = trpc.trips.update.useMutation({
    onSuccess: (r) => {
      setModal(null);
      setError(null);
      setSelectionStale(r.selectionStale);
      void utils.trips.invalidate();
      void utils.plan.today.invalidate();
      setToast(
        r.baselineReset
          ? "Saved — the baseline resets, so the budget is recomputed on the next plan."
          : "Saved",
      );
    },
    onError: onErr,
  });
  const deleteTripMut = trpc.trips.delete.useMutation({
    onSuccess: () => {
      setModal(null);
      void utils.trips.invalidate();
      setToast("Trip deleted");
    },
    onError: onErr,
  });
  const setStatusMut = trpc.trips.setStatus.useMutation({
    onSuccess: () => {
      void utils.trips.invalidate();
      void utils.needs.list.invalidate();
    },
    onError: onErr,
  });
  const setPositionMut = trpc.trips.setPosition.useMutation({
    onSuccess: () => {
      setModal(null);
      void utils.trips.invalidate();
      setToast("Position updated — next plans start here");
    },
    onError: onErr,
  });

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
    onSuccess: () => {
      void utils.plan.fanout.invalidate();
      setToast("Saved — takes effect on the next replan");
    },
  });
  const replan = trpc.plan.replan.useMutation({
    onSuccess: () => void utils.plan.today.invalidate(),
    onError: (e) => setToast(`Replan unavailable: ${e.message}`),
  });
  const sendDigest = trpc.digest.sendNow.useMutation({
    onSuccess: (r) => {
      const p = r.push;
      const detail = p.ok ? "sent" : "skipped" in p && p.skipped ? `skipped (${p.skipped})` : "error" in p ? p.error : "failed";
      setToast(p.ok ? "Digest sent" : `Digest saved; push ${detail}`);
    },
  });

  /* ── effects ───────────────────────────────────────────────────────────── */

  // Today is only meaningful for the trip the van is on; anything else opens
  // on the list you came to edit.
  useEffect(() => {
    if (tab !== null || picker.isLoading || tripId === null) return;
    setTab(picker.activeTripId === tripId ? "today" : "targets");
  }, [tab, picker.isLoading, picker.activeTripId, tripId]);

  // A new trip is a new everything.
  useEffect(() => {
    setSelectedId(null);
    setHighlightedId(null);
    setSelectionStale(false);
  }, [tripId]);

  // Frame the trip once its Targets have actually arrived. Fitting on the trip
  // id alone runs against an empty map and then never re-runs, which leaves the
  // final Target sitting off the edge of the view.
  const framedTripRef = useRef<number | null>(null);
  useEffect(() => {
    if (tripId === null || tripQ.data === undefined || framedTripRef.current === tripId) return;
    framedTripRef.current = tripId;
    setFitTo(null);
    setFitKey(`trip-${String(tripId)}-loaded`);
  }, [tripId, tripQ.data]);

  useEffect(() => {
    if (picker.recovered) {
      setToast(picker.recovered);
      picker.clearRecovered();
    }
  }, [picker]);

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
    return (planQ.data?.candidates ?? []).map((c) => ({
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
  }, [planQ.data]);

  useEffect(() => {
    if (highlightedId === null && candidates.length > 0) {
      const sel = candidates.find((c) => c.selected);
      setHighlightedId((sel ?? candidates[0]!).id);
    }
  }, [candidates, highlightedId]);

  /* ── derived view data ─────────────────────────────────────────────────── */

  const mapTargets: MapTargetView[] = flat.map((t) => ({
    id: t.id,
    name: t.name,
    center: t.center,
    radiusMiles: t.radiusMiles,
    ring: t.ring,
    depth: t.depth,
    state: t.status === "visited" || t.status === "skipped" ? t.status : "pending",
    resolved: t.resolved?.point ?? null,
    selected: t.id === selectedId,
    final: t.final,
    ordinal: t.ordinal,
  }));

  const suggestionPois: MapPoiView[] = (suggestionsQ.data?.suggestions ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    lat: p.lat,
    lng: p.lng,
  }));
  const bboxPois: MapPoiView[] = (poisQ.data ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    lat: p.lat,
    lng: p.lng,
  }));

  /**
   * Pin the place for the trip, then replan so it lands in today's candidates.
   * Not queued when offline: check-ins are the one write this app stores for
   * later — everything else fails visibly.
   */
  function setPin(poiId: number, mark: "pinned" | null): void {
    if (tripId === null) return;
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

  /** Legend toggles. The set is replaced rather than mutated so the map sees a change. */
  function toggleCategory(category: string): void {
    const next = new Set(hiddenCategories);
    if (!next.delete(category)) next.add(category);
    writeHiddenPoiCategories(next);
    setHiddenCategories(next);
  }

  function setAllCategories(visible: boolean): void {
    const next = visible ? new Set<string>() : new Set(ALL_CATEGORIES);
    writeHiddenPoiCategories(next);
    setHiddenCategories(next);
  }

  const mapRoutes: CandidateRouteView[] = tab === "today" ? candidates : [];
  const needStates = (needsQ.data ?? []) as NeedStateView[];

  // While a need's stop search is open the map shows exactly those places and
  // says so — the catalog underneath would bury a twenty-place answer, and the
  // dot layer's zoom floor is meant for hundreds, not twenty.
  const searchOpen = needSearch !== null;
  const searchPoiCoords: [number, number][] = sheetPois.map((p) => [p.lng, p.lat]);
  const digest = (digestQ.data ?? null) as DigestView | null;

  const originMovedOn =
    tripQ.data !== undefined &&
    (tripQ.data.position.lat !== tripQ.data.originLat || tripQ.data.position.lng !== tripQ.data.originLng);

  /* ── handlers ──────────────────────────────────────────────────────────── */

  const selectTarget = (id: number): void => {
    setSelectedId(id);
    const t = flat.find((x) => x.id === id);
    if (!t) return;
    setFitTo(t.ring && t.ring.length > 3 ? t.ring : [[t.center.lng, t.center.lat]]);
    setFitKey(`target-${String(id)}`);
  };

  const siblingsOf = (parentId: number | null): TargetNode[] =>
    parentId === null ? editable : (flat.find((n) => n.id === parentId)?.children ?? []);

  const handleDrop = (dragId: number, targetId: number, zone: DropZone): void => {
    const target = flat.find((t) => t.id === targetId);
    if (!target || dragId === targetId) return;
    if (zone === "into") {
      reparentMut.mutate({ id: dragId, parentId: targetId, orderIndex: target.children.length });
      return;
    }
    const sibs = siblingsOf(target.parentId).filter((s) => s.id !== dragId);
    const at = sibs.findIndex((s) => s.id === targetId);
    reparentMut.mutate({
      id: dragId,
      parentId: target.parentId,
      orderIndex: zone === "before" ? Math.max(0, at) : at + 1,
    });
  };

  const moveTarget = (node: TargetTreeNode, delta: number): void => {
    if (tripId === null) return;
    const t = flat.find((x) => x.id === node.id);
    if (!t) return;
    const ids = siblingsOf(t.parentId).map((s) => s.id);
    const i = ids.indexOf(t.id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    const next = [...ids];
    [next[i], next[j]] = [next[j]!, next[i]!];
    reorderMut.mutate({ tripId, parentId: t.parentId, orderedIds: next });
  };

  const commitDraft = (): void => {
    if (!draft.draft || tripId === null) return;
    addMut.mutate({
      tripId,
      name: draft.draft.name.trim() || "Unnamed area",
      center: draft.draft.center,
      radiusMiles: draft.draft.radiusMiles,
      parentId: draft.placing?.parentId ?? null,
      kind: "custom",
    });
  };

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

  /* ── early returns ─────────────────────────────────────────────────────── */

  if (picker.isLoading) return <p>Loading…</p>;

  if (tripId === null) {
    return (
      <div style={{ padding: 24 }}>
        <style>{VL_STYLES}</style>
        <h2>No trips yet</h2>
        <p>A trip is an Origin and a list of Targets. The last Target is where you end up.</p>
        <button className="vl-checkin-btn" onClick={() => setModal({ kind: "trip-create" })}>
          Create your first trip
        </button>
        {modal?.kind === "trip-create" ? (
          <TripEditModal
            mode="create"
            initial={null}
            hasBaseline={false}
            busy={createTripMut.isPending}
            error={error}
            onSubmit={(v) =>
              createTripMut.mutate({
                name: v.name,
                originName: v.originName,
                origin: v.origin,
                destName: v.destName,
                dest: v.dest,
                dailyDriveHours: v.dailyDriveHours,
                deviationBudgetRatio: 2,
              })
            }
            onClose={() => setModal(null)}
          />
        ) : null}
        {toast ? <div className="vl-toast">{toast}</div> : null}
      </div>
    );
  }

  /* ── overlays ──────────────────────────────────────────────────────────── */

  const poiDetail =
    poiDetailId !== null && poiDetailQ.data ? (
      <div className="vl-popover">
        <h4>{poiDetailQ.data.name}</h4>
        <div className="vl-meta">
          {poiDetailQ.data.category} · source: {poiDetailQ.data.source}
        </div>
        <div className="vl-actions">
          {poiDetailQ.data.url ? (
            <a href={poiDetailQ.data.url} target="_blank" rel="noreferrer" className="vl-checkin-btn">
              Open at source ↗
            </a>
          ) : null}
          <button className="vl-checkin-btn" onClick={() => markPoi.mutate({ tripId, poiId: poiDetailId, mark: "pinned" })}>
            📌 Pin
          </button>
          <button className="vl-checkin-btn" onClick={() => markPoi.mutate({ tripId, poiId: poiDetailId, mark: "rejected" })}>
            Reject
          </button>
          {/* Only offered when the place is actually inside the selected area —
              otherwise the server would reject it and the button would be a lie. */}
          {selected && !selected.final && selected.radiusMiles > 0 &&
          haversineMiles(selected.center, { lat: poiDetailQ.data.lat, lng: poiDetailQ.data.lng }) <=
            selected.radiusMiles ? (
            <>
              <button
                className="vl-checkin-btn"
                disabled={selected.depth >= 2}
                onClick={() => promoteMut.mutate({ parentId: selected.id, poiId: poiDetailId })}
              >
                Narrow to this
              </button>
              <button
                className="vl-checkin-btn"
                onClick={() =>
                  pinMut.mutate({
                    id: selected.id,
                    point: { lat: poiDetailQ.data!.lat, lng: poiDetailQ.data!.lng },
                    poiId: poiDetailId,
                  })
                }
              >
                📌 Route through exactly this
              </button>
            </>
          ) : null}
          <button className="vl-checkin-btn" onClick={() => setPoiDetailId(null)}>
            Close
          </button>
        </div>
      </div>
    ) : null;

  const tripValues: TripEditValues | null = tripQ.data
    ? {
        name: tripQ.data.name,
        originName: tripQ.data.originName,
        origin: { lat: tripQ.data.originLat, lng: tripQ.data.originLng },
        destName: tripQ.data.destName,
        dest: { lat: tripQ.data.destLat, lng: tripQ.data.destLng },
        dailyDriveHours: tripQ.data.dailyDriveHours,
      }
    : null;

  const modals: JSX.Element | null =
    modal?.kind === "trip-create" || modal?.kind === "trip-edit" ? (
      <TripEditModal
        mode={modal.kind === "trip-create" ? "create" : "edit"}
        initial={modal.kind === "trip-edit" ? tripValues : null}
        hasBaseline={tripQ.data?.directDurationMinutes != null}
        busy={createTripMut.isPending || updateTripMut.isPending}
        error={error}
        onSubmit={(v, moved) => {
          if (modal.kind === "trip-create") {
            createTripMut.mutate({
              name: v.name,
              originName: v.originName,
              origin: v.origin,
              destName: v.destName,
              dest: v.dest,
              dailyDriveHours: v.dailyDriveHours,
              deviationBudgetRatio: 2,
            });
            return;
          }
          updateTripMut.mutate({
            id: tripId,
            name: v.name,
            originName: v.originName,
            destName: v.destName,
            dailyDriveHours: v.dailyDriveHours,
            // Only sent when actually moved, so a rename never resets the baseline.
            ...(moved.origin ? { origin: v.origin } : {}),
            ...(moved.dest ? { dest: v.dest } : {}),
          });
        }}
        onClose={() => {
          setModal(null);
          setError(null);
        }}
      />
    ) : modal?.kind === "set-position" ? (
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
          setPositionMut.mutate({
            tripId,
            lat: Number(v.lat),
            lng: Number(v.lng),
            milesSinceLast: Number(v.miles),
          })
        }
        onClose={() => setModal(null)}
      />
    ) : modal?.kind === "confirm-delete-trip" ? (
      <ConfirmModal
        title="Delete this trip?"
        body={`"${tripQ.data?.name ?? "This trip"}" and its plans, marks, digests and recorded progress are removed. This cannot be undone.`}
        confirmLabel="Delete trip"
        destructive
        onConfirm={() => deleteTripMut.mutate({ id: tripId })}
        onClose={() => setModal(null)}
      />
    ) : modal?.kind === "confirm-delete-target" ? (
      <ConfirmModal
        title={`Delete "${modal.name}"?`}
        body={
          modal.kids > 0
            ? `Its ${String(modal.kids)} narrowing(s) go with it, and the route stops passing through here.`
            : "The route stops passing through here."
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => removeMut.mutate({ id: modal.id })}
        onClose={() => setModal(null)}
      />
    ) : null;

  /* ── render ────────────────────────────────────────────────────────────── */

  return (
    <div className="vl-dash">
      <style>{VL_STYLES}</style>
      <div className="vl-layout">
        <PlannerMap
          routes={mapRoutes}
          highlightedId={highlightedId}
          pois={searchOpen ? sheetPois : showingSuggestions ? suggestionPois : bboxPois}
          poiSourceLabel={
            searchOpen
              ? `Places that can service ${needSearch.need.title}`
              : showingSuggestions
                ? `Places inside ${selected?.name ?? "the selected Target"}`
                : // An empty map because of the filter must say so. Silence here
                  // reads as "there is nothing out here", which is the one thing
                  // this app is not allowed to imply.
                  visibleCategories.length === 0
                  ? "All place types hidden"
                  : hiddenCategories.size > 0
                    ? `Places in view — ${String(visibleCategories.length)} of ${String(ALL_CATEGORIES.length)} types`
                    : "Places in view"
          }
          poiMinZoom={searchOpen ? 0 : 7}
          hiddenCategories={hiddenCategories}
          poisFilterable={!searchOpen && !showingSuggestions}
          onToggleCategory={toggleCategory}
          onSetAllCategories={setAllCategories}
          position={tripQ.data?.position ?? null}
          origin={
            tripQ.data
              ? { name: tripQ.data.originName, lat: tripQ.data.originLat, lng: tripQ.data.originLng }
              : null
          }
          targets={mapTargets}
          draftTarget={draft.previewFor(flat)}
          fitKey={searchOpen ? `need-${String(needSearch.need.id)}-${String(sheetPois.length)}` : fitKey}
          fitTo={searchOpen && searchPoiCoords.length > 0 ? searchPoiCoords : fitTo}
          placingLabel={
            draft.placing ? (draft.placing.parentId === null ? "New Target" : "Narrowing") : null
          }
          digest={digest}
          userKey={props.user.email}
          detail={poiDetail}
          onSelectRoute={setHighlightedId}
          onStopClick={(_routeId, orderIndex) => {
            const c = candidates.find((x) => x.id === highlightedId);
            const stop = c?.stops.find((s) => s.orderIndex === orderIndex);
            if (stop?.poiId) setPoiDetailId(stop.poiId);
          }}
          onPoiClick={setPoiDetailId}
          onTargetClick={selectTarget}
          onMapClick={draft.placeAt}
          onTargetCenterDrag={(id, center, done) =>
            draft.onCenterDrag(id, center, done, flat, (v) => updateMut.mutate(v))
          }
          onTargetRadiusDrag={(id, handle, done) =>
            draft.onRadiusDrag(id, handle, done, flat, (v) => updateMut.mutate(v))
          }
          onViewportChange={(bbox, zoom) => setViewport({ bbox, zoom })}
        />

        <div className="vl-panel">
          <TripPicker
            trips={picker.trips}
            tripId={tripId}
            activeTripId={picker.activeTripId}
            onSelect={picker.select}
            onNew={() => setModal({ kind: "trip-create" })}
            onEdit={() => setModal({ kind: "trip-edit" })}
            onMakeActive={() => setStatusMut.mutate({ id: tripId, status: "active" })}
            onDelete={() => setModal({ kind: "confirm-delete-trip" })}
          />

          {/* Needs are the van's, not the trip's. Viewing a trip the van is not
              on must not imply the tanks follow it. */}
          {picker.viewingNonActive ? (
            <div className="vl-offline">
              Planning “{tripQ.data?.name ?? "this trip"}” — needs, check-ins and the morning digest
              still follow the trip you’re on, “{picker.activeTripName ?? "—"}”.{" "}
              <button
                className="vl-checkin-btn"
                onClick={() => setStatusMut.mutate({ id: tripId, status: "active" })}
              >
                Make this the active trip
              </button>
            </div>
          ) : null}
          {picker.activeTripId === null ? (
            <div className="vl-offline">
              No trip is active — needs runway counts elapsed time only, with no miles.
            </div>
          ) : null}

          <h4 style={{ margin: "8px 0 4px", fontSize: ".85rem", color: "#555" }}>
            Needs{picker.activeTripName ? ` — ${picker.activeTripName}` : ""}
          </h4>
          <NeedsStrip states={needStates} onNeedSearch={setNeedSearch} />

          <div className="vl-tabs" role="tablist">
            {(["targets", "today", "trip"] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                className={`vl-tab${tab === t ? " vl-tab-active" : ""}`}
                onClick={() => setTab(t)}
              >
                {t === "targets" ? "Targets" : t === "today" ? "Today" : "Trip"}
              </button>
            ))}
          </div>

          {tab === "targets" ? (
            <TargetsPanel
              originName={tripQ.data?.originName ?? "—"}
              originMovedOn={originMovedOn}
              targets={editable}
              finalTarget={finalTarget}
              selectedId={selectedId}
              selected={selected}
              suggestions={suggestionsQ.data?.suggestions ?? []}
              suggestionsLoading={suggestionsQ.isLoading}
              placing={draft.placing}
              draft={draft.draft}
              addBusy={addMut.isPending}
              error={error}
              onSelect={selectTarget}
              onEditTrip={() => setModal({ kind: "trip-edit" })}
              onDrop={handleDrop}
              onDropRoot={(dragId) =>
                reparentMut.mutate({ id: dragId, parentId: null, orderIndex: editable.length })
              }
              onMove={moveTarget}
              onNarrow={(id) => draft.startPlacing(id)}
              onToggleSkip={(n) =>
                markMut.mutate({ id: n.id, status: n.status === "pending" ? "skipped" : "pending" })
              }
              onDelete={(n) =>
                setModal({
                  kind: "confirm-delete-target",
                  id: n.id,
                  name: n.name,
                  kids: flat.find((x) => x.id === n.id)?.children.length ?? 0,
                })
              }
              onStartPlacing={() => draft.startPlacing(null)}
              onCancelPlacing={draft.cancel}
              onDraftChange={draft.setDraft}
              onCommitDraft={commitDraft}
              onRename={(id, name) => updateMut.mutate({ id, name })}
              onRadius={(id, radiusMiles) => updateMut.mutate({ id, radiusMiles })}
              onArriveBy={(id, arriveBy) => updateMut.mutate({ id, arriveBy })}
              onClearPin={(id) => pinMut.mutate({ id, point: null, poiId: null })}
              onNarrowToPlace={(parentId, poiId) => promoteMut.mutate({ parentId, poiId })}
              onPinPlace={(id, p) => pinMut.mutate({ id, point: { lat: p.lat, lng: p.lng }, poiId: p.id })}
            />
          ) : null}

          {tab === "today" ? (
            <TodayPanel
              candidates={candidates}
              highlightedId={highlightedId}
              loading={planQ.isLoading}
              message={planQ.data?.message ?? null}
              stale={planQ.data?.stale ?? false}
              offline={planQ.isError || needsQ.isError}
              replanPending={replan.isPending}
              nonActiveNote={
                picker.viewingNonActive
                  ? `Plans for a trip the van isn’t on. The morning digest is generated for “${picker.activeTripName ?? "—"}”.`
                  : null
              }
              selectionStale={selectionStale}
              onReplan={() => replan.mutate({ tripId })}
              onHighlight={setHighlightedId}
              onSelect={(candidateId) => selectMut.mutate({ candidateId })}
              onStopDone={(candidateId, orderIndex) => completeStop.mutate({ candidateId, orderIndex })}
            />
          ) : null}

          {tab === "trip" && tripQ.data ? (
            <TripStatsPanel
              status={tripQ.data.status}
              destName={tripQ.data.destName}
              deviationBudgetRatio={tripQ.data.deviationBudgetRatio}
              usage={tripQ.data.usage}
              places={fanoutQ.data?.pois ?? []}
              placesLoading={fanoutQ.isLoading}
              marks={fanoutQ.data?.marks ?? []}
              digests={digestHistoryQ.data ?? []}
              previewOpen={showPreview}
              preview={previewQ.data ?? null}
              onComplete={() => setStatusMut.mutate({ id: tripId, status: "completed" })}
              onSetPosition={() => setModal({ kind: "set-position" })}
              onSendDigest={() => sendDigest.mutate({ tripId })}
              onTogglePreview={() => setShowPreview(!showPreview)}
              onMarkPoi={(poiId, mark) => markPoi.mutate({ tripId, poiId, mark })}
            />
          ) : null}

          <CheckInBar states={needStates} onCheckIn={handleCheckIn} compact />
        </div>
      </div>
      {modals}
      {needSearch !== null && tripId !== null ? (
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
