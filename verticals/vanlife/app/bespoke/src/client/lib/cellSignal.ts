/**
 * What the van server has installed for the cell signal overlay.
 *
 * The archive is built by a scheduled refresh on the host rather than shipped
 * in the image, so "not installed yet" is an ordinary state on a fresh van and
 * not a fault. Both that and the opposite — a refresh that has been quietly
 * failing since March — are read from the manifest the refresh script writes
 * beside the archive, because a stale overlay that looks current is worse than
 * an absent one.
 */
import { useEffect, useState } from "react";

const ARCHIVE = "cell-signal.pmtiles";
const MANIFEST = "cell-signal";

export interface CellSignalManifest {
  asOfDate: string | null;
  lastRun: string | null;
  lastSuccess: string | null;
  lastError: string | null;
}

/** The shape of /tiles/status this app cares about. */
export interface TilesStatus {
  present: boolean;
  archives: string[];
  glyphs: boolean;
  sprites: boolean;
  manifests?: Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Narrows the deliberately untyped sidecar the tile plugin hands back. It is
 * written by a PowerShell script on the host, so nothing but this function
 * stands between a typo there and the rest of the app.
 */
export function readCellSignalManifest(status: TilesStatus | null): CellSignalManifest | null {
  const raw = status?.manifests?.[MANIFEST];
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const manifest = raw as Record<string, unknown>;
  return {
    asOfDate: str(manifest.asOfDate),
    lastRun: str(manifest.lastRun),
    lastSuccess: str(manifest.lastSuccess),
    lastError: str(manifest.lastError),
  };
}

export interface CellSignalArchive {
  /**
   * Feeds the tile URL. Undefined keeps the overlay off the map entirely,
   * which is what "not installed" and "not known yet" both have to mean — a
   * source pointed at a missing archive spends the tile budget on 404s.
   */
  version: string | undefined;
  /** Why the overlay cannot be offered, or null when it can. */
  unavailable: string | null;
  asOf: string | null;
}

/**
 * Pure so the states that are awkward to reach in a browser — server
 * unreachable, archive present but manifest missing — are reachable in a test.
 */
export function cellSignalArchive(status: TilesStatus | null, loaded: boolean): CellSignalArchive {
  if (!loaded) {
    return { version: undefined, unavailable: "Checking for coverage data…", asOf: null };
  }
  if (status === null) {
    return { version: undefined, unavailable: "Cannot reach the van server.", asOf: null };
  }
  if (!status.archives.includes(ARCHIVE)) {
    return {
      version: undefined,
      unavailable: "No coverage data installed — run refresh-cell-signal.ps1 on the van server.",
      asOf: null,
    };
  }
  const manifest = readCellSignalManifest(status);
  return {
    // An archive with no readable manifest still draws; it just cannot say how
    // old it is. The constant fallback keeps the tile URL stable so the
    // browser can still cache byte ranges across a reload.
    version: manifest?.asOfDate ?? "installed",
    unavailable: null,
    asOf: manifest?.asOfDate ?? null,
  };
}

export function useCellSignalArchive(): CellSignalArchive {
  const [status, setStatus] = useState<TilesStatus | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Asked once. The archive is replaced at most a couple of times a year by a
  // scheduled task, so polling it would be all cost and no news.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/tiles/status");
        const body = res.ok ? ((await res.json()) as TilesStatus) : null;
        if (!cancelled) setStatus(body);
      } catch {
        // Offline is the normal case in a van, not an error worth throwing.
        if (!cancelled) setStatus(null);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return cellSignalArchive(status, loaded);
}
