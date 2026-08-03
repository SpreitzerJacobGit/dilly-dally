/**
 * Level-tracked needs are percentages. There is no per-need capacity: a tank is
 * 0 to 100 whether it holds water, fuel or trash, because a percentage is what
 * an operator can actually read off a gauge. Gallons, bags and loads were a
 * conversion step between what you can see and what you had to type.
 *
 * This module is deliberately dependency-free so the engine, the zod schemas,
 * the seed fixtures and the React client can all share one definition of
 * "full" — engine/needs.ts imports drizzle, so the constant cannot live there
 * without dragging the database driver into the browser bundle.
 */

/** Full. Every level-tracked need runs 0 (empty, or clean) to 100 (full). */
export const FULL_LEVEL = 100;

/**
 * Rates are ENTERED as a range — "a full tank lasts about 450 miles" — because
 * that is the quantity an operator knows; they are STORED as percent per day
 * and percent per mile, because that is what the drain model consumes. Both
 * directions of the inversion live together so they cannot drift apart.
 *
 * A range of zero, negative or absent means "this never drains", which is a
 * rate of 0 — exactly what the engine already reads as no drain.
 */
export function rateFromRange(range: number | null | undefined): number {
  if (range === null || range === undefined) return 0;
  if (!Number.isFinite(range) || range <= 0) return 0;
  return FULL_LEVEL / range;
}

/**
 * The inverse, returning null rather than Infinity for a need that never
 * drains: "never" is not a number of days, and a bare FULL_LEVEL / 0 renders
 * as "Infinity days per tank" in every caller that forgets to check.
 */
export function rangeFromRate(rate: number): number | null {
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return FULL_LEVEL / rate;
}

/** Per-mile rates are tiny; "22.2% per 100 miles" is the readable form. */
export function percentPer100Miles(ratePerMile: number): number {
  return ratePerMile * 100;
}

/**
 * Runway is a percentage for a level-tracked need and DAYS for a date-tracked
 * one. This is the one place that distinction has to be spoken out loud — it
 * used to hide inside the `unit` column, where a date need quietly carried
 * "days" and every reader interpolated it without knowing why.
 */
export function formatRunway(runway: number, trackingMode: string): string {
  const n = Math.round(runway * 10) / 10;
  return trackingMode === "date" ? `${String(n)} days` : `${String(n)}%`;
}
