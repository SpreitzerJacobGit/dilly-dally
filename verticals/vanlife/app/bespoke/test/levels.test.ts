/**
 * The range/rate inversion. These are four-line functions, but they sit between
 * what an operator types ("a full tank lasts 450 miles") and what the drain
 * model consumes (0.2222 %/mile), and the zero case is a real trap: a need that
 * never drains carries a rate of 0, and an unguarded 100/0 renders as
 * "Infinity days per tank" in every screen that forgets to check.
 */
import { describe, expect, it } from "vitest";
import { FULL_LEVEL, formatRunway, percentPer100Miles, rangeFromRate, rateFromRange } from "../src/shared/levels.js";

describe("rateFromRange — how long a tank lasts, into a percent rate", () => {
  it("inverts a range into percentage points per unit", () => {
    expect(rateFromRange(4)).toBe(25);
    expect(rateFromRange(6)).toBeCloseTo(16.666667, 5);
    expect(rateFromRange(450)).toBeCloseTo(0.2222, 4);
  });

  it("reads a missing, zero or negative range as 'never drains'", () => {
    expect(rateFromRange(undefined)).toBe(0);
    expect(rateFromRange(null)).toBe(0);
    expect(rateFromRange(0)).toBe(0);
    expect(rateFromRange(-5)).toBe(0);
    expect(rateFromRange(Number.NaN)).toBe(0);
  });

  it("does not round, because seeded urgency claims sit on their floors", () => {
    // Waste water: 100/6 %/day for 4.5 days is exactly its 25% warn floor. A
    // rate rounded to 16.66 would leave 25.03 and silently flip it to "ok".
    expect(FULL_LEVEL - rateFromRange(6) * 4.5).toBe(25);
  });
});

describe("rangeFromRate — the inverse, guarded", () => {
  it("round-trips a rate back to its range", () => {
    expect(rangeFromRate(25)).toBe(4);
    expect(rangeFromRate(rateFromRange(450))).toBeCloseTo(450, 9);
  });

  it("returns null rather than Infinity for a need that never drains", () => {
    expect(rangeFromRate(0)).toBeNull();
    expect(rangeFromRate(-1)).toBeNull();
    expect(rangeFromRate(Number.NaN)).toBeNull();
  });
});

describe("percentPer100Miles — the readable form of a tiny per-mile rate", () => {
  it("scales fuel's rate into something a person can check", () => {
    expect(percentPer100Miles(rateFromRange(450))).toBeCloseTo(22.22, 2);
  });
});

describe("formatRunway — the one place level and date modes must not be confused", () => {
  it("speaks percent for a level need and days for a date one", () => {
    expect(formatRunway(25, "level")).toBe("25%");
    expect(formatRunway(45, "date")).toBe("45 days");
  });
});
