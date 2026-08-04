import fs from "node:fs";
import path from "node:path";
import { latLngToCell } from "h3-js";

/**
 * Server-side lookup of the two overlays that were previously write-only to the
 * map: FCC mobile coverage and BLM/USFS camping legality.
 *
 * Both already exist as PMTiles archives, and both were unreachable from the
 * scoring engine — a stay could be shaded green on screen while the planner had
 * no idea. The fix reuses the grid the coverage pipeline already computes: the
 * FCC publishes on H3, the build aggregates to resolution 7, and rasterizing the
 * legal polygons onto that same grid makes both lookups one O(1) hash join.
 *
 * The artifacts are optional and prepared out of band, exactly like the tile
 * archives they accompany. An installation without them gets `installed: false`
 * everywhere — never a fabricated zero, because "no coverage" and "we never
 * built the coverage file" are different facts and only one of them should
 * change a plan.
 *
 * Rasterizing polygons to hexes is approximate at the boundary. That is
 * tolerable only because the legal overlay is advisory by contract (LEGAL-3),
 * and every consumer of `legalityAt` is expected to say so.
 */

const TILES_DIR = process.env.TILES_DIR ?? "/data/tiles";

export const HEX_RESOLUTION = 7;

/** Bit flags in the legality artifact — separate bits so the two regimes stay auditable. */
export const LEGAL_BLM = 1;
export const LEGAL_USFS_VERIFIED = 2;
export const LEGAL_USFS_DEFAULT_BUFFER = 4;

interface HexArtifact {
  resolution: number;
  asOf: string | null;
  /** [S, W, N, E] — the extent the artifact was built over. */
  bbox: [number, number, number, number];
  cells: Record<string, number>;
}

type ArtifactState =
  | { status: "absent" }
  | { status: "error"; error: string }
  | { status: "loaded"; artifact: HexArtifact };

const cache = new Map<string, ArtifactState>();

/** Tests and the status endpoint both need to force a re-read after a rebuild. */
export function resetHexCache(): void {
  cache.clear();
}

function load(file: string): ArtifactState {
  const cached = cache.get(file);
  if (cached) return cached;
  const full = path.join(TILES_DIR, file);
  let state: ArtifactState;
  try {
    if (!fs.existsSync(full)) {
      state = { status: "absent" };
    } else {
      const parsed = JSON.parse(fs.readFileSync(full, "utf8")) as HexArtifact;
      if (typeof parsed.resolution !== "number" || typeof parsed.cells !== "object") {
        state = { status: "error", error: `${file} is not a hex artifact` };
      } else {
        state = { status: "loaded", artifact: parsed };
      }
    }
  } catch (err) {
    state = { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
  cache.set(file, state);
  return state;
}

function withinBbox(bbox: [number, number, number, number], lat: number, lng: number): boolean {
  const [s, w, n, e] = bbox;
  return lat >= s && lat <= n && lng >= w && lng <= e;
}

export interface HexReading {
  /** False when the artifact was never built — the value is then meaningless. */
  installed: boolean;
  /**
   * Null means honestly unknown: either the artifact is missing, or the point
   * lies outside the extent it was built over. A present artifact with no entry
   * for an in-extent hex is a real zero, not an unknown.
   */
  value: number | null;
  error: string | null;
}

function readHex(file: string, lat: number, lng: number): HexReading {
  const state = load(file);
  if (state.status === "absent") return { installed: false, value: null, error: null };
  if (state.status === "error") return { installed: false, value: null, error: state.error };
  const { artifact } = state;
  if (!withinBbox(artifact.bbox, lat, lng)) return { installed: true, value: null, error: null };
  const cell = latLngToCell(lat, lng, artifact.resolution);
  return { installed: true, value: artifact.cells[cell] ?? 0, error: null };
}

/**
 * Best mobile tier of any carrier at a point, 0–4 (0 = no reported coverage).
 * "Best of any carrier" is the right question for a couple who work from the
 * van and carry more than one SIM.
 */
export function signalAt(lat: number, lng: number): HexReading {
  return readHex("cell-signal-cells.json", lat, lng);
}

export interface LegalityReading extends HexReading {
  blm: boolean;
  usfs: boolean;
  /** True when the only USFS claim here rests on the assumed corridor width. */
  usfsAssumedWidth: boolean;
}

/** Whether dispersed camping is indicated at a point, and under which regime. */
export function legalityAt(lat: number, lng: number): LegalityReading {
  const reading = readHex("legal-land-cells.json", lat, lng);
  const bits = reading.value ?? 0;
  return {
    ...reading,
    blm: (bits & LEGAL_BLM) !== 0,
    usfs: (bits & (LEGAL_USFS_VERIFIED | LEGAL_USFS_DEFAULT_BUFFER)) !== 0,
    usfsAssumedWidth: (bits & LEGAL_USFS_DEFAULT_BUFFER) !== 0 && (bits & LEGAL_USFS_VERIFIED) === 0,
  };
}

export interface HexArtifactStatus {
  file: string;
  installed: boolean;
  asOf: string | null;
  cells: number | null;
  error: string | null;
}

/** For the status screen: what got built, when, and what broke — never a guess. */
export function hexArtifactStatuses(): HexArtifactStatus[] {
  return ["cell-signal-cells.json", "legal-land-cells.json"].map((file) => {
    const state = load(file);
    if (state.status === "loaded") {
      return {
        file,
        installed: true,
        asOf: state.artifact.asOf,
        cells: Object.keys(state.artifact.cells).length,
        error: null,
      };
    }
    return {
      file,
      installed: false,
      asOf: null,
      cells: null,
      error: state.status === "error" ? state.error : null,
    };
  });
}
