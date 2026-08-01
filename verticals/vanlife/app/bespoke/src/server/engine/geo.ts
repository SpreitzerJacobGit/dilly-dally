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

/** True when `p` is within `maxMiles` of any anchor. No anchors means false. */
export function withinMilesOfAny(p: LatLng, anchors: LatLng[], maxMiles: number): boolean {
  return anchors.some((a) => haversineMiles(p, a) <= maxMiles);
}

/**
 * Shortest distance from a point to a polyline, in miles. Infinity for a line
 * with no segments — a caller with no route has no distance to it, and that
 * must not read as "zero miles away".
 *
 * Segments are projected into a local equirectangular plane centred on `p`,
 * which is exact enough at the corridor scales this is used at and keeps the
 * helper pure.
 */
export function pointToLineMiles(p: LatLng, coords: LineCoords): number {
  if (coords.length === 0) return Number.POSITIVE_INFINITY;
  if (coords.length === 1) return haversineMiles(p, { lng: coords[0]![0], lat: coords[0]![1] });
  const milesPerDegree = (Math.PI * EARTH_RADIUS_MILES) / 180;
  const cosLat = Math.cos((p.lat * Math.PI) / 180);
  const x = (lng: number): number => (lng - p.lng) * milesPerDegree * cosLat;
  const y = (lat: number): number => (lat - p.lat) * milesPerDegree;

  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]!;
    const b = coords[i]!;
    const ax = x(a[0]);
    const ay = y(a[1]);
    const bx = x(b[0]);
    const by = y(b[1]);
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / lenSq));
    const closest = { lng: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t };
    const miles = haversineMiles(p, closest);
    if (miles < best) best = miles;
  }
  return best;
}

/** Bounding box [south, west, north, east] holding every point, padded by `padMiles`. */
export function bboxAround(points: LatLng[], padMiles: number): [number, number, number, number] {
  if (points.length === 0) return [-90, -180, 90, 180];
  let south = points[0]!.lat;
  let north = points[0]!.lat;
  let west = points[0]!.lng;
  let east = points[0]!.lng;
  for (const p of points) {
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
    west = Math.min(west, p.lng);
    east = Math.max(east, p.lng);
  }
  const midLat = (south + north) / 2;
  const latPad = padMiles / 69;
  const lngPad = padMiles / (69 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
  return [south - latPad, west - lngPad, north + latPad, east + lngPad];
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

/* ── Discs: an anchor is a region the route must pass through ─────────────── */

const MILES_PER_DEG_LAT = (EARTH_RADIUS_MILES * Math.PI) / 180;

/**
 * Disc membership. Inclusive at the boundary, so a place exactly `radiusMiles`
 * out still counts. A radius of 0 admits only the center itself.
 */
export function withinDisc(p: LatLng, center: LatLng, radiusMiles: number): boolean {
  if (radiusMiles <= 0) return p.lat === center.lat && p.lng === center.lng;
  return haversineMiles(center, p) <= radiusMiles;
}

/** Bounding box [south, west, north, east] that safely contains the disc. */
export function discBbox(center: LatLng, radiusMiles: number): [number, number, number, number] {
  const pad = Math.max(radiusMiles, 1);
  const latPad = pad / 69;
  const lngPad = pad / (69 * Math.max(0.2, Math.cos((center.lat * Math.PI) / 180)));
  return [center.lat - latPad, center.lng - lngPad, center.lat + latPad, center.lng + lngPad];
}

export function bearingDegrees(a: LatLng, b: LatLng): number {
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lb);
  const x = Math.cos(la) * Math.sin(lb) - Math.sin(la) * Math.cos(lb) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Walk `miles` from `from` along `bearingDeg` — the inverse of bearingDegrees. */
export function destinationPoint(from: LatLng, bearingDeg: number, miles: number): LatLng {
  const d = miles / EARTH_RADIUS_MILES;
  const br = (bearingDeg * Math.PI) / 180;
  const la = (from.lat * Math.PI) / 180;
  const lo = (from.lng * Math.PI) / 180;
  const lat = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(br));
  const lng =
    lo + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(lat));
  return { lat: (lat * 180) / Math.PI, lng: (((lng * 180) / Math.PI + 540) % 360) - 180 };
}

/**
 * Perpendicular foot of `p` on segment a→b, clamped to the endpoints. Projected
 * into a local equirectangular frame, which is accurate well past the scale of
 * any single leg. `t` is the clamped position along the segment, 0 at a, 1 at b.
 */
export function closestPointOnSegment(
  a: LatLng,
  b: LatLng,
  p: LatLng,
): { point: LatLng; t: number; miles: number } {
  const lat0 = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const kx = Math.cos(lat0) * MILES_PER_DEG_LAT;
  const ax = a.lng * kx;
  const ay = a.lat * MILES_PER_DEG_LAT;
  const bx = b.lng * kx;
  const by = b.lat * MILES_PER_DEG_LAT;
  const px = p.lng * kx;
  const py = p.lat * MILES_PER_DEG_LAT;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  // Degenerate segment: a and b coincide, so the whole segment is that point.
  const t = lenSq === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const point = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
  return { point, t, miles: haversineMiles(point, p) };
}

/** Closest approach of a polyline to `p`. Ties keep the lowest segment index. */
export function closestPointOnLine(
  coords: LineCoords,
  p: LatLng,
): { point: LatLng; segmentIndex: number; miles: number } {
  if (coords.length === 0) return { point: p, segmentIndex: 0, miles: 0 };
  const first = coords[0]!;
  if (coords.length === 1) {
    const only = { lng: first[0], lat: first[1] };
    return { point: only, segmentIndex: 0, miles: haversineMiles(only, p) };
  }
  let best = { point: { lng: first[0], lat: first[1] }, segmentIndex: 0, miles: Infinity };
  for (let i = 1; i < coords.length; i++) {
    const a = { lng: coords[i - 1]![0], lat: coords[i - 1]![1] };
    const b = { lng: coords[i]![0], lat: coords[i]![1] };
    const hit = closestPointOnSegment(a, b, p);
    if (hit.miles < best.miles) best = { point: hit.point, segmentIndex: i - 1, miles: hit.miles };
  }
  return best;
}

/**
 * Closed ring approximating the disc, in GeoJSON [lng, lat] order. Built from
 * true geodesic offsets so it stays circular at any latitude; coordinates are
 * rounded to 6dp so repeated builds are byte-identical.
 */
export function circlePolygon(center: LatLng, radiusMiles: number, steps = 64): LineCoords {
  const r = Math.max(radiusMiles, 0);
  const ring: LineCoords = [];
  for (let i = 0; i < steps; i++) {
    const p = destinationPoint(center, (360 * i) / steps, r);
    ring.push([Math.round(p.lng * 1e6) / 1e6, Math.round(p.lat * 1e6) / 1e6]);
  }
  ring.push(ring[0]!);
  return ring;
}
