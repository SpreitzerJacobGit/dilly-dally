/**
 * How the planner decides whether it can offer the cell signal overlay.
 *
 * The archive is built by a scheduled task on the host rather than shipped in
 * the image, so every one of these states is reachable on a real van: no
 * archive yet, an archive with no manifest, a server that cannot be reached.
 * Each has to produce an honest answer, because the alternative is a switch
 * that silently does nothing or a map that quietly claims to be current.
 */
import { describe, expect, it } from "vitest";
import { cellSignalArchive, readCellSignalManifest } from "../src/client/lib/cellSignal.js";

const installed = {
  present: true,
  archives: ["basemap.pmtiles", "cell-signal.pmtiles"],
  glyphs: true,
  sprites: true,
  manifests: {
    "cell-signal": {
      asOfDate: "2025-06-30",
      lastRun: "2026-08-01T03:30:00Z",
      lastSuccess: "2026-08-01T03:30:00Z",
      lastError: null,
    },
  },
};

describe("cellSignalArchive", () => {
  it("withholds the overlay until the server has answered", () => {
    // Not "no coverage data" — we do not know that yet, and saying so would be
    // a lie that resolves itself a second later.
    const archive = cellSignalArchive(null, false);
    expect(archive.version).toBeUndefined();
    expect(archive.unavailable).toMatch(/checking/i);
  });

  it("says the server is unreachable rather than blaming the data", () => {
    expect(cellSignalArchive(null, true).unavailable).toMatch(/van server/i);
  });

  it("names the fix when no archive is installed", () => {
    const archive = cellSignalArchive(
      { present: true, archives: ["basemap.pmtiles"], glyphs: true, sprites: true },
      true,
    );
    expect(archive.version).toBeUndefined();
    expect(archive.unavailable).toMatch(/refresh-cell-signal/);
  });

  it("offers the overlay, versioned by the FCC date, when it is installed", () => {
    const archive = cellSignalArchive(installed, true);
    expect(archive.unavailable).toBeNull();
    // The version reaches the tile URL, so a refreshed archive is not masked
    // by the browser's cache of the previous one's byte ranges.
    expect(archive.version).toBe("2025-06-30");
    expect(archive.asOf).toBe("2025-06-30");
  });

  it("still draws an archive whose manifest is missing", () => {
    // A manifest written by a PowerShell script is not a thing to bet the
    // feature on; a stable fallback version keeps the URL cacheable.
    const archive = cellSignalArchive(
      { present: true, archives: ["cell-signal.pmtiles"], glyphs: true, sprites: true },
      true,
    );
    expect(archive.unavailable).toBeNull();
    expect(archive.version).toBe("installed");
    expect(archive.asOf).toBeNull();
  });

  it("never lets a version be undefined while the overlay is on offer", () => {
    // These two travel together: undefined version means the layer is never
    // added, so offering the switch would be offering nothing.
    for (const status of [installed, { ...installed, manifests: {} }]) {
      const archive = cellSignalArchive(status, true);
      if (archive.unavailable === null) expect(archive.version).toBeDefined();
    }
  });
});

describe("readCellSignalManifest", () => {
  it("reads the fields the refresh script writes", () => {
    expect(readCellSignalManifest(installed)).toEqual({
      asOfDate: "2025-06-30",
      lastRun: "2026-08-01T03:30:00Z",
      lastSuccess: "2026-08-01T03:30:00Z",
      lastError: null,
    });
  });

  it("surfaces a recorded failure", () => {
    const failing = {
      ...installed,
      manifests: { "cell-signal": { ...installed.manifests["cell-signal"], lastError: "ogr2ogr failed." } },
    };
    expect(readCellSignalManifest(failing)?.lastError).toBe("ogr2ogr failed.");
  });

  it("is null rather than throwing on junk", () => {
    // It crosses a process boundary from a shell script; nothing but this
    // function stands between a typo there and the status page.
    expect(readCellSignalManifest(null)).toBeNull();
    expect(readCellSignalManifest({ ...installed, manifests: {} })).toBeNull();
    expect(readCellSignalManifest({ ...installed, manifests: { "cell-signal": "nonsense" } })).toBeNull();
  });

  it("treats missing and empty fields as absent, not as data", () => {
    const sparse = { ...installed, manifests: { "cell-signal": { asOfDate: "" } } };
    expect(readCellSignalManifest(sparse)).toEqual({
      asOfDate: null,
      lastRun: null,
      lastSuccess: null,
      lastError: null,
    });
  });
});
