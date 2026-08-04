/**
 * Builds the cell signal overlay's GeoJSON from FCC availability exports.
 *
 * Input is a directory of CSVs — attributes only, no geometry — produced by
 * running ogr2ogr over the downloaded FCC shapefiles/GeoPackages. Geometry is
 * regenerated here from the H3 index, which is enormously cheaper than
 * reprojecting and reserialising millions of source polygons.
 *
 * Output is line-delimited GeoJSON, one feature per hex, ready for tippecanoe.
 *
 *   tsx build-cell-signal.ts --in ./csv --out ./coverage.geojsonl [--parent-res 7]
 *
 * The FCC's exact column names are not documented anywhere machine-readable
 * that survived checking, so columns are detected by pattern and every
 * assumption this script makes is printed. If it cannot find a column it says
 * which one and what it saw, rather than silently emitting an empty map.
 */
import fs from "node:fs";
import path from "node:path";
import { cellToBoundary, cellToLatLng, cellToParent, getResolution } from "h3-js";
import {
  aggregate,
  carrierFor,
  CARRIER_KEYS,
  technologyFor,
  tierFor,
  withCoverage,
  type CarrierKey,
  type CoverageObservation,
} from "./cell-signal-tiers.js";

interface Args {
  in: string;
  out: string;
  parentRes: number;
  providers: string | null;
  /** Where to write the server-side lookup table, when one is wanted. */
  cellsOut: string | null;
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
    throw new Error(
      "usage: build-cell-signal.ts --in <csv dir> --out <geojsonl> [--parent-res 7] [--providers map.json] [--cells-out cell-signal-cells.json] [--as-of DATE]",
    );
  }
  return {
    in: input,
    out: output,
    // Resolution 7 is ~5 km across. The FCC publishes at 9 (~0.3 km), which
    // across the US West would be tens of millions of hexes for a layer whose
    // whole job is to say "somewhere around here works".
    parentRes: Number(get("--parent-res") ?? 7),
    providers: get("--providers"),
    cellsOut: get("--cells-out"),
    asOf: get("--as-of"),
  };
}

/** Minimal RFC4180-ish split: enough for quoted provider names with commas. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(field); field = ""; }
    else field += ch;
  }
  out.push(field);
  return out;
}

function findColumn(header: string[], pattern: RegExp): number {
  return header.findIndex((name) => pattern.test(name));
}

/**
 * Provider identity is the one field whose shape genuinely varies: some
 * exports carry a readable name, some only a numeric id or FRN. Name patterns
 * handle the first; an explicit map handles the rest. Whatever is left over is
 * reported with counts, so the first run tells you exactly what to add.
 */
function makeCarrierResolver(providersPath: string | null): {
  resolve: (raw: string) => CarrierKey | null;
  unmatched: Map<string, number>;
} {
  let explicit: Record<string, string> = {};
  if (providersPath !== null) {
    explicit = JSON.parse(fs.readFileSync(providersPath, "utf8")) as Record<string, string>;
  }
  const unmatched = new Map<string, number>();
  return {
    resolve(raw: string): CarrierKey | null {
      const mapped = explicit[raw.trim()];
      if (mapped !== undefined && CARRIER_KEYS.includes(mapped as CarrierKey)) return mapped as CarrierKey;
      const byName = carrierFor(raw);
      if (byName !== null) return byName;
      unmatched.set(raw, (unmatched.get(raw) ?? 0) + 1);
      return null;
    },
    unmatched,
  };
}

