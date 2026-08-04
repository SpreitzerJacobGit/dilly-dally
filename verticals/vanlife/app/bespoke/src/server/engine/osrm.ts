import type { LatLng, LineCoords } from "./geo.js";

/**
 * Thin typed client for the OSRM sidecar. No business logic. Every failure to
 * reach or parse becomes OsrmUnavailableError so callers can degrade honestly
 * (serve the stale plan, say so) instead of crashing or pretending.
 */

const OSRM_URL = (process.env.OSRM_URL ?? "http://osrm:5000").replace(/\/$/, "");

export class OsrmUnavailableError extends Error {
  constructor(detail: string) {
    super(`Route computation unavailable: ${detail}`);
    this.name = "OsrmUnavailableError";
  }
}

export interface OsrmRoute {
  durationMinutes: number;
  distanceMiles: number;
  /** GeoJSON LineString coordinates ([lng, lat]). */
  geometry: LineCoords;
  legs: { durationMinutes: number; distanceMiles: number }[];
}

interface OsrmRouteResponse {
  code: string;
  routes?: {
    duration: number;
    distance: number;
    geometry: { coordinates: [number, number][] };
    legs: { duration: number; distance: number }[];
  }[];
}

function coordPath(coords: LatLng[]): string {
  return coords.map((c) => `${String(c.lng)},${String(c.lat)}`).join(";");
}

async function osrmFetch(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new OsrmUnavailableError(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) throw new OsrmUnavailableError(`router responded ${String(res.status)}`);
  return res.json();
}

export async function osrmRoute(
  coords: LatLng[],
  opts?: { overview?: "full" | "simplified" | "false" },
): Promise<OsrmRoute> {
  if (coords.length < 2) throw new OsrmUnavailableError("need at least two coordinates");
  const overview = opts?.overview ?? "full";
  const url = `${OSRM_URL}/route/v1/driving/${coordPath(coords)}?overview=${overview}&geometries=geojson&steps=false`;
  const data = (await osrmFetch(url)) as OsrmRouteResponse;
  const route = data.routes?.[0];
  if (data.code !== "Ok" || !route) throw new OsrmUnavailableError(`router said ${data.code}`);
  return {
    durationMinutes: route.duration / 60,
    distanceMiles: route.distance / 1609.34,
    geometry: overview === "false" ? [] : route.geometry.coordinates,
    legs: route.legs.map((l) => ({ durationMinutes: l.duration / 60, distanceMiles: l.distance / 1609.34 })),
  };
}

export interface OsrmTable {
  /** durations[i][j] in minutes. */
  durations: number[][];
  distances: number[][];
}

interface OsrmTableResponse {
  code: string;
  durations?: (number | null)[][];
  distances?: (number | null)[][];
}

/**
 * Distance/duration matrix.
 *
 * `sources` and `destinations` are indices into `coords`. Passing them turns a
 * square matrix into the thin strip a caller usually wants — the stay scorer
 * needs "position → every candidate stay" and "every candidate stay → tomorrow's
 * first point", which is two strips rather than one N×N table. Omit both for the
 * full square, which is what needSearch does.
 */
export async function osrmTable(
  coords: LatLng[],
  opts?: { sources?: number[]; destinations?: number[] },
): Promise<OsrmTable> {
  if (coords.length < 2) throw new OsrmUnavailableError("need at least two coordinates");
  const params = ["annotations=duration,distance"];
  if (opts?.sources) params.push(`sources=${opts.sources.join(";")}`);
  if (opts?.destinations) params.push(`destinations=${opts.destinations.join(";")}`);
  const url = `${OSRM_URL}/table/v1/driving/${coordPath(coords)}?${params.join("&")}`;
  const data = (await osrmFetch(url)) as OsrmTableResponse;
  if (data.code !== "Ok" || !data.durations || !data.distances) {
    throw new OsrmUnavailableError(`router said ${data.code}`);
  }
  const bigNumber = 1e9;
  return {
    durations: data.durations.map((row) => row.map((v) => (v === null ? bigNumber : v / 60))),
    distances: data.distances.map((row) => row.map((v) => (v === null ? bigNumber : v / 1609.34))),
  };
}
