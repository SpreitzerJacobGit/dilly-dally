import { and, eq, type Db } from "@elements/storage-sqlite-drizzle";
import { getSetting } from "@elements/lifecycle-app-settings";
import { z } from "zod";
import { placeLookups } from "../../db/schema.js";
import type { LatLng } from "./geo.js";

/**
 * Place lookup — forward (a city, a region, a street address) and reverse
 * (a device fix to a name) — against Nominatim, from the van server.
 *
 * It runs here rather than in the browser for three reasons, in order of how
 * much they matter:
 *
 * 1. Nominatim's usage policy requires an identifying User-Agent, and a browser
 *    is forbidden from setting that header — `fetch` silently drops it. The
 *    same rule bites harder on Overpass, whose public endpoint answers a
 *    header-less request with 406 every time (see the poi-sources adapter).
 *    Server-side is the only place the header can actually be sent.
 * 2. Every answer is remembered. A place looked up with an uplink stays
 *    findable without one, which is the whole premise of the van server being
 *    the source of truth and the internet being optional.
 * 3. The one-request-per-second gate becomes one gate per van instead of one
 *    per browser tab, which is what the policy is actually asking for.
 *
 * Failures are returned, never thrown — but they are returned *as failures*.
 * An empty list is the correct answer to "no such place" and a lie about "the
 * uplink is down"; callers show the error and offer the other two ways in.
 */

const DEFAULT_ENDPOINT = "https://nominatim.openstreetmap.org";
const MIN_INTERVAL_MS = 1100;
const REQUEST_TIMEOUT_MS = 10_000;

/** How long a remembered answer is served without asking again. Places move slowly. */
const FRESH_FOR_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Overpass proved this header is load-bearing rather than decorative: without
 * it the public endpoint refuses the request outright. Nominatim is the same
 * family and the same policy, so it is set here for the same reason.
 */
const USER_AGENT = "dilly-dally-geocoder/0.1.0";

export const GEOCODER_SETTINGS_KEY = "geocoder";

export const GeocoderSettingsSchema = z.object({
  endpoint: z.string().url().default(DEFAULT_ENDPOINT),
  enabled: z.boolean().default(true),
});

export type GeocoderSettings = z.infer<typeof GeocoderSettingsSchema>;

export interface GeocodeHit {
  name: string;
  lat: number;
  lng: number;
  /** Nominatim's own bbox, used to suggest a sensible starting radius. */
  suggestedRadiusMiles: number;
}

export interface GeocodeResult {
  hits: GeocodeHit[];
  /** Non-null when the lookup could not be made at all, as opposed to finding nothing. */
  error: string | null;
  /** True when these hits came from memory after a live lookup failed. */
  stale: boolean;
}

export interface ReverseResult {
  /** Null when the fix could not be named — never a reason to discard the fix itself. */
  name: string | null;
  error: string | null;
  stale: boolean;
}

/* -------------------------------------------------------------------------- */
/* the rate gate                                                              */
/* -------------------------------------------------------------------------- */

let lastCallAt = 0;
let queue: Promise<unknown> = Promise.resolve();

/**
 * Serialises every outbound call and spaces them by MIN_INTERVAL_MS. Module
 * state on purpose: one van, one server process, one gate — which is the point
 * of moving this off the client, where each tab throttled only itself.
 */
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

/** Test seam: forget the gate so a suite does not inherit the previous test's clock. */
export function resetGeocoderGate(): void {
  lastCallAt = 0;
  queue = Promise.resolve();
}

/* -------------------------------------------------------------------------- */
/* Nominatim wire shapes                                                      */
/* -------------------------------------------------------------------------- */

interface NominatimRow {
  display_name: string;
  lat: string;
  lon: string;
  boundingbox?: [string, string, string, string];
}

/** Half the diagonal of the result's own bbox — a radius that covers what you named. */
export function radiusFromBbox(bbox: NominatimRow["boundingbox"], lat: number): number {
  if (!bbox) return 25;
  const [s, n, w, e] = [Number(bbox[0]), Number(bbox[1]), Number(bbox[2]), Number(bbox[3])];
  const latMiles = (n - s) * 69;
  const lngMiles = (e - w) * 69 * Math.cos((lat * Math.PI) / 180);
  const half = Math.hypot(latMiles, lngMiles) / 2;
  return Math.min(400, Math.max(5, Math.round(half)));
}

function rowToHit(r: NominatimRow): GeocodeHit {
  const lat = Number(r.lat);
  return {
    name: r.display_name,
    lat,
    lng: Number(r.lon),
    suggestedRadiusMiles: radiusFromBbox(r.boundingbox, lat),
  };
}

/* -------------------------------------------------------------------------- */
/* the lookup memory                                                          */
/* -------------------------------------------------------------------------- */

/** Whitespace and case are not part of what makes a query distinct. */
export function searchKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Reverse lookups are keyed at three decimal places — about 110 m, comfortably
 * finer than the town name being asked for and coarse enough that a van sitting
 * still with a jittering GPS mostly keeps hitting the same row.
 *
 * Mostly, not always: a fix sitting on a bucket boundary straddles two keys, so
 * it costs one extra lookup and then caches both. Buckets are cheap and correct
 * where a true radius would need a spatial query, and the worst case is one
 * redundant call, so the simpler thing wins.
 */
export function reverseKey(at: LatLng): string {
  return `${at.lat.toFixed(3)},${at.lng.toFixed(3)}`;
}

interface Remembered {
  hits: GeocodeHit[];
  fetchedAt: string;
}

