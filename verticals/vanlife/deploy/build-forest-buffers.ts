/**
 * Turns the curated per-forest camping-distance table into the SQL that buffers
 * and dissolves the MVUM road network, plus the provenance sidecar the app reads.
 *
 * Authored — the generator never touches this. Run through tsx by
 * prepare-legal-overlay.ps1; it is a build step, not part of the served app.
 *
 * The point of generating the SQL rather than hand-writing it is that
 * engine/legalBuffer.ts stays the only place that decides whether a distance is
 * verified or estimated. Hand-writing a CASE expression here would be a second
 * copy of that rule, free to drift from the one the tests cover.
 *
 *   pnpm tsx verticals/vanlife/deploy/build-forest-buffers.ts <outDir>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  bufferForForest,
  normalizeForestName,
  parseForestDistanceTable,
  type ForestDistanceTable,
} from "../app/bespoke/src/server/engine/legalBuffer.js";

/** Segments a van can legally drive. The dataset spells "open" lowercase; everything else is closed, blank or dirty. */
const VAN_DRIVABLE = "(PASSENGERVEHICLE = 'open' OR MOTORHOME = 'open')";

/** Matches the basemap archive's extent — see deploy/README.md. */
export const WEST_BBOX = { west: -125.5, south: 31.0, east: -102.0, north: 49.5 };

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * SQLite can lowercase and trim, but it cannot collapse internal whitespace the
 * way normalizeForestName does. Rather than let the two disagree on some future
 * key, refuse the key that would expose the difference.
 */
function assertSqlMatchable(name: string): void {
  const sqlNormalized = name.trim().toLowerCase();
  if (sqlNormalized !== normalizeForestName(name)) {
    throw new Error(
      `forest key ${JSON.stringify(name)} has repeated internal whitespace; ` +
        `SQL matching cannot reproduce it — collapse the spaces in the table`,
    );
  }
}

function caseExpression(table: ForestDistanceTable, pick: (name: string) => string, fallback: string): string {
  const names = Object.keys(table.forests);
  if (names.length === 0) return fallback;
  const arms = names
    .map((name) => `    WHEN ${sqlString(name.trim().toLowerCase())} THEN ${pick(name)}`)
    .join("\n");
  return `CASE LOWER(TRIM(FORESTNAME))\n${arms}\n    ELSE ${fallback} END`;
}

export function buildCorridorSql(table: ForestDistanceTable): string {
  for (const name of Object.keys(table.forests)) assertSqlMatchable(name);

  // Null is the "no forest" case by definition, so this is the same fallback the
  // ELSE arm stands for rather than a name picked to miss the table.
  const fallback = bufferForForest(table, null);
  const metres = caseExpression(table, (n) => bufferForForest(table, n).metres.toFixed(4), fallback.metres.toFixed(4));
  const feet = caseExpression(table, (n) => String(bufferForForest(table, n).feet), String(fallback.feet));
  const confidence = caseExpression(
    table,
    (n) => sqlString(bufferForForest(table, n).confidence),
    sqlString(fallback.confidence),
  );

  // Dissolving per forest is what the spec asks for and is also what keeps this
  // tractable: one union over a whole country's buffered roads would be a single
  // enormous GEOS operation, where per-forest is ~100 modest ones.
  //
  // The input is already in EPSG:5070, so ST_Buffer's units are metres. Buffering
  // in degrees would stretch the corridor east-west by a third at these latitudes.
  return `SELECT
  FORESTNAME AS forest,
  ${feet} AS buffer_ft,
  ${confidence} AS confidence,
  ST_Union(ST_Buffer(geometry, ${metres})) AS geometry
FROM roads
WHERE ${VAN_DRIVABLE} AND FORESTNAME IS NOT NULL
GROUP BY FORESTNAME
`;
}

export interface Provenance {
  generatedAt: string;
  coverage: typeof WEST_BBOX;
  defaultBufferFeet: number;
  verifiedForests: { forest: string; feet: number; source: string; checked: string }[];
  sources: { name: string; url: string; retrieved: string }[];
  note: string;
}

export function buildProvenance(table: ForestDistanceTable, generatedAt: string, retrieved: string): Provenance {
  return {
    generatedAt,
    coverage: WEST_BBOX,
    defaultBufferFeet: table.defaultFeet,
    verifiedForests: Object.entries(table.forests).map(([forest, e]) => ({
      forest,
      feet: e.feet,
      source: e.source,
      checked: e.checked,
    })),
    sources: [
      {
        name: "USFS Motor Vehicle Use Map: Roads (national)",
        url: "https://data.fs.usda.gov/geodata/edw/edw_resources/fc/Trans_MVUM_Road.gdb.zip",
        retrieved,
      },
      {
        name: "BLM National Surface Management Agency Area Polygons",
        url: "https://www.arcgis.com/sharing/rest/content/items/6bf2e737c59d4111be92420ee5ab0b46/data",
        retrieved,
      },
    ],
    note:
      "Advisory only. Corridors marked default_buffer use an assumed distance, not a published one. " +
      "BLM polygons are land ownership and do not account for wilderness, monument or local closures. " +
      "Always confirm against the current MVUM and local rules before camping.",
  };
}

function main(): void {
  const outDir = process.argv[2];
  if (outDir === undefined) {
    throw new Error("usage: build-forest-buffers.ts <outDir>");
  }
  // Passed in rather than read from the clock so a rebuild of the same data is
  // byte-identical, and so the date matches the download it describes.
  const retrieved = process.argv[3] ?? new Date().toISOString().slice(0, 10);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const table = parseForestDistanceTable(
    JSON.parse(fs.readFileSync(path.join(here, "forest-camping-distance.json"), "utf8")),
  );

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "usfs-corridors.sql"), buildCorridorSql(table));
  fs.writeFileSync(
    path.join(outDir, "legal-camping.json"),
    `${JSON.stringify(buildProvenance(table, new Date().toISOString(), retrieved), null, 2)}\n`,
  );

  const verified = Object.keys(table.forests).length;
  process.stdout.write(
    `wrote usfs-corridors.sql and legal-camping.json — ${verified} verified forest(s), ` +
      `${table.defaultFeet} ft default elsewhere\n`,
  );
}

// Only run when invoked directly, so the tests can import the builders above.
// pathToFileURL rather than string-building the URL: on Windows import.meta.url
// is file:///C:/... and a hand-built file://C:/... never matches it.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
