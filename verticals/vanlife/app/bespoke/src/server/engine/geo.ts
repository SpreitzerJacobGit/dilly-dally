/** Pure geometry helpers — no I/O, fully deterministic. */

export interface LatLng {
  lat: number;
  lng: number;
}

/** [lng, lat] positions, GeoJSON order. */
export type LineCoords = [number, number][];

const EARTH_RADIUS_MILES = 3958.8;

export function haversineMiles(a: LatLng, b: LatLng): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

/**
 * Corridor membership: X is possibly reachable inside a driving-time budget
 * from A to B iff hav(A,X)+hav(X,B) fits under the budget at an optimistic
 * road speed — an ellipse with foci A and B. Optimistic on purpose: pruning
 * must never exclude a feasible place; the router verifies the survivors.
 */
export function withinEllipse(p: LatLng, focusA: LatLng, focusB: LatLng, maxSumMiles: number): boolean {
  return haversineMiles(focusA, p) + haversineMiles(p, focusB) <= maxSumMiles;
}

/** Bounding box [south, west, north, east] that safely contains the ellipse. */
export function ellipseBbox(
  focusA: LatLng,
  focusB: LatLng,
  maxSumMiles: number,
): [number, number, number, number] {
  const a = maxSumMiles / 2;
  const c = haversineMiles(focusA, focusB) / 2;
  const b = a > c ? Math.sqrt(a * a - c * c) : 0;
  const pad = Math.max(b, 10);
  const midLat = (focusA.lat + focusB.lat) / 2;
  const latPad = pad / 69;
  const lngPad = pad / (69 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
  return [
    Math.min(focusA.lat, focusB.lat) - latPad,
    Math.min(focusA.lng, focusB.lng) - lngPad,
    Math.max(focusA.lat, focusB.lat) + latPad,
    Math.max(focusA.lng, focusB.lng) + lngPad,
  ];
}

export function lineDistanceMiles(coords: LineCoords): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineMiles(
      { lng: coords[i - 1]![0], lat: coords[i - 1]![1] },
      { lng: coords[i]![0], lat: coords[i]![1] },
    );
  }
  return total;
}

/** The point a given fraction of the line's length along it. */
export function pointAlongLine(coords: LineCoords, fraction: number): LatLng {
  const clamped = Math.min(1, Math.max(0, fraction));
  const total = lineDistanceMiles(coords);
  if (total === 0 || coords.length === 0) {
    const first = coords[0] ?? [0, 0];
    return { lng: first[0], lat: first[1] };
  }
  let target = total * clamped;
  for (let i = 1; i < coords.length; i++) {
    const prev = { lng: coords[i - 1]![0], lat: coords[i - 1]![1] };
    const cur = { lng: coords[i]![0], lat: coords[i]![1] };
    const seg = haversineMiles(prev, cur);
    if (seg >= target && seg > 0) {
      const t = target / seg;
      return { lng: prev.lng + (cur.lng - prev.lng) * t, lat: prev.lat + (cur.lat - prev.lat) * t };
    }
    target -= seg;
  }
  const last = coords[coords.length - 1]!;
  return { lng: last[0], lat: last[1] };
}

/**
 * Estimated extra driving minutes to visit `p` between `prev` and `next`,
 * from great-circle distance with a road-shape factor. Used only to RANK
 * insertions — every emitted candidate is verified by the router afterwards.
 */
export function detourEstimateMinutes(prev: LatLng, p: LatLng, next: LatLng): number {
  const ROAD_FACTOR = 1.3;
  const AVG_MPH = 45;
  const extra = haversineMiles(prev, p) + haversineMiles(p, next) - haversineMiles(prev, next);
  return ((extra * ROAD_FACTOR) / AVG_MPH) * 60;
}
