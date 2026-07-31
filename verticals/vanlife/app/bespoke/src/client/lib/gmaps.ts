/**
 * Google Maps handoff — the planning layer's one exit into navigation.
 * Origin is deliberately omitted: the Maps app uses the device's current
 * location, which in the van is always right. Universal Map URLs cap
 * waypoints at 9, so longer legs split into parts; each part's destination
 * becomes the next part's implicit start once you arrive.
 */

export interface HandoffStop {
  lat: number;
  lng: number;
}

const MAX_WAYPOINTS = 9;

function coord(s: HandoffStop): string {
  return `${String(s.lat)},${String(s.lng)}`;
}

function url(destination: HandoffStop, waypoints: HandoffStop[]): string {
  const params = new URLSearchParams({
    api: "1",
    destination: coord(destination),
    travelmode: "driving",
  });
  if (waypoints.length > 0) params.set("waypoints", waypoints.map(coord).join("|"));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/** One URL per ≤(9 waypoints + destination) chunk, in driving order. */
export function buildHandoffUrls(stops: HandoffStop[]): string[] {
  if (stops.length === 0) return [];
  const urls: string[] = [];
  for (let i = 0; i < stops.length; i += MAX_WAYPOINTS + 1) {
    const chunk = stops.slice(i, i + MAX_WAYPOINTS + 1);
    urls.push(url(chunk[chunk.length - 1]!, chunk.slice(0, -1)));
  }
  return urls;
}

export function nextStopUrl(stop: HandoffStop): string {
  return url(stop, []);
}
