/**
 * Browser-local preferences.
 *
 * Every localStorage key in the app is named here exactly once. Key strings are
 * one of the two things typecheck cannot see (CSS class names are the other),
 * so a typo in a key is a silent loss of state rather than a build failure —
 * which is why they do not get to live inline at their call sites.
 *
 * Nothing here is user-scoped except where the key says so. Trips are not
 * per-user either: two co-equal operators share one van and one plan.
 */

const VIEWED_TRIP = "vl.viewedTripId";
const DIGEST_DISMISSED = (userKey: string): string => `vl.digestDismissed.${userKey}`;
/** Check-ins recorded with no uplink, waiting to be replayed. */
export const CHECKIN_QUEUE_KEY = "vl.checkinQueue";
const POI_CATEGORIES_HIDDEN = "vl.poiCategoriesHidden";
const LEGAL_LAYERS_HIDDEN = "vl.legalLayersHidden";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Private mode, or storage disabled. A lost preference is not worth a crash.
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* see read() */
  }
}

/** Which trip the planning screen is showing — not which trip is active. */
export function readViewedTripId(): number | null {
  const raw = read(VIEWED_TRIP);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

export function writeViewedTripId(id: number | null): void {
  write(VIEWED_TRIP, id === null ? null : String(id));
}

export function readDigestDismissed(userKey: string): string | null {
  return read(DIGEST_DISMISSED(userKey));
}

export function writeDigestDismissed(userKey: string, date: string): void {
  write(DIGEST_DISMISSED(userKey), date);
}

/**
 * Which place categories the legend has switched off.
 *
 * Stored as the hidden set rather than the visible one so a category added to
 * the palette later defaults to visible — the other way round it would arrive
 * silently switched off for everyone who has ever touched the filter.
 */
export function readHiddenPoiCategories(): Set<string> {
  const raw = read(POI_CATEGORIES_HIDDEN);
  if (raw === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((c): c is string => typeof c === "string"));
  } catch {
    return new Set();
  }
}

export function writeHiddenPoiCategories(hidden: Set<string>): void {
  write(POI_CATEGORIES_HIDDEN, hidden.size === 0 ? null : JSON.stringify([...hidden]));
}

/**
 * Which legal-camping land layers the legend has switched off.
 *
 * Stored as the hidden set for the same reason the categories are: a layer added
 * to the overlay later must arrive visible rather than silently switched off for
 * everyone who has ever touched these checkboxes.
 */
export function readHiddenLandLayers(): Set<string> {
  const raw = read(LEGAL_LAYERS_HIDDEN);
  if (raw === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((l): l is string => typeof l === "string"));
  } catch {
    return new Set();
  }
}

export function writeHiddenLandLayers(hidden: Set<string>): void {
  write(LEGAL_LAYERS_HIDDEN, hidden.size === 0 ? null : JSON.stringify([...hidden]));
}
