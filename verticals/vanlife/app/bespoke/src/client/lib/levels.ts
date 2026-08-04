/**
 * Display helpers for percentage levels. The arithmetic lives in
 * shared/levels.ts, which the server shares; this is the presentation layer
 * that decides how many decimals an operator wants to read at a fuel pump.
 */
import { FULL_LEVEL, percentPer100Miles, rangeFromRate } from "../../shared/levels.js";

export { FULL_LEVEL, percentPer100Miles };

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** "62%" — whole percentage points, because a gauge is not a measurement. */
export function pctLabel(n: number): string {
  return `${String(Math.round(n))}%`;
}

export function isAccumulating(need: { direction: string }): boolean {
  return need.direction === "accumulates";
}

/**
 * How long a full tank lasts, given the stored rate. Null means "never drains"
 * — the guard that keeps a zero rate from rendering as "Infinity days".
 */
export function daysPerTank(ratePerDay: number): number | null {
  return rangeFromRate(ratePerDay);
}

export function milesPerTank(ratePerMile: number): number | null {
  return rangeFromRate(ratePerMile);
}

/** The quick-picks on a level correction, ordered just-serviced first. */
export function levelQuickPicks(need: { direction: string }): { label: string; value: number }[] {
  return isAccumulating(need)
    ? [
        { label: "Empty", value: 0 },
        { label: "¼ full", value: 25 },
        { label: "½ full", value: 50 },
        { label: "¾ full", value: 75 },
        { label: "Full", value: FULL_LEVEL },
      ]
    : [
        { label: "Full", value: FULL_LEVEL },
        { label: "¾", value: 75 },
        { label: "½", value: 50 },
        { label: "¼", value: 25 },
        { label: "Empty", value: 0 },
      ];
}
