import { useEffect, useMemo, useState, type JSX } from "react";
import { trpc } from "../trpc.js";
import type { PageUser } from "../index.js";
import { MapView } from "../map/MapView.js";
import { DRAFT_TARGET_ID, type MapTargetView, type MapPoiView } from "../map/types.js";
import { ringFor } from "../lib/anchorRing.js";
import { geocode, type GeocodeHit } from "../lib/geocode.js";
import { haversineMiles } from "../../server/engine/geo.js";
import { AnchorTree, type AnchorTreeNode, type DropZone } from "../components/AnchorTree.js";
import { VL_STYLES } from "../styles.js";

/**
 * Anchor authoring: the map is the primary control, the tree on the right is
 * the record of intent. Broad regions live at the top level and narrowings hang
 * beneath them, so drilling down never destroys the broader choice.
 */

const RADIUS_STOPS = [0, 5, 15, 30, 60, 110, 180, 250, 400];

/** Radius slider works in stop indices so the low end stays usable. */
function nearestStop(miles: number): number {
  let best = 0;
  for (let i = 1; i < RADIUS_STOPS.length; i++) {
    if (Math.abs(RADIUS_STOPS[i]! - miles) < Math.abs(RADIUS_STOPS[best]! - miles)) best = i;
  }
  return best;
}

interface AnchorNodeView {
  id: number;
  parentId: number | null;
  name: string;
  kind: string;
  center: { lat: number; lng: number };
  radiusMiles: number;
  depth: number;
  status: string;
  arriveBy: string | null;
  ring: [number, number][] | null;
  resolved: {
    point: { lat: number; lng: number };
    via: string;
    poiId: number | null;
    poiName: string | null;
    detourMinutes: number;
  } | null;
  pinned: { lat: number; lng: number } | null;
  pacing: { etaDays: number; etaDate: string; horizon: string; behind: boolean } | null;
  children: AnchorNodeView[];
}

