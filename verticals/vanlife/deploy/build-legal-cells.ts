/**
 * Rasterises the legal-camping polygons onto the same H3 grid the coverage
 * overlay already uses, so the stay scorer can ask "is dispersed camping
 * indicated here?" without a map in front of it.
 *
 *   tsx build-legal-cells.ts --in legal_combined.geojson --out legal-land-cells.json [--res 7]
 *
 * Why a hex grid rather than exact point-in-polygon: the coverage pipeline
 * already computes on H3, the server already carries h3-js for it, and a hash
 * lookup costs nothing on every replan where a polygon test would cost a
 * spatial index this application does not have.
 *
 * The cost is honesty about the boundary. A res-7 hex is roughly 5 km across, so
 * a cell is claimed as BLM if any part of it is, and land within a few km of a
 * boundary can be marked either way. That is tolerable ONLY because the overlay
 * is advisory by contract (LEGAL-3) and every consumer says so; it is not a
 * property line and must never be presented as one.
 *
 * Bits are kept separate rather than merged into one "legal" flag, for the same
 * reason the two tile layers are separate: BLM ownership and a USFS road
 * corridor are different legal regimes, and a merged boolean cannot be audited.
 */
import fs from "node:fs";
import { polygonToCells } from "h3-js";

const LEGAL_BLM = 1;
const LEGAL_USFS_VERIFIED = 2;
const LEGAL_USFS_DEFAULT_BUFFER = 4;

interface Args {
  in: string;
  out: string;
  res: number;
  asOf: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? (argv[i + 1] ?? null) : null;
  };
  const input = get("--in");
  const output = get("--out");
  if (input === null || output === null) {
    throw new Error("usage: build-legal-cells.ts --in <geojson> --out <json> [--res 7] [--as-of DATE]");
  }
  // Must match HEX_RESOLUTION in server/engine/hexLookup.ts, and the coverage
  // build's --parent-res, or the two overlays index different grids.
  return { in: input, out: output, res: Number(get("--res") ?? 7), asOf: get("--as-of") };
}

interface Feature {
  properties?: Record<string, unknown> | null;
  geometry?: { type: string; coordinates: unknown } | null;
}

/** GeoJSON is [lng, lat]; h3-js polygonToCells with `true` reads it that way. */
function polygonsOf(geometry: { type: string; coordinates: unknown }): number[][][][] {
  if (geometry.type === "Polygon") return [geometry.coordinates as number[][][]];
  if (geometry.type === "MultiPolygon") return geometry.coordinates as number[][][][];
  return [];
}

function bitFor(props: Record<string, unknown> | null | undefined): number {
  const layer = String(props?.layer ?? props?.["ogr_layer_name"] ?? "").toLowerCase();
  if (layer.includes("blm")) return LEGAL_BLM;
  const confidence = String(props?.confidence ?? "").toLowerCase();
  return confidence === "verified_distance" ? LEGAL_USFS_VERIFIED : LEGAL_USFS_DEFAULT_BUFFER;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const collection = JSON.parse(fs.readFileSync(args.in, "utf8")) as { features?: Feature[] };
  const features = collection.features ?? [];
  if (features.length === 0) throw new Error(`${args.in} has no features`);

  const cells: Record<string, number> = {};
  let s = 90;
  let w = 180;
  let n = -90;
  let e = -180;

  for (const feature of features) {
    if (!feature.geometry) continue;
    const bit = bitFor(feature.properties);
    for (const polygon of polygonsOf(feature.geometry)) {
      // polygonToCells takes [outerRing, ...holes]; holes are respected, which
      // matters for inholdings punched out of a forest boundary.
      const covered = polygonToCells(polygon, args.res, true);
      for (const cell of covered) cells[cell] = (cells[cell] ?? 0) | bit;
      for (const ring of polygon) {
        for (const point of ring) {
          const lng = point[0]!;
          const lat = point[1]!;
          if (lat < s) s = lat;
          if (lat > n) n = lat;
          if (lng < w) w = lng;
          if (lng > e) e = lng;
        }
      }
    }
  }

  const total = Object.keys(cells).length;
  if (total === 0) {
    // An empty file would read as "nowhere is legal", which is exactly the
    // reading LEGAL-3 forbids. Better to fail the build.
    throw new Error("no cells produced — check the input geometry and --res");
  }

  fs.writeFileSync(
    args.out,
    JSON.stringify({
      resolution: args.res,
      asOf: args.asOf,
      bbox: [s - 0.1, w - 0.1, n + 0.1, e + 0.1],
      cells,
    }),
    "utf8",
  );

  const blm = Object.values(cells).filter((v) => (v & LEGAL_BLM) !== 0).length;
  const usfsVerified = Object.values(cells).filter((v) => (v & LEGAL_USFS_VERIFIED) !== 0).length;
  const usfsAssumed = Object.values(cells).filter(
    (v) => (v & LEGAL_USFS_DEFAULT_BUFFER) !== 0 && (v & LEGAL_USFS_VERIFIED) === 0,
  ).length;
  console.log(
    `${args.out}: ${String(total)} cells at res ${String(args.res)} — ` +
      `${String(blm)} BLM, ${String(usfsVerified)} USFS (published distance), ${String(usfsAssumed)} USFS (assumed distance)`,
  );
}

main();
