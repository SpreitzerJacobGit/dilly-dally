import { isStayCategory, type StayKind } from "./stays.js";

/**
 * Turning a fetched place into stay facts.
 *
 * Pure and separately testable, because this is where optimism does the most
 * damage: every field here defaults to "we don't know" rather than to the
 * convenient answer. An unpriced campground is not free, an untagged road is
 * not passable, and a place with no reservation tag is not walk-up. Getting
 * that backwards costs somebody a bed at 9pm.
 */

export interface DerivedStayFacts {
  stayKind: StayKind;
  nightlyCostUsd: number | null;
  hookupElectric: boolean;
  hookupWater: boolean;
  dumpStation: boolean;
  showers: boolean;
  laundryOnSite: boolean;
  reservable: "required" | "optional" | "none" | "unknown";
  access: "van-ok" | "high-clearance" | "unknown";
  maxNights: number | null;
  lastReportedAt: string | null;
  confidence: "verified" | "reported" | "unverified";
}

type Tags = Record<string, unknown>;

function str(tags: Tags, key: string): string | null {
  const v = tags[key];
  return typeof v === "string" ? v.toLowerCase().trim() : null;
}

function yes(tags: Tags, ...keys: string[]): boolean {
  return keys.some((k) => {
    const v = str(tags, k);
    return v === "yes" || v === "true" || v === "1";
  });
}

/** Road surfaces and grades a two-wheel-drive van has no business on. */
const HIGH_CLEARANCE_SMOOTHNESS = new Set(["very_bad", "horrible", "very_horrible", "impassable"]);
const HIGH_CLEARANCE_TRACKTYPE = new Set(["grade4", "grade5"]);

function deriveAccess(tags: Tags): DerivedStayFacts["access"] {
  if (yes(tags, "4wd_only", "high_clearance")) return "high-clearance";
  const smoothness = str(tags, "smoothness");
  if (smoothness && HIGH_CLEARANCE_SMOOTHNESS.has(smoothness)) return "high-clearance";
  const tracktype = str(tags, "tracktype");
  if (tracktype && HIGH_CLEARANCE_TRACKTYPE.has(tracktype)) return "high-clearance";
  // A source that says so outright. iOverlander exports carry this as free text
  // on the road description, so only an explicit flag is trusted here.
  const vanAccessible = str(tags, "van_accessible");
  if (vanAccessible === "yes") return "van-ok";
  if (vanAccessible === "no") return "high-clearance";
  const surface = str(tags, "surface");
  if (surface === "asphalt" || surface === "paved" || surface === "concrete") return "van-ok";
  return "unknown";
}

function deriveCost(tags: Tags): number | null {
  const fee = str(tags, "fee");
  if (fee === "no" || fee === "free") return 0;
  for (const key of ["fee:amount", "charge", "price", "cost"]) {
    const raw = tags[key];
    const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw : null;
    if (text === null) continue;
    const match = /(\d+(?:\.\d+)?)/.exec(text);
    if (match) return Number(match[1]);
  }
  // "fee=yes" with no amount means it costs something we cannot name. Null, not zero.
  return null;
}

function deriveReservable(tags: Tags): DerivedStayFacts["reservable"] {
  const r = str(tags, "reservation");
  if (r === "required" || r === "yes") return "required";
  if (r === "recommended" || r === "optional" || r === "partial") return "optional";
  if (r === "no") return "none";
  return "unknown";
}

function deriveMaxNights(tags: Tags): number | null {
  const raw = tags["maxstay"] ?? tags["max_stay"] ?? tags["stay_limit"];
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw : null;
  if (text === null) return null;
  const match = /(\d+)/.exec(text);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Sources whose records are somebody's own report of a place they slept at,
 * rather than an operator's published record of a facility. Freshness matters
 * for these and confidence never rises above "reported".
 */
const USER_REPORTED_SOURCES = new Set(["ioverlander"]);

/** Sources that publish their own facilities, so the record is authoritative. */
const OFFICIAL_SOURCES = new Set(["recgov", "nps"]);

export function deriveStayFacts(record: {
  source: string;
  category: string;
  tags?: Tags | null;
}): DerivedStayFacts | null {
  if (!isStayCategory(record.category)) return null;
  const tags: Tags = record.tags ?? {};
  const kind = record.category;

  const confidence: DerivedStayFacts["confidence"] = OFFICIAL_SOURCES.has(record.source)
    ? "verified"
    : USER_REPORTED_SOURCES.has(record.source)
      ? "reported"
      : "unverified";

  const lastReportedRaw = tags["last_reported"] ?? tags["check_date"] ?? tags["survey:date"];
  const lastReportedAt =
    typeof lastReportedRaw === "string" && !Number.isNaN(Date.parse(lastReportedRaw))
      ? new Date(lastReportedRaw).toISOString()
      : null;

  return {
    stayKind: kind,
    // A hotel room is not a campsite: it always has power, water and a shower,
    // and pretending otherwise would make lodging score as though it relieves
    // nothing. Laundry and a dump station are the two it genuinely may not have.
    nightlyCostUsd: deriveCost(tags),
    hookupElectric: kind === "lodging" || yes(tags, "power_supply", "electricity", "hookup:electric"),
    hookupWater: kind === "lodging" || yes(tags, "drinking_water", "water_point", "hookup:water"),
    dumpStation: yes(tags, "sanitary_dump_station", "dump_station"),
    showers: kind === "lodging" || yes(tags, "shower", "showers"),
    laundryOnSite: yes(tags, "laundry", "laundry_service"),
    reservable: kind === "lodging" ? "optional" : deriveReservable(tags),
    access: kind === "lodging" || kind === "parking" ? "van-ok" : deriveAccess(tags),
    maxNights: deriveMaxNights(tags),
    lastReportedAt,
    confidence,
  };
}
