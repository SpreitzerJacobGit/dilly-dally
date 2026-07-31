/**
 * Place-name lookup for Target authoring, via Nominatim.
 *
 * Same OSM family as the Overpass place data, and keyless. Its usage policy
 * asks for an identifying User-Agent and no more than one request a second, so
 * calls are serialised behind a shared gate rather than fired per keystroke —
 * the caller is expected to debounce as well.
 *
 * Failures are returned, never thrown — but they are returned *as failures*.
 * This is the one lookup in the app that leaves the van, and an empty list is
 * the correct answer to "no such place" and a lie about "the uplink is down".
 * Callers are expected to show the error and offer coordinates instead.
 */

const ENDPOINT = "https://nominatim.openstreetmap.org/search";
const MIN_INTERVAL_MS = 1100;

export interface GeocodeHit {
  name: string;
  lat: number;
  lng: number;
  /** Nominatim's own bbox, used to suggest a sensible starting radius. */
  suggestedRadiusMiles: number;
}

let lastCallAt = 0;
let queue: Promise<unknown> = Promise.resolve();

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    return fn();
  });
  queue = run.catch(() => undefined);
  return run;
}

interface NominatimRow {
  display_name: string;
  lat: string;
  lon: string;
  boundingbox?: [string, string, string, string];
}

/** Half the diagonal of the result's own bbox — a radius that covers what you named. */
function radiusFromBbox(bbox: NominatimRow["boundingbox"], lat: number): number {
  if (!bbox) return 25;
  const [s, n, w, e] = [Number(bbox[0]), Number(bbox[1]), Number(bbox[2]), Number(bbox[3])];
  const latMiles = (n - s) * 69;
  const lngMiles = (e - w) * 69 * Math.cos((lat * Math.PI) / 180);
  const half = Math.hypot(latMiles, lngMiles) / 2;
  return Math.min(400, Math.max(5, Math.round(half)));
}

export interface GeocodeResult {
  hits: GeocodeHit[];
  /** Non-null when the lookup could not be made at all, as opposed to finding nothing. */
  error: string | null;
}

export async function geocode(query: string, limit = 5): Promise<GeocodeResult> {
  const q = query.trim();
  if (q.length < 3) return { hits: [], error: null };
  try {
    return await throttled(async () => {
      const url = `${ENDPOINT}?q=${encodeURIComponent(q)}&format=json&limit=${String(limit)}`;
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { hits: [], error: `place search returned ${String(res.status)}` };
      const rows = (await res.json()) as NominatimRow[];
      return {
        hits: rows.map((r) => {
          const lat = Number(r.lat);
          return {
            name: r.display_name,
            lat,
            lng: Number(r.lon),
            suggestedRadiusMiles: radiusFromBbox(r.boundingbox, lat),
          };
        }),
        error: null,
      };
    });
  } catch (err) {
    return { hits: [], error: err instanceof Error ? err.message : "place search unreachable" };
  }
}
