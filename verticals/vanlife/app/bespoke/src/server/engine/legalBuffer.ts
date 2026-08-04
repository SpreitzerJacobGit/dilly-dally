/**
 * How far from a designated road dispersed camping is legal, per national forest.
 *
 * The national MVUM roads dataset carries no camping-distance attribute — every
 * one of its sixty fields was checked — so this number cannot be read off the
 * source data the way the road geometry can. What exists instead is a small
 * hand-verified table plus a conservative fallback, and the difference between
 * the two is reported rather than smoothed over: a corridor built from the
 * fallback is an estimate, is labelled `default_buffer`, and is drawn as an
 * estimate on the map.
 *
 * Pure and free of I/O so the rule that decides "verified or estimated" is
 * testable without a geodatabase; the overlay build script is the only caller
 * that pairs it with real data.
 */

/** Buffers are applied in a projected CRS, so metres is the unit that actually gets used. */
const FEET_TO_METRES = 0.3048;

export type BufferConfidence = "verified_distance" | "default_buffer";

export interface ForestDistanceEntry {
  feet: number;
  /** Where the number was read from. An entry without one is not treated as verified. */
  source: string;
  /** ISO date the source was last read, so a stale table is visible as stale. */
  checked: string;
}

export interface ForestDistanceTable {
  /** Applied wherever the forest is unknown or unverified. */
  defaultFeet: number;
  /** Keyed by the MVUM dataset's FORESTNAME, verbatim. */
  forests: Record<string, ForestDistanceEntry>;
}

export interface ForestBuffer {
  feet: number;
  metres: number;
  confidence: BufferConfidence;
}

/**
 * FORESTNAME is entered per region and arrives with inconsistent casing and
 * internal spacing, so matching happens on a normalized form. The table then
 * does not have to reproduce every regional quirk to be useful.
 */
export function normalizeForestName(name: string | null | undefined): string {
  return (name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Normalized lookups, cached per table object. The build script asks about every
 * segment in the country, and rebuilding the index 150,000 times would be the
 * one part of this module slow enough to notice.
 */
const indexes = new WeakMap<ForestDistanceTable, Map<string, ForestDistanceEntry>>();

function indexOf(table: ForestDistanceTable): Map<string, ForestDistanceEntry> {
  const cached = indexes.get(table);
  if (cached) return cached;
  const built = new Map<string, ForestDistanceEntry>();
  for (const [name, entry] of Object.entries(table.forests)) {
    built.set(normalizeForestName(name), entry);
  }
  indexes.set(table, built);
  return built;
}

/** True only for an entry carrying a usable distance *and* somewhere it came from. */
function isVerified(entry: ForestDistanceEntry | undefined): entry is ForestDistanceEntry {
  return (
    entry !== undefined &&
    Number.isFinite(entry.feet) &&
    entry.feet > 0 &&
    entry.source.trim() !== ""
  );
}

/**
 * The legal camping buffer for one forest.
 *
 * A distance nobody can cite is not a verified distance: an entry with no source
 * falls back along with the unknown forests rather than borrowing the
 * credibility of the ones that are actually sourced.
 */
export function bufferForForest(
  table: ForestDistanceTable,
  forestName: string | null | undefined,
): ForestBuffer {
  const entry = indexOf(table).get(normalizeForestName(forestName));
  if (isVerified(entry)) {
    return {
      feet: entry.feet,
      metres: entry.feet * FEET_TO_METRES,
      confidence: "verified_distance",
    };
  }
  return {
    feet: table.defaultFeet,
    metres: table.defaultFeet * FEET_TO_METRES,
    confidence: "default_buffer",
  };
}

/**
 * Reads the on-disk table, rejecting a malformed one loudly.
 *
 * The build script runs unattended and writes a file the map presents as legal
 * guidance; a typo that silently emptied the table would downgrade every forest
 * to an estimate without anything saying so.
 */
export function parseForestDistanceTable(raw: unknown): ForestDistanceTable {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("forest distance table: expected an object");
  }
  const obj = raw as Record<string, unknown>;
  const defaultFeet = obj.defaultFeet;
  if (typeof defaultFeet !== "number" || !Number.isFinite(defaultFeet) || defaultFeet <= 0) {
    throw new Error("forest distance table: defaultFeet must be a positive number");
  }
  if (typeof obj.forests !== "object" || obj.forests === null) {
    throw new Error("forest distance table: forests must be an object");
  }

  const forests: Record<string, ForestDistanceEntry> = {};
  for (const [name, value] of Object.entries(obj.forests as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) {
      throw new Error(`forest distance table: ${name} must be an object`);
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.feet !== "number" || !Number.isFinite(entry.feet) || entry.feet <= 0) {
      throw new Error(`forest distance table: ${name}.feet must be a positive number`);
    }
    if (typeof entry.source !== "string" || entry.source.trim() === "") {
      throw new Error(`forest distance table: ${name}.source is required — an uncitable distance is not verified`);
    }
    if (typeof entry.checked !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.checked)) {
      throw new Error(`forest distance table: ${name}.checked must be an ISO date`);
    }
    forests[name] = { feet: entry.feet, source: entry.source, checked: entry.checked };
  }

  return { defaultFeet, forests };
}
