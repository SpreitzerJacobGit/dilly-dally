/**
 * Which tile archives the server actually has.
 *
 * The basemap and the legal-camping overlay are separate PMTiles files on the
 * same volume, and either can be absent — the volumes are provisioned out of
 * band, so "not installed yet" is an ordinary state rather than a fault. The map
 * asks before pointing the style at an archive, and the legend asks before
 * offering a switch for a layer that cannot draw. Offering the switch anyway
 * would be the same lie as showing category checkboxes over a set of places the
 * filter does not apply to.
 *
 * Asking is also the only reliable test. A missing file under /tiles does not
 * 404: it reaches the SPA's not-found handler and comes back as index.html with
 * a 200, which would reach MapLibre as a corrupt archive rather than an absent
 * one. This listing is the difference between "not installed" and "broken".
 *
 * The request is shared: several components ask the same question on the same
 * screen, and this is a file listing that changes only when someone re-runs the
 * data prep.
 */
import { useEffect, useState } from "react";

interface TileStatus {
  archives?: string[];
}

let inflight: Promise<string[]> | null = null;

function archives(): Promise<string[]> {
  if (inflight === null) {
    inflight = fetch("/tiles/status")
      .then((r) => (r.ok ? (r.json() as Promise<TileStatus>) : Promise.reject(new Error(String(r.status)))))
      .then((s) => s.archives ?? [])
      // The status endpoint lives on the same server as the tiles themselves, so
      // if it cannot be reached the archives cannot be either. Absent, not broken.
      .catch(() => []);
  }
  return inflight;
}

/** Forces the next ask to hit the server again. For tests and for a status-page refresh. */
export function resetTileArchiveCache(): void {
  inflight = null;
}

/**
 * Null while unknown, so a caller can tell "still asking" from "definitely not
 * there" and avoid flashing a control on and then off again.
 */
export function useTileArchivePresent(archive: string): boolean | null {
  const [present, setPresent] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void archives().then((list) => {
      if (!cancelled) setPresent(list.includes(archive));
    });
    return () => {
      cancelled = true;
    };
  }, [archive]);
  return present;
}