function* readObservations(
  dir: string,
  resolve: (raw: string) => CarrierKey | null,
  stats: { rows: number; skipped: number },
): Generator<CoverageObservation> {
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".csv"));
  if (files.length === 0) throw new Error(`no .csv files in ${dir}`);

  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    const lines = text.split(/\r?\n/);
    const header = splitCsvLine(lines[0] ?? "");
    const cellAt = findColumn(header, /h3/i);
    const techAt = findColumn(header, /tech/i);
    const downAt = findColumn(header, /min_?down/i);
    const providerAt = findColumn(header, /provider|brand|company|holding|frn/i);

    if (cellAt < 0) {
      throw new Error(
        `${file}: no H3 index column found (looked for /h3/i in: ${header.join(", ")}). ` +
          `Re-export with the hexagonal representation, or derive the index from polygon centroids.`,
      );
    }
    // Technology and provider fall back to the file name, which the FCC's own
    // naming carries them in — the per-technology, per-provider export means a
    // file with neither column is still unambiguous.
    const techFromName = technologyFor(file);

    for (let i = 1; i < lines.length; i++) {
      const raw = lines[i];
      if (raw === undefined || raw.trim() === "") continue;
      const row = splitCsvLine(raw);
      stats.rows++;

      const cell = (row[cellAt] ?? "").trim();
      const technology = techAt >= 0 ? technologyFor(row[techAt] ?? "") ?? techFromName : techFromName;
      const carrier = providerAt >= 0 ? resolve(row[providerAt] ?? "") : resolve(file);
      const minDown = downAt >= 0 ? Number(row[downAt]) : Number.NaN;

      if (cell === "" || technology === null || carrier === null) { stats.skipped++; continue; }
      // A missing speed is not a missing signal: the filing says coverage
      // exists, so it lands in the lowest tier for its technology rather than
      // being thrown away.
      yield { cell, carrier, tier: tierFor(technology, Number.isFinite(minDown) ? minDown : 0) };
    }
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const { resolve, unmatched } = makeCarrierResolver(args.providers);
  const stats = { rows: 0, skipped: 0 };

  let sourceRes: number | null = null;
  const toParent = (cell: string): string => {
    if (sourceRes === null) {
      sourceRes = getResolution(cell);
      console.log(`source H3 resolution: ${String(sourceRes)} → aggregating to ${String(args.parentRes)}`);
    }
    // Already coarser than the target: keep it rather than throwing, so an
    // unexpected source resolution degrades the output instead of the run.
    return getResolution(cell) <= args.parentRes ? cell : cellToParent(cell, args.parentRes);
  };

  const cells = withCoverage(aggregate(readObservations(args.in, resolve, stats), toParent).values());

  const out = fs.createWriteStream(args.out, { encoding: "utf8" });
  for (const cell of cells) {
    const ring = cellToBoundary(cell.cell, true);
    // Asked for GeoJSON order, h3-js already closes the ring. Checked rather
    // than assumed either way: closing it again duplicates the final point on
    // every one of several hundred thousand features, and not closing it at
    // all is invalid GeoJSON.
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first !== undefined && last !== undefined && (first[0] !== last[0] || first[1] !== last[1])) {
      ring.push([first[0], first[1]]);
    }
    out.write(
      `${JSON.stringify({
        type: "Feature",
        properties: { att: cell.att, tmo: cell.tmo, vzw: cell.vzw, best: cell.best },
        geometry: { type: "Polygon", coordinates: [ring] },
      })}\n`,
    );
  }
  out.end();

  // The same hexes again, as a lookup table the server can read.
  //
  // The tiles are for looking at; this is for the stay scorer, which needs to
  // ask "is there signal where we would sleep?" without a map in front of it.
  // Emitting it here rather than deriving it separately is what guarantees the
  // answer it gives and the shading you see can never disagree.
  if (args.cellsOut !== null) {
    const lookup: Record<string, number> = {};
    let s = 90;
    let w = 180;
    let n = -90;
    let e = -180;
    for (const cell of cells) {
      if (cell.best <= 0) continue; // Absence means no reported coverage; storing it would double the file.
      lookup[cell.cell] = cell.best;
      const [lat, lng] = cellToLatLng(cell.cell);
      if (lat < s) s = lat;
      if (lat > n) n = lat;
      if (lng < w) w = lng;
      if (lng > e) e = lng;
    }
    fs.writeFileSync(
      args.cellsOut,
      JSON.stringify({
        resolution: args.parentRes,
        asOf: args.asOf,
        // Padded by roughly one hex, so a point just inside the outermost cell
        // is not reported as outside the built extent.
        bbox: [s - 0.1, w - 0.1, n + 0.1, e + 0.1],
        cells: lookup,
      }),
      "utf8",
    );
    console.log(`server lookup written: ${args.cellsOut} (${String(Object.keys(lookup).length)} covered hexes)`);
  }

  console.log(`rows read: ${String(stats.rows)}, skipped: ${String(stats.skipped)}, hexes written: ${String(cells.length)}`);
  if (unmatched.size > 0) {
    // Loud on purpose. A carrier silently dropped is a map that says "no
    // service" across a state where there is service.
    console.warn(`\n${String(unmatched.size)} unrecognised provider(s) — add them to --providers to include them:`);
    for (const [name, count] of [...unmatched].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      console.warn(`  ${String(count).padStart(9)}  ${name}`);
    }
  }
  if (cells.length === 0) throw new Error("no hexes with coverage were produced — check the column detection above");
}

main();
