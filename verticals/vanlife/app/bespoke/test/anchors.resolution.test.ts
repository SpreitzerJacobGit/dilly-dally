import { describe, expect, it } from "vitest";
import {
  allPendingAnchors,
  anchorDetourCapMinutes,
  anchorHorizons,
  buildAnchorTree,
  capChain,
  flattenPendingAnchors,
  resolveAnchor,
  resolveAnchorChain,
  type AnchorRow,
} from "../src/server/engine/anchors.js";
import { haversineMiles, withinDisc } from "../src/server/engine/geo.js";
import type { CorridorPoi } from "../src/server/engine/pois.js";

const PORTLAND = { lat: 45.5152, lng: -122.6784 };
const VEGAS = { lat: 36.1699, lng: -115.1398 };
const SIERRA = { lat: 37.45, lng: -118.55 };

function row(over: Partial<AnchorRow> & { id: number }): AnchorRow {
  return {
    parentId: null,
    name: `anchor-${String(over.id)}`,
    kind: "custom",
    lat: SIERRA.lat,
    lng: SIERRA.lng,
    radiusMiles: 0,
    orderIndex: 0,
    depth: 0,
    status: "pending",
    pinnedLat: null,
    pinnedLng: null,
    pinnedPoiId: null,
    arriveBy: null,
    ...over,
  };
}

function poi(over: Partial<CorridorPoi> & { id: number }): CorridorPoi {
  return {
    name: `poi-${String(over.id)}`,
    category: "boulder",
    lat: SIERRA.lat,
    lng: SIERRA.lng,
    source: "manual",
    url: null,
    popularity: 0.5,
    score: 0.5,
    pinned: false,
    ...over,
  };
}

describe("buildAnchorTree", () => {
  it("nests children and orders siblings by (orderIndex, id)", () => {
    const tree = buildAnchorTree([
      row({ id: 2, orderIndex: 1 }),
      row({ id: 1, orderIndex: 0 }),
      row({ id: 3, parentId: 1, depth: 1, orderIndex: 5 }),
      row({ id: 4, parentId: 1, depth: 1, orderIndex: 5 }),
    ]);
    expect(tree.map((n) => n.id)).toEqual([1, 2]);
    // Equal orderIndex falls back to id, never to database scan order.
    expect(tree[0]!.children.map((n) => n.id)).toEqual([3, 4]);
  });

  it("roots an orphan whose parent is missing rather than dropping it", () => {
    const tree = buildAnchorTree([row({ id: 9, parentId: 404, depth: 1 })]);
    expect(tree.map((n) => n.id)).toEqual([9]);
  });
});

describe("flattenPendingAnchors — narrowing", () => {
  const nested = [
    row({ id: 1, radiusMiles: 110 }),
    row({ id: 2, parentId: 1, depth: 1, radiusMiles: 20 }),
    row({ id: 3, parentId: 2, depth: 2, radiusMiles: 0 }),
  ];

  it("routes through the leaf-most pending anchor", () => {
    expect(flattenPendingAnchors(buildAnchorTree(nested)).map((a) => a.id)).toEqual([3]);
  });

  it("falls back to the parent when the narrowing is skipped", () => {
    const skipped = nested.map((r) => (r.id === 3 ? { ...r, status: "skipped" } : r));
    expect(flattenPendingAnchors(buildAnchorTree(skipped)).map((a) => a.id)).toEqual([2]);
  });

  it("falls back to the broad anchor when every narrowing is gone", () => {
    const skipped = nested.map((r) => (r.id === 3 || r.id === 2 ? { ...r, status: "skipped" } : r));
    expect(flattenPendingAnchors(buildAnchorTree(skipped)).map((a) => a.id)).toEqual([1]);
  });

  it("drops a skipped parent with its whole subtree", () => {
    const skipped = nested.map((r) => (r.id === 1 ? { ...r, status: "skipped" } : r));
    expect(flattenPendingAnchors(buildAnchorTree(skipped))).toEqual([]);
  });

  it("allPendingAnchors keeps every depth, for POI ingestion", () => {
    expect(allPendingAnchors(buildAnchorTree(nested)).map((a) => a.id)).toEqual([1, 2, 3]);
  });
});

