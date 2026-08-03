import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bufferForForest,
  normalizeForestName,
  parseForestDistanceTable,
  type ForestDistanceTable,
} from "../src/server/engine/legalBuffer.js";

const TABLE: ForestDistanceTable = {
  defaultFeet: 300,
  forests: {
    "Gifford Pinchot National Forest": {
      feet: 150,
      source: "https://www.fs.usda.gov/example",
      checked: "2026-08-03",
    },
    "Uncited National Forest": { feet: 50, source: "  ", checked: "2026-08-03" },
  },
};

describe("bufferForForest", () => {
  it("uses a forest's own distance when the table has a cited one", () => {
    const b = bufferForForest(TABLE, "Gifford Pinchot National Forest");
    expect(b.feet).toBe(150);
    expect(b.confidence).toBe("verified_distance");
  });

  it("falls back to the conservative default for a forest it has never heard of", () => {
    const b = bufferForForest(TABLE, "Inyo National Forest");
    expect(b.feet).toBe(300);
    expect(b.confidence).toBe("default_buffer");
  });

  it("converts feet to metres, because the buffer is applied in a projected CRS", () => {
    expect(bufferForForest(TABLE, "Gifford Pinchot National Forest").metres).toBeCloseTo(45.72, 5);
    expect(bufferForForest(TABLE, "Inyo National Forest").metres).toBeCloseTo(91.44, 5);
  });

  it("treats an uncitable distance as an estimate rather than a verified one", () => {
    // The entry has a number, but nothing to back it up. Trusting it would let a
    // guess wear the same badge as a distance somebody actually looked up.
    const b = bufferForForest(TABLE, "Uncited National Forest");
    expect(b.feet).toBe(300);
    expect(b.confidence).toBe("default_buffer");
  });

  it("matches regardless of the casing and spacing the source data arrives with", () => {
    const b = bufferForForest(TABLE, "  gifford  pinchot   NATIONAL forest ");
    expect(b.feet).toBe(150);
    expect(b.confidence).toBe("verified_distance");
  });

  it("falls back for a segment carrying no forest name at all", () => {
    // The national dataset has such rows; they must not crash the build.
    expect(bufferForForest(TABLE, null).confidence).toBe("default_buffer");
    expect(bufferForForest(TABLE, undefined).confidence).toBe("default_buffer");
    expect(bufferForForest(TABLE, "").confidence).toBe("default_buffer");
  });
});

describe("normalizeForestName", () => {
  it("collapses whitespace and casing so table keys need not be exact", () => {
    expect(normalizeForestName("  Dixie   National Forest ")).toBe("dixie national forest");
  });
});

describe("parseForestDistanceTable", () => {
  it("rejects an entry with no source, at build time rather than on the map", () => {
    expect(() =>
      parseForestDistanceTable({
        defaultFeet: 300,
        forests: { X: { feet: 150, source: "", checked: "2026-08-03" } },
      }),
    ).toThrow(/source is required/);
  });

  it("rejects a missing or nonsensical default", () => {
    expect(() => parseForestDistanceTable({ forests: {} })).toThrow(/defaultFeet/);
    expect(() => parseForestDistanceTable({ defaultFeet: 0, forests: {} })).toThrow(/defaultFeet/);
  });

  it("rejects a checked date that is not an ISO date", () => {
    expect(() =>
      parseForestDistanceTable({
        defaultFeet: 300,
        forests: { X: { feet: 150, source: "https://example.gov", checked: "last tuesday" } },
      }),
    ).toThrow(/checked/);
  });

  it("accepts the table that actually ships, so a bad edit fails here first", () => {
    const path = fileURLToPath(new URL("../../../deploy/forest-camping-distance.json", import.meta.url));
    const table = parseForestDistanceTable(JSON.parse(fs.readFileSync(path, "utf8")));
    expect(table.defaultFeet).toBe(300);
    expect(Object.keys(table.forests).length).toBeGreaterThan(0);
    // Every shipped entry must be reachable by the lookup the build script uses.
    for (const name of Object.keys(table.forests)) {
      expect(bufferForForest(table, name).confidence).toBe("verified_distance");
    }
  });
});
