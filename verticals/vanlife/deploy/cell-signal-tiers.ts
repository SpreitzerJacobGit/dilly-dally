/**
 * Turning the FCC's mobile broadband availability filings into the four
 * numbers the map overlay draws.
 *
 * Pure functions over plain data, deliberately. The pipeline around this
 * downloads gigabytes and shells out to GDAL and tippecanoe, none of which is
 * testable in any useful sense — but the part that decides what "good LTE"
 * means is, and it is exactly the part that would be quietly wrong for a year
 * without anyone noticing, because a map with the wrong thresholds still looks
 * like a map.
 *
 * Nothing here imports h3-js: the caller supplies the cell-to-parent function.
 * That keeps the resolution policy at the call site where it is visible, and
 * keeps these functions testable without pulling in an icosahedral projection.
 */

/** Carrier keys — identical to the tile properties and the client palette. */
export type CarrierKey = "att" | "tmo" | "vzw";

export const CARRIER_KEYS: CarrierKey[] = ["att", "tmo", "vzw"];

/**
 * Carriers file under their corporate names, not their brands: AT&T's mobile
 * filings come from "New Cingular Wireless PCS", Verizon's from "Cellco
 * Partnership", and Sprint's are folded into T-Mobile post-merger.
 *
 * Matched on name rather than on the numeric provider ID because the IDs move
 * with corporate restructuring while the names are readable in the data — and
 * because an ID typo fails silently where an unmatched name is reported.
 *
 * UNVERIFIED against a real download: confirm these against the provider names
 * the FCC actually ships before trusting the output. `carrierFor` returning
 * null is the honest answer, and the build script counts what it dropped.
 */
const CARRIER_NAME_PATTERNS: { carrier: CarrierKey; pattern: RegExp }[] = [
  { carrier: "att", pattern: /\bat\s*&?\s*t\b|new cingular/i },
  { carrier: "tmo", pattern: /\bt[-\s]?mobile\b|\bsprint\b/i },
  { carrier: "vzw", pattern: /\bverizon\b|cellco/i },
];

/** Null for anyone who is not one of the three national consumer carriers. */
export function carrierFor(providerName: string): CarrierKey | null {
  for (const { carrier, pattern } of CARRIER_NAME_PATTERNS) {
    if (pattern.test(providerName)) return carrier;
  }
  return null;
}

export type Technology = "lte" | "5g";

/**
 * Recognises the technology from the FCC's own labelling, which appears both
 * in the download file names and in the availability attributes ("4G-LTE",
 * "5G-NR"). Kept textual rather than keyed on the numeric technology codes,
 * which are not stable across filing revisions.
 */
export function technologyFor(raw: string): Technology | null {
  const text = raw.toLowerCase();
  if (text.includes("5g") || text.includes("nr")) return "5g";
  if (text.includes("lte") || text.includes("4g")) return "lte";
  return null;
}

export const TIER_NONE = 0;
export const TIER_LTE_WEAK = 1;
export const TIER_LTE = 2;
export const TIER_5G = 3;
export const TIER_5G_FAST = 4;

/**
 * The FCC's own published mobile benchmarks: 5/1 Mbps for 4G LTE, and 7/1 and
 * 35/3 Mbps for 5G-NR. Coverage filed below the lower benchmark still exists —
 * it is what you get on a ridge with one bar — so it earns the weak tier
 * rather than being dropped. A dead zone and a bad signal are different
 * answers to "can I work here", and the map must not merge them.
 *
 * UNVERIFIED: confirm against the current BDC availability specification.
 */
export const GOOD_LTE_MIN_MBPS = 5;
export const FAST_5G_MIN_MBPS = 35;

export function tierFor(technology: Technology, minDownMbps: number): number {
  if (technology === "5g") {
    return minDownMbps >= FAST_5G_MIN_MBPS ? TIER_5G_FAST : TIER_5G;
  }
  return minDownMbps >= GOOD_LTE_MIN_MBPS ? TIER_LTE : TIER_LTE_WEAK;
}

/** One filed coverage claim: this carrier, this hex, this good. */
export interface CoverageObservation {
  /** H3 cell index at the resolution the FCC published. */
  cell: string;
  carrier: CarrierKey;
  tier: number;
}

/** One output feature: a hex, and what each carrier claims for it. */
export interface CoverageCell {
  cell: string;
  att: number;
  tmo: number;
  vzw: number;
  /** Max across carriers — what you get if you do not care whose SIM it is. */
  best: number;
}

/**
 * Collapses every carrier's filings onto one coarser grid.
 *
 * This is the whole reason the overlay is cheap. Because the FCC publishes on
 * H3, all three carriers land on the *same* discrete cells, so "best signal
 * available here" is a max over a group-by rather than a geometric union of
 * overlapping polygons — and one feature per hex means no two fills ever
 * overlap on the map, so there is no double-blending to design around.
 *
 * `toParent` coarsens: the published resolution is far finer than trip
 * planning needs, and keeping it would mean tens of millions of features.
 */
export function aggregate(
  observations: Iterable<CoverageObservation>,
  toParent: (cell: string) => string,
): Map<string, CoverageCell> {
  const out = new Map<string, CoverageCell>();
  for (const observation of observations) {
    const parent = toParent(observation.cell);
    let cell = out.get(parent);
    if (cell === undefined) {
      cell = { cell: parent, att: TIER_NONE, tmo: TIER_NONE, vzw: TIER_NONE, best: TIER_NONE };
      out.set(parent, cell);
    }
    // Max, not last-wins: a coarse cell covers many fine ones, and a carrier
    // that reaches any part of it reaches it. Understating coverage here would
    // send someone driving away from signal they actually have.
    if (observation.tier > cell[observation.carrier]) cell[observation.carrier] = observation.tier;
    if (observation.tier > cell.best) cell.best = observation.tier;
  }
  return out;
}

/**
 * Cells where nobody claims anything carry no information the basemap does not
 * already carry, and dropping them is most of the size saving.
 */
export function withCoverage(cells: Iterable<CoverageCell>): CoverageCell[] {
  return [...cells].filter((cell) => cell.best > TIER_NONE);
}