describe("resolveAnchor", () => {
  const disc = buildAnchorTree([row({ id: 1, radiusMiles: 110 })])[0]!;

  it("returns the center verbatim for an exact point", () => {
    const point = buildAnchorTree([row({ id: 1, radiusMiles: 0 })])[0]!;
    const r = resolveAnchor(point, PORTLAND, VEGAS, []);
    expect(r.via).toBe("point");
    expect(r.point).toEqual(SIERRA);
  });

  it("lets the operator's pin beat a higher-scoring place", () => {
    const pinned = buildAnchorTree([
      row({ id: 1, radiusMiles: 110, pinnedLat: 37.3283, pinnedLng: -118.5771 }),
    ])[0]!;
    const r = resolveAnchor(pinned, PORTLAND, VEGAS, [poi({ id: 7, score: 0.99 })]);
    expect(r.via).toBe("pinned");
    expect(r.point).toEqual({ lat: 37.3283, lng: -118.5771 });
  });

  it("picks the best place inside the disc", () => {
    // Both are real seeded places in the eastern Sierra. The Buttermilks are a
    // little further off the line but score far higher, and the radius-scaled
    // budget is wide enough to afford them.
    const r = resolveAnchor(disc, PORTLAND, VEGAS, [
      poi({ id: 7, score: 0.9, name: "Buttermilks", lat: 37.3283, lng: -118.5771 }),
      poi({ id: 8, score: 0.2, name: "Happies", lat: 37.4171, lng: -118.4382 }),
    ]);
    expect(r.via).toBe("poi");
    expect(r.poiName).toBe("Buttermilks");
  });

  it("judges places against the cheapest crossing, not against skipping the region", () => {
    // An anchor is a hard constraint, so the geometric pass-through is free and
    // a place only has to justify what it costs on top of that. Measured the
    // other way, every place in a broad region looks unaffordable.
    const r = resolveAnchor(disc, PORTLAND, VEGAS, [
      poi({ id: 7, score: 0.9, name: "Buttermilks", lat: 37.3283, lng: -118.5771 }),
    ]);
    expect(r.via).toBe("poi");
  });

  it("scales the budget to the radius, so a tight anchor stays tight", () => {
    // The same place, inside a 15-mile anchor centered on it: still chosen.
    const tight = buildAnchorTree([
      row({ id: 1, lat: 37.3283, lng: -118.5771, radiusMiles: 15 }),
    ])[0]!;
    expect(anchorDetourCapMinutes(15)).toBeLessThan(anchorDetourCapMinutes(110));
    const r = resolveAnchor(tight, PORTLAND, VEGAS, [
      poi({ id: 7, score: 0.9, lat: 37.3283, lng: -118.5771 }),
    ]);
    expect(r.via).toBe("poi");
  });

  it("breaks an exact value tie on the lower id", () => {
    const r = resolveAnchor(disc, PORTLAND, VEGAS, [
      poi({ id: 8, score: 0.5, lat: 37.4, lng: -118.5 }),
      poi({ id: 3, score: 0.5, lat: 37.4, lng: -118.5 }),
    ]);
    expect(r.poiId).toBe(3);
  });

  it("prefers a place the operator pinned on the map", () => {
    const r = resolveAnchor(disc, PORTLAND, VEGAS, [
      poi({ id: 7, score: 0.95, lat: 37.4, lng: -118.5 }),
      poi({ id: 8, score: 0.1, pinned: true, lat: 37.42, lng: -118.52 }),
    ]);
    expect(r.poiId).toBe(8);
  });

  it("ignores a place beyond the detour cap and falls back geometrically", () => {
    const r = resolveAnchor(disc, PORTLAND, VEGAS, [poi({ id: 7, lat: 38.3, lng: -119.4 })], 1);
    expect(r.via).toBe("geometric");
    expect(r.poiId).toBeNull();
  });

  it("costs essentially nothing when the direct path already crosses the disc", () => {
    // Portland → Vegas passes through the eastern Sierra, so this disc is
    // already on the way. The residual is projection error over an 800-mile
    // leg, not a real detour — reported honestly rather than rounded to zero.
    const r = resolveAnchor(disc, PORTLAND, VEGAS, []);
    expect(r.via).toBe("geometric");
    expect(r.detourMinutes).toBeLessThan(2);
    expect(withinDisc(r.point, SIERRA, 110)).toBe(true);
  });

  it("steps onto the boundary at closest approach when the path misses", () => {
    const far = buildAnchorTree([row({ id: 1, lat: 44, lng: -110, radiusMiles: 50 })])[0]!;
    const r = resolveAnchor(far, PORTLAND, VEGAS, []);
    expect(r.via).toBe("geometric");
    expect(haversineMiles(r.point, { lat: 44, lng: -110 })).toBeCloseTo(50, 0);
    expect(r.detourMinutes).toBeGreaterThan(0);
  });

  it("is deterministic across identical calls", () => {
    const pool = [poi({ id: 7, score: 0.9 }), poi({ id: 8, score: 0.9 })];
    expect(resolveAnchor(disc, PORTLAND, VEGAS, pool)).toEqual(
      resolveAnchor(disc, PORTLAND, VEGAS, pool),
    );
  });
});

