import { describe, expect, it } from "vitest";
import { buildCorridorSql, buildProvenance, WEST_BBOX } from "../../../deploy/build-forest-buffers.js";
import type { ForestDistanceTable } from "../src/server/engine/legalBuffer.js";

const TABLE: ForestDistanceTable = {
  defaultFeet: 300,
  forests: {
    "Gifford Pinchot National Forest": {
      feet: 150,
      source: "https://www.fs.usda.gov/example",
      checked: "2026-08-03",
    },
  },
};

describe("buildCorridorSql", () => {
  const sql = buildCorridorSql(TABLE);

  it("buffers a verified forest at its own distance, in metres", () => {
    // 150 ft. Buffering happens in EPSG:5070, so the units must be metres.
    expect(sql).toContain("'gifford pinchot national forest' THEN 45.7200");
  });

  it("buffers everything else at the default, and labels it an estimate", () => {
    expect(sql).toContain("ELSE 91.4400");
    expect(sql).toContain("ELSE 'default_buffer'");
    expect(sql).toContain("'gifford pinchot national forest' THEN 'verified_distance'");
  });

  it("keeps only segments a van may legally drive", () => {
    expect(sql).toContain("PASSENGERVEHICLE = 'open' OR MOTORHOME = 'open'");
  });

  it("dissolves per forest, which is both the legal unit and what keeps GEOS tractable", () => {
    expect(sql).toContain("ST_Union(ST_Buffer(");
    expect(sql).toContain("GROUP BY FORESTNAME");
  });

  it("matches case-insensitively, because the national dataset is not consistent", () => {
    expect(sql).toContain("LOWER(TRIM(FORESTNAME))");
  });

  it("escapes a quote in a forest name rather than breaking out of the string", () => {
    const sqlWithQuote = buildCorridorSql({
      defaultFeet: 300,
      forests: { "O'Hara National Forest": { feet: 150, source: "https://x.gov", checked: "2026-08-03" } },
    });
    expect(sqlWithQuote).toContain("'o''hara national forest'");
  });

  it("refuses a key whose whitespace SQL cannot reproduce", () => {
    // LOWER(TRIM()) cannot collapse an internal double space the way the
    // TypeScript lookup does, so such a key would match in one and not the
    // other — a forest silently buffered at the wrong distance.
    expect(() =>
      buildCorridorSql({
        defaultFeet: 300,
        forests: { "Double  Space Forest": { feet: 150, source: "https://x.gov", checked: "2026-08-03" } },
      }),
    ).toThrow(/whitespace/);
  });

  it("emits no arms at all when nothing is verified, leaving one honest fallback", () => {
    const bare = buildCorridorSql({ defaultFeet: 300, forests: {} });
    expect(bare).not.toContain("WHEN");
    expect(bare).toContain("'default_buffer'");
  });
});

describe("buildProvenance", () => {
  const p = buildProvenance(TABLE, "2026-08-03T12:00:00.000Z", "2026-07-09");

  it("records the coverage the archive actually has", () => {
    expect(p.coverage).toEqual(WEST_BBOX);
  });

  it("carries each verified distance with the page it was read from", () => {
    expect(p.verifiedForests).toEqual([
      {
        forest: "Gifford Pinchot National Forest",
        feet: 150,
        source: "https://www.fs.usda.gov/example",
        checked: "2026-08-03",
      },
    ]);
  });

  it("states the assumed distance and that the layer is advisory", () => {
    expect(p.defaultBufferFeet).toBe(300);
    expect(p.note).toMatch(/[Aa]dvisory/);
    expect(p.note).toMatch(/default_buffer/);
  });

  it("names both upstream datasets with the date they were retrieved", () => {
    expect(p.sources).toHaveLength(2);
    for (const s of p.sources) {
      expect(s.retrieved).toBe("2026-07-09");
      expect(s.url).toMatch(/^https:\/\//);
    }
  });
});