function flatten(nodes: AnchorNodeView[]): AnchorNodeView[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

/** Plain-language account of where the route actually goes and what it costs. */
function resolutionLine(a: AnchorNodeView): string {
  if (a.radiusMiles === 0) return "exact point";
  if (!a.resolved) return "narrowed — routing through the anchor below";
  const cost = a.resolved.detourMinutes > 0 ? ` (+${String(a.resolved.detourMinutes)} min)` : "";
  switch (a.resolved.via) {
    case "poi":
      return `routing via ${a.resolved.poiName ?? "a place"}${cost}`;
    case "pinned":
      return `routing via your pinned spot${cost}`;
    case "geometric":
      return `no known place inside — routing through the nearest point${cost}`;
    default:
      return `routing through${cost}`;
  }
}

export function AnchorsPage(_props: { user: PageUser }): JSX.Element {
  const utils = trpc.useUtils();
  const activeTrip = trpc.trips.active.useQuery();
  const tripId = activeTrip.data?.id;
  const tripQ = trpc.trips.get.useQuery({ id: tripId ?? 0 }, { enabled: tripId !== undefined });

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [placing, setPlacing] = useState<null | { parentId: number | null }>(null);
  const [draft, setDraft] = useState<null | { name: string; center: { lat: number; lng: number }; radiusMiles: number }>(
    null,
  );
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<GeocodeHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fitKey, setFitKey] = useState("init");

  // The final Target is the trip's destination, not an editable region.
  const anchors = ((tripQ.data?.targets ?? []).filter((t) => !t.final)) as unknown as AnchorNodeView[];
  const flat = useMemo(() => flatten(anchors), [anchors]);
  const selected = flat.find((a) => a.id === selectedId) ?? null;

  const suggestionsQ = trpc.trips.targetSuggestions.useQuery(
    { targetId: selectedId ?? 0 },
    { enabled: selectedId !== null && (selected?.radiusMiles ?? 0) > 0 },
  );

  const invalidate = (): void => {
    void utils.trips.get.invalidate();
    void utils.plan.today.invalidate();
  };
  const onErr = (e: { message: string }): void => setError(e.message);

  const addMut = trpc.trips.addTarget.useMutation({
    onSuccess: () => {
      setDraft(null);
      setPlacing(null);
      setError(null);
      invalidate();
    },
    onError: onErr,
  });
  const updateMut = trpc.trips.updateTarget.useMutation({ onSuccess: invalidate, onError: onErr });
  const removeMut = trpc.trips.removeTarget.useMutation({
    onSuccess: () => {
      setSelectedId(null);
      invalidate();
    },
    onError: onErr,
  });
  const promoteMut = trpc.trips.promotePoiToTarget.useMutation({ onSuccess: invalidate, onError: onErr });
  const pinMut = trpc.trips.pinTargetPoint.useMutation({ onSuccess: invalidate, onError: onErr });
  const markMut = trpc.trips.markTarget.useMutation({ onSuccess: invalidate, onError: onErr });
  const reparentMut = trpc.trips.reparentTarget.useMutation({
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: onErr,
  });
  const reorderMut = trpc.trips.reorderTargets.useMutation({ onSuccess: invalidate, onError: onErr });

  // Debounced place-name lookup; geocode() also throttles globally.
  useEffect(() => {
    if (search.trim().length < 3) {
      setHits([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      void geocode(search).then((r) => {
        setHits(r);
        setSearching(false);
      });
    }, 400);
    return () => clearTimeout(t);
  }, [search]);

  /**
   * Live geometry while a map handle is being dragged. Held locally and
   * rendered as the draft ring, so the circle tracks the pointer at frame rate
   * and only the final position is written.
   */
  const [dragging, setDragging] = useState<null | { id: number; center: { lat: number; lng: number }; radiusMiles: number }>(
    null,
  );

  const onCenterDrag = (id: number, center: { lat: number; lng: number }, done: boolean): void => {
    const a = flat.find((x) => x.id === id);
    if (!a) return;
    if (!done) {
      setDragging({ id, center, radiusMiles: a.radiusMiles });
      return;
    }
    setDragging(null);
    updateMut.mutate({ id, center });
  };

  const onRadiusDrag = (id: number, handle: { lat: number; lng: number }, done: boolean): void => {
    const a = flat.find((x) => x.id === id);
    if (!a) return;
    // The handle reports a position; the radius is how far it now sits from
    // the centre. Rounded to whole miles so the committed value is legible.
    const radiusMiles = Math.max(1, Math.round(haversineMiles(a.center, handle)));
    if (!done) {
      setDragging({ id, center: a.center, radiusMiles });
      return;
    }
    setDragging(null);
    updateMut.mutate({ id, radiusMiles });
  };

  const mapTargets: MapTargetView[] = flat.map((a) => ({
    id: a.id,
    name: a.name,
    center: a.center,
    radiusMiles: a.radiusMiles,
    ring: a.ring,
    depth: a.depth,
    state: (a.status === "visited" || a.status === "skipped" ? a.status : "pending"),
    resolved: a.resolved?.point ?? null,
    selected: a.id === selectedId,
    final: false,
    ordinal: null,
  }));

  // A live drag preview wins over the placement draft — only one can be active.
  const draftAnchor: MapTargetView | null = dragging
    ? {
        id: DRAFT_TARGET_ID,
        name: flat.find((a) => a.id === dragging.id)?.name ?? "",
        center: dragging.center,
        radiusMiles: dragging.radiusMiles,
        ring: ringFor(dragging.center, dragging.radiusMiles),
        depth: flat.find((a) => a.id === dragging.id)?.depth ?? 0,
        state: "pending",
        resolved: null,
        selected: true,
        final: false,
        ordinal: null,
      }
    : draft
      ? {
          id: DRAFT_TARGET_ID,
          name: draft.name,
          center: draft.center,
          radiusMiles: draft.radiusMiles,
          ring: ringFor(draft.center, draft.radiusMiles),
          depth: placing?.parentId === null ? 0 : 1,
          state: "pending",
          resolved: null,
          selected: true,
          final: false,
          ordinal: null,
        }
      : null;

  const suggestionPois: MapPoiView[] = (suggestionsQ.data?.suggestions ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    lat: p.lat,
    lng: p.lng,
  }));

  const startPlacing = (parentId: number | null): void => {
    setPlacing({ parentId });
    setDraft(null);
    setError(null);
    setSearch("");
    setHits([]);
  };

  const commitDraft = (): void => {
    if (!draft || tripId === undefined) return;
    addMut.mutate({
      tripId,
      name: draft.name.trim() || "Unnamed area",
      center: draft.center,
      radiusMiles: draft.radiusMiles,
      parentId: placing?.parentId ?? null,
      kind: "custom",
    });
  };

  const move = (a: AnchorNodeView, delta: number): void => {
    if (tripId === undefined) return;
    const siblings = (a.parentId === null ? anchors : flat.find((n) => n.id === a.parentId)?.children ?? []).map(
      (s) => s.id,
    );
    const i = siblings.indexOf(a.id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= siblings.length) return;
    const next = [...siblings];
    [next[i], next[j]] = [next[j]!, next[i]!];
    reorderMut.mutate({ tripId, parentId: a.parentId, orderedIds: next });
  };

  /** Map the domain tree onto the presentational tree the DnD control wants. */
  const toTreeNode = (a: AnchorNodeView): AnchorTreeNode => ({
    id: a.id,
    parentId: a.parentId,
    name: a.name,
    radiusMiles: a.radiusMiles,
    depth: a.depth,
    status: a.status,
    resolvedLabel: resolutionLine(a),
    pacingLabel: a.pacing
      ? a.pacing.behind
        ? `behind — ${a.pacing.etaDate}`
        : `day ${String(a.pacing.etaDays)}`
      : null,
    behind: a.pacing?.behind ?? false,
    children: a.children.map(toTreeNode),
  });

  const siblingsOf = (parentId: number | null): AnchorNodeView[] =>
    parentId === null ? anchors : (flat.find((n) => n.id === parentId)?.children ?? []);

  const handleDrop = (dragId: number, targetId: number, zone: DropZone): void => {
    const target = flat.find((a) => a.id === targetId);
    if (!target || dragId === targetId) return;
    if (zone === "into") {
      // Nesting is narrowing: land it at the end of the target's children.
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

  if (tripId === undefined) {
    return (
      <div>
        <style>{VL_STYLES}</style>
        <p>No active trip. Create one on the Trip page first.</p>
      </div>
    );
  }

  return (
    <div className="vl-dash">
      <style>{VL_STYLES}</style>
      <div className="vl-layout">
        <div className="vl-map-pane">
          <MapView
            routes={[]}
            highlightedId={null}
            pois={suggestionPois}
            position={tripQ.data?.position ?? null}
            fitKey={fitKey}
            targets={mapTargets}
            draftTarget={draftAnchor}
            onSelectRoute={() => undefined}
            onStopClick={() => undefined}
            onPoiClick={() => undefined}
            onTargetClick={(id) => setSelectedId(id)}
            onTargetCenterDrag={onCenterDrag}
            onTargetRadiusDrag={onRadiusDrag}
            onMapClick={(point) => {
              if (!placing) return;
              setDraft((d) => ({
                name: d?.name ?? "",
                center: point,
                radiusMiles: d?.radiusMiles ?? 60,
              }));
            }}
            onViewportChange={() => undefined}
            heightStyle="100%"
          />
          {placing ? (
            <div className="vl-banner">
              <h4>{placing.parentId === null ? "New anchor" : "Narrowing"}</h4>
              <div style={{ fontSize: ".85rem" }}>
                Search for a place or click the map to set the center.
              </div>
            </div>
          ) : null}
        </div>

        <div className="vl-panel">
          <h3 style={{ marginTop: 0 }}>Route anchors</h3>
          <p style={{ color: "#555", fontSize: ".85rem", marginTop: 0 }}>
            Regions the route has to pass through. Give one a radius to say “somewhere around
            here”, then narrow it once you know where you actually want to be.
          </p>

          {error ? (
            <div className="vl-warning" style={{ marginBottom: 8 }}>
              {error}
            </div>
          ) : null}

          {anchors.length === 0 ? (
            <p style={{ color: "#666" }}>No anchors yet — the route runs straight to the destination.</p>
          ) : (
            <AnchorTree
              nodes={anchors.map(toTreeNode)}
              selectedId={selectedId}
              onSelect={(id) => {
                setSelectedId(id);
                setFitKey(`anchor-${String(id)}`);
              }}
              onDrop={handleDrop}
              onDropRoot={(dragId) => reparentMut.mutate({ id: dragId, parentId: null, orderIndex: anchors.length })}
              onMove={(n, delta) => {
                const a = flat.find((x) => x.id === n.id);
                if (a) move(a, delta);
              }}
              onNarrow={(id) => startPlacing(id)}
              onToggleSkip={(n) =>
                markMut.mutate({ id: n.id, status: n.status === "pending" ? "skipped" : "pending" })
              }
              onDelete={(n) => {
                const kids = flat.find((x) => x.id === n.id)?.children.length ?? 0;
                if (kids > 0 && !confirm(`Delete "${n.name}" and its ${String(kids)} narrowing(s)?`)) return;
                removeMut.mutate({ id: n.id });
              }}
            />
          )}

          {!placing ? (
            <button type="button" style={{ marginTop: 8 }} onClick={() => startPlacing(null)}>
              + Add an area
            </button>
          ) : (
            <div className="vl-anchor-editor">
              <input
                type="search"
                placeholder="Search a place — e.g. Eastern Sierra"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ width: "100%" }}
              />
              {searching ? <small>searching…</small> : null}
              {hits.length > 0 ? (
                <ul className="vl-hits">
                  {hits.map((h) => (
                    <li key={`${String(h.lat)},${String(h.lng)}`}>
                      <button
                        type="button"
                        onClick={() => {
                          setDraft({
                            name: h.name.split(",")[0] ?? h.name,
                            center: { lat: h.lat, lng: h.lng },
                            radiusMiles: h.suggestedRadiusMiles,
                          });
                          setHits([]);
                          setSearch("");
                          setFitKey(`draft-${String(h.lat)}`);
                        }}
                      >
                        {h.name}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}

              {draft ? (
                <>
                  <label>
                    Name
                    <input
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      style={{ width: "100%" }}
                    />
                  </label>
                  <label>
                    Radius: <strong>{draft.radiusMiles === 0 ? "exact point" : `${String(draft.radiusMiles)} mi`}</strong>
                    <input
                      type="range"
                      min={0}
                      max={RADIUS_STOPS.length - 1}
                      step={1}
                      value={nearestStop(draft.radiusMiles)}
                      onChange={(e) =>
                        setDraft({ ...draft, radiusMiles: RADIUS_STOPS[Number(e.target.value)]! })
                      }
                      style={{ width: "100%" }}
                    />
                  </label>
                  <button type="button" onClick={commitDraft} disabled={addMut.isPending}>
                    {placing.parentId === null ? "Add anchor" : "Add narrowing"}
                  </button>
                </>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setPlacing(null);
                  setDraft(null);
                  setError(null);
                }}
              >
                Cancel
              </button>
            </div>
          )}

          {selected && selected.radiusMiles > 0 ? (
            <div className="vl-anchor-detail">
              <h4>{selected.name}</h4>
              <p className="vl-drop-hint" style={{ marginTop: 0 }}>
                Drag the centre dot on the map to move this area, or the edge dot to resize it.
              </p>
              <label>
                Name
                <input
                  defaultValue={selected.name}
                  key={`name-${String(selected.id)}`}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== selected.name) updateMut.mutate({ id: selected.id, name: v });
                  }}
                  style={{ width: "100%" }}
                />
              </label>
              <label>
                Radius: <strong>{String(selected.radiusMiles)} mi</strong>
                <input
                  type="range"
                  min={0}
                  max={RADIUS_STOPS.length - 1}
                  step={1}
                  value={nearestStop(selected.radiusMiles)}
                  onChange={(e) =>
                    updateMut.mutate({ id: selected.id, radiusMiles: RADIUS_STOPS[Number(e.target.value)]! })
                  }
                  style={{ width: "100%" }}
                />
              </label>
              <label>
                Be there by
                <input
                  type="date"
                  value={selected.arriveBy ?? ""}
                  onChange={(e) =>
                    updateMut.mutate({ id: selected.id, arriveBy: e.target.value || null })
                  }
                />
              </label>
              {selected.pinned ? (
                <button type="button" onClick={() => pinMut.mutate({ id: selected.id, point: null, poiId: null })}>
                  Clear pinned spot
                </button>
              ) : null}

              <h5>Places inside this area</h5>
              {suggestionsQ.isLoading ? <small>loading…</small> : null}
              {suggestionsQ.data && suggestionsQ.data.suggestions.length === 0 ? (
                <small>
                  Nothing known here yet. The hourly place sweep prioritises anchor areas, so this
                  usually fills in within the hour.
                </small>
              ) : null}
              <ul className="vl-suggestions">
                {(suggestionsQ.data?.suggestions ?? []).slice(0, 20).map((p) => (
                  <li key={p.id}>
                    <span>
                      {p.name} <small>{p.category}</small>
                    </span>
                    <span>
                      <button
                        type="button"
                        title="Make this a narrower anchor inside the area"
                        onClick={() => promoteMut.mutate({ parentId: selected.id, poiId: p.id })}
                        disabled={selected.depth >= 2}
                      >
                        Narrow to this
                      </button>
                      <button
                        type="button"
                        title="Route through exactly this spot"
                        onClick={() =>
                          pinMut.mutate({ id: selected.id, point: { lat: p.lat, lng: p.lng }, poiId: p.id })
                        }
                      >
                        📌
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