describe("resolveAnchorChain", () => {
  it("resolves each anchor against the previous resolved point", () => {
    const anchors = buildAnchorTree([
      row({ id: 1, orderIndex: 0, lat: 42, lng: -121, radiusMiles: 40 }),
      row({ id: 2, orderIndex: 1, lat: 37.45, lng: -118.55, radiusMiles: 110 }),
    ]);
    const chain = resolveAnchorChain(flattenPendingAnchors(anchors), PORTLAND, VEGAS, new Map());
    expect(chain).toHaveLength(2);
    expect(chain.map((c) => c.anchorId)).toEqual([1, 2]);
    for (const c of chain) expect(Number.isFinite(c.point.lat)).toBe(true);
  });
});

describe("capChain", () => {
  it("passes short chains through untouched", () => {
    expect(capChain([1, 2, 3], 12)).toEqual({ kept: [1, 2, 3], dropped: 0 });
  });

  it("drops from the middle, keeping both ends", () => {
    const { kept, dropped } = capChain([1, 2, 3, 4, 5, 6, 7, 8], 4);
    expect(kept).toEqual([1, 2, 7, 8]);
    expect(dropped).toBe(4);
  });
});

describe("anchorHorizons", () => {
  const anchors = buildAnchorTree([row({ id: 1, radiusMiles: 110, arriveBy: "2026-01-02" })]);
  const resolved = resolveAnchorChain(flattenPendingAnchors(anchors), PORTLAND, VEGAS, new Map());

  it("buckets by projected days out and flags a date it cannot make", () => {
    const [pacing] = anchorHorizons(resolved, flattenPendingAnchors(anchors), {
      start: PORTLAND,
      dailyDriveHours: 4,
      now: "2026-01-01T00:00:00.000Z",
    });
    expect(pacing!.etaDays).toBeGreaterThan(1);
    expect(pacing!.horizon).toBe("this-week");
    // ~800 miles at 4 h/day cannot be done by tomorrow.
    expect(pacing!.behind).toBe(true);
  });

  it("is not behind when the date is generous", () => {
    const late = buildAnchorTree([row({ id: 1, radiusMiles: 110, arriveBy: "2026-06-01" })]);
    const [pacing] = anchorHorizons(resolved, flattenPendingAnchors(late), {
      start: PORTLAND,
      dailyDriveHours: 4,
      now: "2026-01-01T00:00:00.000Z",
    });
    expect(pacing!.behind).toBe(false);
  });
});
