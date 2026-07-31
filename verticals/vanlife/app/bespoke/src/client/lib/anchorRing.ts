/**
 * Circle rings for the map, client-side.
 *
 * Persisted anchors arrive with their ring already computed by the server; this
 * is for the draft circle that follows a radius slider, where a round trip per
 * frame would be absurd. It reuses the engine's own geometry so the preview and
 * the committed anchor are the same shape, not two approximations of one.
 */

import { circlePolygon } from "../../server/engine/geo.js";

export function ringFor(
  center: { lat: number; lng: number },
  radiusMiles: number,
): [number, number][] | null {
  if (radiusMiles <= 0) return null;
  return circlePolygon(center, radiusMiles);
}
