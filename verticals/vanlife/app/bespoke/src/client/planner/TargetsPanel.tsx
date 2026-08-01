import type { JSX } from "react";
import { TargetTree, type TargetTreeNode, type DropZone } from "../components/TargetTree.js";
import { GeocodeField } from "../components/GeocodeField.js";
import { OriginRow } from "./OriginRow.js";
import { FinalTargetRow } from "./FinalTargetRow.js";
import { TargetDetail, type SuggestedPlace } from "./TargetDetail.js";
import { RADIUS_STOPS, nearestStop, pacingLabel, resolutionLine, type TargetNode } from "./types.js";
import type { Draft, Placing } from "./useTargetDraft.js";

/**
 * The Targets tab: Origin at the top, the editable Targets in the middle, the
 * destination pinned at the bottom. One list, one vocabulary.
 */

export interface TargetsPanelProps {
  originName: string;
  originMovedOn: boolean;
  /** Editable Targets, i.e. everything but the final one. */
  targets: TargetNode[];
  finalTarget: TargetNode | null;
  selectedId: number | null;
  selected: TargetNode | null;
  suggestions: SuggestedPlace[];
  suggestionsLoading: boolean;
  placing: Placing | null;
  draft: Draft | null;
  addBusy: boolean;
  error: string | null;

  onSelect: (id: number) => void;
  onEditTrip: () => void;
  onDrop: (dragId: number, targetId: number, zone: DropZone) => void;
  onDropRoot: (dragId: number) => void;
  onMove: (node: TargetTreeNode, delta: number) => void;
  onNarrow: (id: number) => void;
  onToggleSkip: (node: TargetTreeNode) => void;
  onDelete: (node: TargetTreeNode) => void;
  onStartPlacing: () => void;
  onCancelPlacing: () => void;
  onDraftChange: (d: Draft) => void;
  onCommitDraft: () => void;
  onRename: (id: number, name: string) => void;
  onRadius: (id: number, radiusMiles: number) => void;
  onArriveBy: (id: number, date: string | null) => void;
  onClearPin: (id: number) => void;
  onNarrowToPlace: (parentId: number, poiId: number) => void;
  onPinPlace: (id: number, place: SuggestedPlace) => void;
}

function toTreeNode(t: TargetNode): TargetTreeNode {
  return {
    id: t.id,
    parentId: t.parentId,
    name: t.name,
    radiusMiles: t.radiusMiles,
    depth: t.depth,
    status: t.status,
    resolvedLabel: resolutionLine(t),
    pacingLabel: pacingLabel(t),
    behind: t.pacing?.behind ?? false,
    ordinal: t.ordinal,
    children: t.children.map(toTreeNode),
  };
}

export function TargetsPanel(props: TargetsPanelProps): JSX.Element {
  const { placing, draft } = props;

  return (
    <>
      <OriginRow name={props.originName} movedOn={props.originMovedOn} onEdit={props.onEditTrip} />

      <h3 style={{ margin: "10px 0 4px" }}>Targets</h3>
      <p style={{ color: "#555", fontSize: ".85rem", marginTop: 0 }}>
        Where the route has to go, in order. Give one a radius to say “somewhere around here”, then
        narrow it once you know where you actually want to be.
      </p>

      {props.error ? (
        <div className="vl-warning" style={{ marginBottom: 8 }}>
          {props.error}
        </div>
      ) : null}

      {props.targets.length === 0 ? (
        <p style={{ color: "#666" }}>
          No Targets in between yet — the route runs straight to the final one.
        </p>
      ) : (
        <TargetTree
          nodes={props.targets.map(toTreeNode)}
          selectedId={props.selectedId}
          onSelect={props.onSelect}
          onDrop={props.onDrop}
          onDropRoot={props.onDropRoot}
          onMove={props.onMove}
          onNarrow={props.onNarrow}
          onToggleSkip={props.onToggleSkip}
          onDelete={props.onDelete}
        />
      )}

      {props.finalTarget ? (
        <FinalTargetRow
          target={props.finalTarget}
          selected={props.selectedId === props.finalTarget.id}
          onSelect={() => props.onSelect(props.finalTarget!.id)}
          onEdit={props.onEditTrip}
        />
      ) : null}

      {!placing ? (
        <button type="button" className="vl-checkin-btn" style={{ marginTop: 8 }} onClick={props.onStartPlacing}>
          + Add a Target
        </button>
      ) : (
        <div className="vl-anchor-editor">
          <GeocodeField
            label={placing.parentId === null ? "New Target" : "Narrowing"}
            onPick={(h) =>
              props.onDraftChange({
                name: h.name.split(",")[0] ?? h.name,
                center: { lat: h.lat, lng: h.lng },
                radiusMiles: h.suggestedRadiusMiles,
              })
            }
          />

          {draft ? (
            <>
              <label>
                Name
                <input
                  value={draft.name}
                  onChange={(e) => props.onDraftChange({ ...draft, name: e.target.value })}
                  style={{ width: "100%" }}
                />
              </label>
              <label>
                Radius:{" "}
                <strong>{draft.radiusMiles === 0 ? "exact point" : `${String(draft.radiusMiles)} mi`}</strong>
                <input
                  type="range"
                  min={0}
                  max={RADIUS_STOPS.length - 1}
                  step={1}
                  value={nearestStop(draft.radiusMiles)}
                  onChange={(e) =>
                    props.onDraftChange({ ...draft, radiusMiles: RADIUS_STOPS[Number(e.target.value)]! })
                  }
                  style={{ width: "100%" }}
                />
              </label>
              <button type="button" onClick={props.onCommitDraft} disabled={props.addBusy}>
                {placing.parentId === null ? "Add Target" : "Add narrowing"}
              </button>
            </>
          ) : null}
          <button type="button" onClick={props.onCancelPlacing}>
            Cancel
          </button>
        </div>
      )}

      {props.selected && !props.selected.final && props.selected.radiusMiles > 0 ? (
        <TargetDetail
          target={props.selected}
          suggestions={props.suggestions}
          suggestionsLoading={props.suggestionsLoading}
          onRename={(name) => props.onRename(props.selected!.id, name)}
          onRadius={(r) => props.onRadius(props.selected!.id, r)}
          onArriveBy={(d) => props.onArriveBy(props.selected!.id, d)}
          onClearPin={() => props.onClearPin(props.selected!.id)}
          onNarrowToPlace={(poiId) => props.onNarrowToPlace(props.selected!.id, poiId)}
          onPinPlace={(p) => props.onPinPlace(props.selected!.id, p)}
        />
      ) : null}
    </>
  );
}
