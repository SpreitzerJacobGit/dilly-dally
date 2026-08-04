/**
 * Sunset and sunrise as UTC instants, from date, latitude and longitude alone.
 *
 * NOAA's solar position approximation. Pure arithmetic, no I/O, no table, and —
 * the point of doing it this way — no timezone database: solar time IS
 * longitude, so a UTC instant computed from a coordinate is already local to
 * that coordinate. The planner never has to know what zone a stay sits in, and
 * the existing UTC-vs-server-local split between planDateOf and digestHour
 * never comes into it.
 *
 * Accurate to about a minute at the latitudes a van drives, which is far inside
 * the margin that matters for "can we get there before dark".
 */

const DEG = Math.PI / 180;

/**
 * Solar zenith at sunset: 90° plus the sun's apparent radius and average
 * atmospheric refraction. This is the standard "the disc has just gone" angle,
 * not civil twilight — headlights-on dark comes later, which is the honest
 * direction to err in.
 */
const SUNSET_ZENITH_DEG = 90.833;

function dayOfYearUtc(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start) / 86_400_000) + 1;
}

/**
 * The solar day an instant belongs to, at a longitude.
 *
 * This offset is the whole reason the module needs no timezone database, and
 * leaving it out is a subtle, one-directional bug: 11pm in Portland is already
 * tomorrow in UTC, so a naive UTC calendar day would compare a late arrival
 * against the FOLLOWING evening's sunset — about 22 hours later — and quietly
 * pass every dark arrival in the Americas.
 */
function localSolarDate(atIso: string, lng: number): Date {
  return new Date(Date.parse(atIso) + (lng / 15) * 3_600_000);
}

interface SolarTerms {
  /** Equation of time, in minutes. */
  eqTimeMinutes: number;
  /** Solar declination, in radians. */
  declination: number;
}

function solarTerms(date: Date): SolarTerms {
  // Fractional year, taken at solar noon (the 12h term) so the day's terms are
  // evaluated mid-day rather than at its UTC edge.
  const g = ((2 * Math.PI) / 365) * (dayOfYearUtc(date) - 1 + 0.5);
  const eqTimeMinutes =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(g) -
      0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) -
      0.040849 * Math.sin(2 * g));
  const declination =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);
  return { eqTimeMinutes, declination };
}

/**
 * The hour angle of sunset, in degrees, or null when the sun does not cross the
 * horizon that day at that latitude — polar day and polar night are real
 * answers, not errors, and callers must decide what they mean rather than
 * getting a fabricated time.
 */
function sunsetHourAngleDeg(latDeg: number, declination: number): number | null {
  const lat = latDeg * DEG;
  const cosH =
    Math.cos(SUNSET_ZENITH_DEG * DEG) / (Math.cos(lat) * Math.cos(declination)) -
    Math.tan(lat) * Math.tan(declination);
  if (cosH > 1 || cosH < -1) return null;
  return Math.acos(cosH) / DEG;
}

export type PolarState = "sets" | "midnight-sun" | "polar-night";

export interface SolarDay {
  sunriseIso: string | null;
  sunsetIso: string | null;
  /** Which of the three cases produced those — so "null" is never ambiguous. */
  state: PolarState;
}

/**
 * Sunrise and sunset for the UTC calendar day containing `atIso`, at a point.
 *
 * `state` distinguishes the two ways the times can be null: under the midnight
 * sun there is no sunset because it never gets dark (a dark-arrival filter
 * should pass everything), and in polar night there is no sunset because it is
 * never light (it should pass nothing).
 */
export function solarDay(atIso: string, lat: number, lng: number): SolarDay {
  const date = localSolarDate(atIso, lng);
  if (Number.isNaN(date.getTime())) return { sunriseIso: null, sunsetIso: null, state: "sets" };
  const { eqTimeMinutes, declination } = solarTerms(date);
  const midnightUtcMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

  // Solar noon in minutes past 00:00 UTC. At lng 0 this lands near 12:00 UTC;
  // at lng -120 it lands near 20:00 UTC, i.e. local noon on the Pacific coast.
  const solarNoonMinutes = 720 - 4 * lng - eqTimeMinutes;

  const haDeg = sunsetHourAngleDeg(lat, declination);
  if (haDeg === null) {
    // Which side of the horizon the sun is stuck on depends on whether the
    // hemisphere's declination matches its latitude sign.
    const state: PolarState = lat * declination > 0 ? "midnight-sun" : "polar-night";
    return { sunriseIso: null, sunsetIso: null, state };
  }

  const toIso = (minutes: number): string => new Date(midnightUtcMs + minutes * 60_000).toISOString();
  return {
    sunriseIso: toIso(solarNoonMinutes - 4 * haDeg),
    sunsetIso: toIso(solarNoonMinutes + 4 * haDeg),
    state: "sets",
  };
}

/** Convenience: just the sunset instant, or null under midnight sun / polar night. */
export function sunsetAt(atIso: string, lat: number, lng: number): string | null {
  return solarDay(atIso, lat, lng).sunsetIso;
}

/**
 * Would we arrive after dark? Under the midnight sun the answer is no (it never
 * gets dark); in polar night it is yes (it never gets light). Both are stated
 * rather than defaulted.
 */
export function arrivesAfterDark(arrivalIso: string, lat: number, lng: number): boolean {
  const day = solarDay(arrivalIso, lat, lng);
  if (day.state === "midnight-sun") return false;
  if (day.state === "polar-night") return true;
  return Date.parse(arrivalIso) > Date.parse(day.sunsetIso!);
}
