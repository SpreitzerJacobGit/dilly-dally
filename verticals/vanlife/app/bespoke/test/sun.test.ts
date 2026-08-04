import { describe, expect, it } from "vitest";
import { arrivesAfterDark, solarDay, sunsetAt } from "../src/server/engine/sun.js";

/**
 * Sunset is the only hard filter that needs no data source at all, so it is
 * worth proving it actually tracks the sun rather than returning a plausible
 * time. The absolute checks below use published values; the rest are structural
 * properties that would catch a sign error or a longitude/latitude swap even if
 * the constants drifted.
 */

const PORTLAND = { lat: 45.5152, lng: -122.6784 };
const LAS_VEGAS = { lat: 36.1699, lng: -115.1398 };

function minutesBetween(a: string, b: string): number {
  return (Date.parse(a) - Date.parse(b)) / 60_000;
}

describe("sunset", () => {
  it("matches published sunset at Portland on the summer solstice", () => {
    // Published: 2026-06-21 sunset 21:03 PDT = 2026-06-22T04:03Z.
    const sunset = sunsetAt("2026-06-21T12:00:00.000Z", PORTLAND.lat, PORTLAND.lng);
    expect(sunset).not.toBeNull();
    expect(Math.abs(minutesBetween(sunset!, "2026-06-22T04:03:00.000Z"))).toBeLessThan(15);
  });

  it("matches published sunset at Las Vegas at midwinter", () => {
    // Published: 2026-12-21 sunset 16:29 PST = 2026-12-22T00:29Z.
    const sunset = sunsetAt("2026-12-21T12:00:00.000Z", LAS_VEGAS.lat, LAS_VEGAS.lng);
    expect(sunset).not.toBeNull();
    expect(Math.abs(minutesBetween(sunset!, "2026-12-22T00:29:00.000Z"))).toBeLessThan(15);
  });

  it("gives Portland a long summer day and a short winter one", () => {
    const summer = solarDay("2026-06-21T12:00:00.000Z", PORTLAND.lat, PORTLAND.lng);
    const winter = solarDay("2026-12-21T12:00:00.000Z", PORTLAND.lat, PORTLAND.lng);
    const hours = (d: typeof summer): number => minutesBetween(d.sunsetIso!, d.sunriseIso!) / 60;
    expect(hours(summer)).toBeGreaterThan(15);
    expect(hours(summer)).toBeLessThan(16.2);
    expect(hours(winter)).toBeGreaterThan(8);
    expect(hours(winter)).toBeLessThan(9);
    // The higher latitude has the longer summer day and the shorter winter one.
    const vegasSummer = solarDay("2026-06-21T12:00:00.000Z", LAS_VEGAS.lat, LAS_VEGAS.lng);
    expect(hours(summer)).toBeGreaterThan(hours(vegasSummer));
  });

  it("shifts sunset by an hour for every 15 degrees of longitude", () => {
    const here = sunsetAt("2026-09-15T12:00:00.000Z", 40, -120)!;
    const east = sunsetAt("2026-09-15T12:00:00.000Z", 40, -105)!;
    // 15° east means the sun sets an hour earlier in UTC.
    expect(Math.abs(minutesBetween(here, east) - 60)).toBeLessThan(3);
  });

  it("reports midnight sun and polar night as themselves, never as a time", () => {
    const midnightSun = solarDay("2026-06-21T12:00:00.000Z", 80, 20);
    expect(midnightSun.state).toBe("midnight-sun");
    expect(midnightSun.sunsetIso).toBeNull();

    const polarNight = solarDay("2026-12-21T12:00:00.000Z", 80, 20);
    expect(polarNight.state).toBe("polar-night");
    expect(polarNight.sunsetIso).toBeNull();
  });

  it("answers the dark-arrival question in the direction that keeps people safe", () => {
    // Under the midnight sun nothing is a dark arrival; in polar night everything is.
    expect(arrivesAfterDark("2026-06-21T23:00:00.000Z", 80, 20)).toBe(false);
    expect(arrivesAfterDark("2026-12-21T12:00:00.000Z", 80, 20)).toBe(true);

    // Portland in July: 6pm local (01:00Z) is fine, 11pm local (06:00Z) is not.
    expect(arrivesAfterDark("2026-07-16T01:00:00.000Z", PORTLAND.lat, PORTLAND.lng)).toBe(false);
    expect(arrivesAfterDark("2026-07-16T06:00:00.000Z", PORTLAND.lat, PORTLAND.lng)).toBe(true);
  });
});