async function recall(db: Db, kind: "search" | "reverse", key: string): Promise<Remembered | null> {
  const rows = await db
    .select()
    .from(placeLookups)
    .where(and(eq(placeLookups.kind, kind), eq(placeLookups.queryKey, key)));
  const row = rows[0];
  if (!row) return null;
  try {
    return { hits: JSON.parse(row.resultsJson) as GeocodeHit[], fetchedAt: row.fetchedAt };
  } catch {
    // A corrupted row is worth exactly nothing and should not take the lookup
    // down with it — treat it as never having been remembered.
    return null;
  }
}

async function remember(db: Db, kind: "search" | "reverse", key: string, hits: GeocodeHit[]): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(placeLookups)
    .values({ kind, queryKey: key, resultsJson: JSON.stringify(hits), fetchedAt: now })
    .onConflictDoUpdate({
      target: [placeLookups.kind, placeLookups.queryKey],
      set: { resultsJson: JSON.stringify(hits), fetchedAt: now },
    });
}

function isFresh(fetchedAt: string): boolean {
  const at = Date.parse(fetchedAt);
  return Number.isFinite(at) && Date.now() - at < FRESH_FOR_MS;
}

/* -------------------------------------------------------------------------- */
/* the outbound call                                                          */
/* -------------------------------------------------------------------------- */

async function settings(db: Db): Promise<GeocoderSettings> {
  try {
    const rec = await getSetting(db, GEOCODER_SETTINGS_KEY, GeocoderSettingsSchema);
    return rec?.value ?? { endpoint: DEFAULT_ENDPOINT, enabled: true };
  } catch {
    // A corrupted setting must not make place search look like a network
    // outage; fall back to the defaults and let the settings screen show it.
    return { endpoint: DEFAULT_ENDPOINT, enabled: true };
  }
}

async function callNominatim(endpoint: string, path: string, params: URLSearchParams): Promise<NominatimRow[]> {
  return throttled(async () => {
    const url = `${endpoint.replace(/\/$/, "")}/${path}?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`place search returned ${String(res.status)}`);
    const body: unknown = await res.json();
    // /search answers with an array, /reverse with a single object.
    return Array.isArray(body) ? (body as NominatimRow[]) : [body as NominatimRow];
  });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : "place search unreachable";
}

/* -------------------------------------------------------------------------- */
/* the two entry points                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A city, a region, or a street address — Nominatim's free-text search handles
 * all three, so the caller never has to say which one it is typing.
 */
export async function searchPlaces(
  db: Db,
  query: string,
  opts?: { limit?: number; near?: LatLng },
): Promise<GeocodeResult> {
  const key = searchKey(query);
  if (key.length < 3) return { hits: [], error: null, stale: false };

  const known = await recall(db, "search", key);
  if (known && isFresh(known.fetchedAt)) return { hits: known.hits, error: null, stale: false };

  const cfg = await settings(db);
  if (!cfg.enabled) {
    return known
      ? { hits: known.hits, error: null, stale: true }
      : { hits: [], error: "place search is turned off", stale: false };
  }

  const params = new URLSearchParams({
    q: key,
    format: "json",
    limit: String(opts?.limit ?? 5),
    addressdetails: "0",
  });
  // Bias toward where the van actually is, so "Springfield" ranks the one
  // twenty miles away above the one two thousand miles away.
  if (opts?.near) params.set("viewbox", viewboxAround(opts.near));

  try {
    const rows = await callNominatim(cfg.endpoint, "search", params);
    const hits = rows.map(rowToHit);
    await remember(db, "search", key, hits);
    return { hits, error: null, stale: false };
  } catch (err) {
    // Falling back to a remembered answer is the difference between "we are
    // offline" and "that place does not exist".
    if (known) return { hits: known.hits, error: null, stale: true };
    return { hits: [], error: describe(err), stale: false };
  }
}

/** A degree-ish box around the van — enough to bias ranking, not to filter. */
function viewboxAround(at: LatLng): string {
  const pad = 1.5;
  return [at.lng - pad, at.lat + pad, at.lng + pad, at.lat - pad].map((n) => n.toFixed(4)).join(",");
}

/**
 * Name a coordinate. A failure here is cosmetic by design: the caller already
 * holds a perfectly good fix and only wanted something friendlier to show.
 */
export async function reversePlace(db: Db, at: LatLng): Promise<ReverseResult> {
  const key = reverseKey(at);

  const known = await recall(db, "reverse", key);
  if (known && isFresh(known.fetchedAt)) {
    return { name: known.hits[0]?.name ?? null, error: null, stale: false };
  }

  const cfg = await settings(db);
  if (!cfg.enabled) {
    return known
      ? { name: known.hits[0]?.name ?? null, error: null, stale: true }
      : { name: null, error: "place search is turned off", stale: false };
  }

  const params = new URLSearchParams({
    lat: String(at.lat),
    lon: String(at.lng),
    format: "json",
    zoom: "14", // town / suburb level — "Bishop, CA", not a house number.
  });

  try {
    const rows = await callNominatim(cfg.endpoint, "reverse", params);
    const hit = rows[0] && rows[0].display_name ? rowToHit(rows[0]) : null;
    if (!hit) return { name: null, error: null, stale: false };
    await remember(db, "reverse", key, [hit]);
    return { name: hit.name, error: null, stale: false };
  } catch (err) {
    if (known) return { name: known.hits[0]?.name ?? null, error: null, stale: true };
    return { name: null, error: describe(err), stale: false };
  }
}
