import { useState } from "react";
import { haversineMiles } from "../../server/engine/geo.js";
import { ringFor } from "../lib/anchorRing.js";
import { DRAFT_TARGET_ID, type MapTargetView } from "../map/types.js";
import type { TargetNode } from "./types.js";

/**
 * Placing a new Target, and dragging an existing one.
 *
 * Both end up drawing the same dashed preview ring, so they share this. Drag
 * frames are held locally and only the last one is written: the circle tracks
 * the pointer at frame rate without a mutation per frame.
 */

export interface Placing {
  /** Null places a new top-level Target; an id narrows that one. */
  parentId: number | null;
}

export interface Draft {
  name: string;
  center: { lat: number; lng: number };
  radiusMiles: number;
}

interface Dragging {
  id: number;
  center: { lat: number; lng: number };
  radiusMiles: number;
}

export interface TargetDraftState {
  placing: Placing | null;
  draft: Draft | null;
  startPlacing: (parentId: number | null) => void;
  cancel: () => void;
  setDraft: (d: Draft | null) => void;
  /** Click-to-place: only meaningful while placing. */
  placeAt: (point: { lat: number; lng: number }) => void;
  onCenterDrag: (
    id: number,
    center: { lat: number; lng: number },
    done: boolean,
    targets: TargetNode[],
    commit: (v: { id: number; center: { lat: number; lng: number } }) => void,
  ) => void;
  onRadiusDrag: (
    id: number,
    handle: { lat: number; lng: number },
    done: boolean,
    targets: TargetNode[],
    commit: (v: { id: number; radiusMiles: number }) => void,
  ) => void;
  /** The dashed preview: a live drag if there is one, else the placement draft. */
  previewFor: (targets: TargetNode[]) => MapTargetView | null;
}

const DEFAULT_RADIUS_MILES = 60;

export function useTargetDraft(): TargetDraftState {
  const [placing, setPlacing] = useState<Placing | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dragging, setDragging] = useState<Dragging | null>(null);

  const startPlacing = (parentId: number | null): void => {
    setPlacing({ parentId });
    setDraft(null);
  };

  const cancel = (): void => {
    setPlacing(null);
    setDraft(null);
  };

  const placeAt = (point: { lat: number; lng: number }): void => {
    if (!placing) return;
    setDraft((d) => ({
      name: d?.name ?? "",
      center: point,
      radiusMiles: d?.radiusMiles ?? DEFAULT_RADIUS_MILES,
    }));
  };

  const onCenterDrag: TargetDraftState["onCenterDrag"] = (id, center, done, targets, commit) => {
    const t = targets.find((x) => x.id === id);
    if (!t) return;
    if (!done) {
      setDragging({ id, center, radiusMiles: t.radiusMiles });
      return;
    }
    setDragging(null);
    commit({ id, center });
  };

  const onRadiusDrag: TargetDraftState["onRadiusDrag"] = (id, handle, done, targets, commit) => {
    const t = targets.find((x) => x.id === id);
    if (!t) return;
    // The handle reports a position; the radius is how far it now sits from the
    // centre. Rounded to whole miles so the committed value is legible.
    const radiusMiles = Math.max(1, Math.round(haversineMiles(t.center, handle)));
    if (!done) {
      setDragging({ id, center: t.center, radiusMiles });
      return;
    }
    setDragging(null);
    commit({ id, radiusMiles });
  };

  const previewFor = (targets: TargetNode[]): MapTargetView | null => {
    if (dragging) {
      const t = targets.find((x) => x.id === dragging.id);
      return {
        id: DRAFT_TARGET_ID,
        name: t?.name ?? "",
        center: dragging.center,
        radiusMiles: dragging.radiusMiles,
        ring: ringFor(dragging.center, dragging.radiusMiles),
        depth: t?.depth ?? 0,
        state: "pending",
        resolved: null,
        selected: true,
        final: false,
        ordinal: null,
      };
    }
    if (draft) {
      return {
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
      };
    }
    return null;
  };

  return { placing, draft, startPlacing, cancel, setDraft, placeAt, onCenterDrag, onRadiusDrag, previewFor };
}
