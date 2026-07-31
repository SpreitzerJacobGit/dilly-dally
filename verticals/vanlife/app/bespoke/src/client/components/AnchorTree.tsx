import { useState, type JSX } from "react";

/**
 * Drag-and-drop anchor tree.
 *
 * Dropping *between* rows reorders; dropping *onto* a row nests, which is the
 * same act as narrowing. Native HTML5 drag and drop — a tree this size does not
 * justify a dependency, and the native API gives keyboard-free pointer dragging
 * on desktop while the ↑/↓/Narrow buttons remain the accessible path on touch.
 */

export interface AnchorTreeNode {
  id: number;
  parentId: number | null;
  name: string;
  radiusMiles: number;
  depth: number;
  status: string;
  resolvedLabel: string;
  pacingLabel: string | null;
  behind: boolean;
  children: AnchorTreeNode[];
}

/** Where a drop would land relative to the row under the pointer. */
export type DropZone = "before" | "into" | "after";

export interface AnchorTreeProps {
  nodes: AnchorTreeNode[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  /** Reorder within a level, or nest when `zone` is "into". */
  onDrop: (dragId: number, targetId: number, zone: DropZone) => void;
  /** Drop at the very end of the top level. */
  onDropRoot: (dragId: number) => void;
  onMove: (node: AnchorTreeNode, delta: number) => void;
  onNarrow: (id: number) => void;
  onToggleSkip: (node: AnchorTreeNode) => void;
  onDelete: (node: AnchorTreeNode) => void;
}

function zoneFor(e: React.DragEvent, canNest: boolean): DropZone {
  const r = e.currentTarget.getBoundingClientRect();
  const y = (e.clientY - r.top) / r.height;
  if (!canNest) return y < 0.5 ? "before" : "after";
  if (y < 0.3) return "before";
  if (y > 0.7) return "after";
  return "into";
}

export function AnchorTree(props: AnchorTreeProps): JSX.Element {
  const [dragId, setDragId] = useState<number | null>(null);
  const [over, setOver] = useState<{ id: number; zone: DropZone } | null>(null);
  const [overRoot, setOverRoot] = useState(false);

  const clear = (): void => {
    setDragId(null);
    setOver(null);
    setOverRoot(false);
  };

  /** Dropping a node into its own subtree would detach it; the server rejects
   *  it too, but refusing the drop outright avoids an error the user can see
   *  coming. */
  const isSelfOrDescendant = (node: AnchorTreeNode, id: number): boolean =>
    node.id === id || node.children.some((c) => isSelfOrDescendant(c, id));

  const renderRow = (n: AnchorTreeNode): JSX.Element => {
    const blocked = dragId !== null && isSelfOrDescendant(n, dragId);
    const zone = over?.id === n.id ? over.zone : null;
    return (
      <div key={n.id}>
        <div
          className={[
            "vl-anchor-row",
            n.id === props.selectedId ? "vl-anchor-selected" : "",
            n.status !== "pending" ? "vl-anchor-dim" : "",
            dragId === n.id ? "vl-anchor-dragging" : "",
            zone === "into" ? "vl-drop-into" : "",
            zone === "before" ? "vl-drop-before" : "",
            zone === "after" ? "vl-drop-after" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={{ marginLeft: `${String(n.depth * 16)}px` }}
          draggable
          onDragStart={(e) => {
            setDragId(n.id);
            e.dataTransfer.effectAllowed = "move";
            // Firefox refuses to start a drag without payload.
            e.dataTransfer.setData("text/plain", String(n.id));
          }}
          onDragEnd={clear}
          onDragOver={(e) => {
            if (dragId === null || blocked) return;
            e.preventDefault();
            e.stopPropagation();
            setOverRoot(false);
            setOver({ id: n.id, zone: zoneFor(e, n.depth < 2) });
          }}
          onDragLeave={() => setOver((o) => (o?.id === n.id ? null : o))}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (dragId !== null && !blocked && dragId !== n.id) {
              props.onDrop(dragId, n.id, zoneFor(e, n.depth < 2));
            }
            clear();
          }}
          onClick={() => props.onSelect(n.id)}
        >
          <div className="vl-anchor-head">
            <span className="vl-drag-grip" aria-hidden="true">
              ⠿
            </span>
            <strong>{n.name}</strong>
            <span className="vl-chip">{n.radiusMiles > 0 ? `${String(n.radiusMiles)} mi` : "exact"}</span>
            {n.pacingLabel ? (
              <span className={`vl-chip${n.behind ? " vl-chip-warn" : ""}`}>{n.pacingLabel}</span>
            ) : null}
            {n.status !== "pending" ? <span className="vl-chip">{n.status}</span> : null}
          </div>
          <div className="vl-anchor-sub">{n.resolvedLabel}</div>
          <div className="vl-anchor-actions">
            <button type="button" title="Move earlier" onClick={(e) => { e.stopPropagation(); props.onMove(n, -1); }}>↑</button>
            <button type="button" title="Move later" onClick={(e) => { e.stopPropagation(); props.onMove(n, 1); }}>↓</button>
            {n.depth < 2 ? (
              <button type="button" onClick={(e) => { e.stopPropagation(); props.onNarrow(n.id); }}>
                Narrow…
              </button>
            ) : null}
            <button type="button" onClick={(e) => { e.stopPropagation(); props.onToggleSkip(n); }}>
              {n.status === "pending" ? "Skip" : "Restore"}
            </button>
            <button type="button" onClick={(e) => { e.stopPropagation(); props.onDelete(n); }}>
              Delete
            </button>
          </div>
        </div>
        {n.children.map(renderRow)}
      </div>
    );
  };

  return (
    <div
      className={`vl-anchor-tree${overRoot ? " vl-drop-root" : ""}`}
      onDragOver={(e) => {
        if (dragId === null) return;
        e.preventDefault();
        setOver(null);
        setOverRoot(true);
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (dragId !== null) props.onDropRoot(dragId);
        clear();
      }}
    >
      {props.nodes.map(renderRow)}
      {props.nodes.length > 0 ? (
        <div className="vl-drop-hint">Drag onto an anchor to narrow it, or between anchors to reorder.</div>
      ) : null}
    </div>
  );
}
