import { describe, expect, it } from "vitest";
import {
  bearingDegrees,
  circlePolygon,
  closestPointOnLine,
  closestPointOnSegment,
  destinationPoint,
  discBbox,
  haversineMiles,
  withinDisc,
} from "../src/server/engine/geo.js";

const BISHOP = { lat: 37.3635, lng: -118.3951 };

describe("withinDisc", () => {
  it("is inclusive at the boundary", () => {
    const edge = destinationPoint(BISHOP, 90, 50);
    expect(withinDisc(edge, BISHOP, 50.01)).toBe(true);
    expect(withinDisc(edge, BISHOP, 49.9)).toBe(false);
  });

  it("admits only the center when the radius is zero", () => {
    expect(withinDisc(BISHOP, BISHOP, 0)).toBe(true);
    expect(withinDisc({ lat: 37.3636, lng: -118.3951 }, BISHOP, 0)).toBe(false);
  });
});

describe("discBbox", () => {
  it("contains all four cardinal extremes of the disc", () => {
    const [s, w, n, e] = discBbox(BISHOP, 110);
    for (const bearing of [0, 90, 180, 270]) {
      const p = destinationPoint(BISHOP, bearing, 110);
      expect(p.lat).toBeGreaterThanOrEqual(s);
      expect(p.lat).toBeLessThanOrEqual(n);
      expect(p.lng).toBeGreaterThanOrEqual(w);
      expect(p.lng).toBeLessThanOrEqual(e);
    }
  });

  it("pads longitude more at high latitude, where degrees are narrower", () => {
    const equator = discBbox({ lat: 0, lng: 0 }, 100);
    const north = discBbox({ lat: 60, lng: 0 }, 100);
    expect(north[3] - north[1]).toBeGreaterThan(equator[3] - equator[1]);
  });
});

describe("closestPointOnSegment", () => {
  it("finds the perpendicular foot beside a segment", () => {
    const a = { lat: 37, lng: -118 };
    const b = { lat: 37, lng: -117 };
    const hit = closestPointOnSegment(a, b, { lat: 37.5, lng: -117.5 });
    expect(hit.t).toBeCloseTo(0.5, 2);
    expect(hit.point.lat).toBeCloseTo(37, 5);
  });

  it("clamps behind A and beyond B rather than extending the line", () => {
    const a = { lat: 37, lng: -118 };
    const b = { lat: 37, lng: -117 };
    expect(closestPointOnSegment(a, b, { lat: 37, lng: -119 }).t).toBe(0);
    expect(closestPointOnSegment(a, b, { lat: 37, lng: -116 }).t).toBe(1);
  });

  it("handles a degenerate segment whose endpoints coincide", () => {
    const hit = closestPointOnSegment(BISHOP, BISHOP, { lat: 38, lng: -118 });
    expect(hit.t).toBe(0);
    expect(hit.point).toEqual(BISHOP);
    expect(Number.isFinite(hit.miles)).toBe(true);
  });
});

describe("closestPointOnLine", () => {
  it("keeps the lowest segment index when two segments tie", () => {
    // A symmetric V: the apex is equidistant from a point directly above it.
    const coords: [number, number][] = [
      [-1, 1],
      [0, 0],
      [1, 1],
    ];
    expect(closestPointOnLine(coords, { lat: 2, lng: 0 }).segmentIndex).toBe(0);
  });

  it("degrades gracefully on empty and single-point lines", () => {
    expect(closestPointOnLine([], BISHOP).miles).toBe(0);
    expect(closestPointOnLine([[-118.3951, 37.3635]], BISHOP).miles).toBeCloseTo(0, 5);
  });
});

describe("circlePolygon", () => {
  it("is closed and every vertex sits on the radius", () => {
    const ring = circlePolygon(BISHOP, 110);
    expect(ring).toHaveLength(65);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    for (const [lng, lat] of ring) {
      expect(haversineMiles(BISHOP, { lat, lng })).toBeCloseTo(110, 0);
    }
  });

  it("stays circular at high latitude, where a naive box would flatten", () => {
    const ring = circlePolygon({ lat: 65, lng: -150 }, 80);
    for (const [lng, lat] of ring) {
      expect(haversineMiles({ lat: 65, lng: -150 }, { lat, lng })).toBeCloseTo(80, 0);
    }
  });

  it("is byte-identical across calls", () => {
    expect(circlePolygon(BISHOP, 110)).toEqual(circlePolygon(BISHOP, 110));
  });
});

describe("bearingDegrees / destinationPoint round-trip", () => {
  it("returns to the same point", () => {
    const target = { lat: 38.2, lng: -119.1 };
    const back = destinationPoint(BISHOP, bearingDegrees(BISHOP, target), haversineMiles(BISHOP, target));
    expect(back.lat).toBeCloseTo(target.lat, 4);
    expect(back.lng).toBeCloseTo(target.lng, 4);
  });
});
