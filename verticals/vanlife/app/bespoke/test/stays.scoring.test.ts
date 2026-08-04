import { describe, expect, it } from "vitest";
import { deriveStayFacts } from "../src/server/engine/stayFacts.js";
import {
  DEFAULT_STAY_WEIGHTS,
  rankStays,
  scoreStay,
  needsRelief,
  type StayKind,
} from "../src/server/engine/stays.js";
import type { NeedState } from "../src/server/engine/needs.js";

/**
 * The pure half of choosing a bed: what we are willing to claim about a place
 * from its tags, and how the weights turn factor scores into an order.
 */

describe("deriving stay facts", () => {
  it("never turns an absent tag into a convenient answer", () => {
    const facts = deriveStayFacts({ source: "overpass", category: "campground", tags: {} });
    expect(facts).not.toBeNull();
    // Unpriced is not free, untagged road is not passable, no reservation tag
    // is not walk-up. Each of these getting flipped costs somebody a bed.
    expect(facts!.nightlyCostUsd).toBeNull();
    expect(facts!.access).toBe("unknown");
    expect(facts!.reservable).toBe("unknown");
    expect(facts!.hookupElectric).toBe(false);
    expect(facts!.confidence).toBe("unverified");
  });

  it("reads a free site as free and a priced one as priced", () => {
    expect(deriveStayFacts({ source: "overpass", category: "dispersed", tags: { fee: "no" } })!.nightlyCostUsd).toBe(0);
    expect(
      deriveStayFacts({ source: "overpass", category: "campground", tags: { fee: "yes", "fee:amount": "$28" } })!
        .nightlyCostUsd,
    ).toBe(28);
    // "It costs something" with no amount is still unknown, not zero.
    expect(
      deriveStayFacts({ source: "overpass", category: "campground", tags: { fee: "yes" } })!.nightlyCostUsd,
    ).toBeNull();
  });

  it("keeps a van off roads that need clearance", () => {
    const bad = (tags: Record<string, string>): string =>
      deriveStayFacts({ source: "overpass", category: "dispersed", tags })!.access;
    expect(bad({ "4wd_only": "yes" })).toBe("high-clearance");
    expect(bad({ smoothness: "very_bad" })).toBe("high-clearance");
    expect(bad({ tracktype: "grade5" })).toBe("high-clearance");
    expect(bad({ surface: "asphalt" })).toBe("van-ok");
    expect(bad({ surface: "gravel" })).toBe("unknown");
  });

  it("trusts an official source more than a traveller's report", () => {
    expect(deriveStayFacts({ source: "recgov", category: "campground", tags: {} })!.confidence).toBe("verified");
    expect(deriveStayFacts({ source: "ioverlander", category: "dispersed", tags: {} })!.confidence).toBe("reported");
  });

  it("gives a hotel room the amenities a hotel room has", () => {
    const hotel = deriveStayFacts({ source: "overpass", category: "lodging", tags: {} })!;
    expect(hotel.hookupElectric).toBe(true);
    expect(hotel.showers).toBe(true);
    // But not the ones it may genuinely lack.
    expect(hotel.laundryOnSite).toBe(false);
    expect(hotel.dumpStation).toBe(false);
  });

  it("says nothing at all about places that are not stays", () => {
    expect(deriveStayFacts({ source: "overpass", category: "fuel", tags: {} })).toBeNull();
  });
});

function need(key: string, poiCategory: string, runway: number): NeedState {
  return {
    need: {
      id: 1,
      key,
      title: key,
      direction: "depletes",
      warnRatio: 0.25,
      urgentRatio: 0.1,
      poiCategory,
      routingDriver: true,
      sortOrder: 1,
      active: true,
      trackingMode: "level",
      dueAt: null,
      warnDays: null,
      urgentDays: null,
      serviceIntervalDays: null,
    },
    rate: { ratePerDay: 10, ratePerMile: 0, source: "manual", effectiveFrom: "2026-01-01T00:00:00.000Z" },
    level: runway,
    runway,
    runwayRatio: runway / 100,
    urgency: "ok",
    asOf: "2026-08-04T00:00:00.000Z",
    lastCheckInAt: null,
    deadlineAt: null,
    suggestion: null,
  } as unknown as NeedState;
}

describe("needs relief", () => {
  const base = {
    stayKind: "campground" as StayKind,
    nightlyCostUsd: null,
    hookupWater: false,
    dumpStation: false,
    showers: false,
    laundryOnSite: false,
    reservable: "unknown",
    access: "unknown",
    maxNights: null,
    lastReportedAt: null,
    confidence: "unverified",
  };

  it("weights the need that is nearly out far above the one that is nearly full", () => {
    const states = [need("electric", "ev-charge", 8), need("laundry", "laundry", 92)];
    const withPower = needsRelief({ ...base, hookupElectric: true }, states);
    const withLaundry = needsRelief({ ...base, hookupElectric: false, laundryOnSite: true }, states);
    expect(withPower).toBeGreaterThan(withLaundry);
    // Battery at 8% carries almost all the pressure in play.
    expect(withPower).toBeGreaterThan(0.85);
  });

  it("is zero for a stay that services nothing tracked", () => {
    expect(needsRelief({ ...base, hookupElectric: false }, [need("electric", "ev-charge", 8)])).toBe(0);
  });
});

describe("weights", () => {
  const factors = { needs: 1, proximity: 1, signal: 1, legality: 1, cost: 1, sights: 1, freshness: 1 };
  const weights = new Map(Object.entries(DEFAULT_STAY_WEIGHTS));

  it("a kind weighted to zero scores zero, like a zeroed interest category", () => {
    const off = new Map(weights);
    off.set("kind-parking", 0);
    expect(scoreStay("parking", factors, off)).toBe(0);
    expect(scoreStay("campground", factors, off)).toBeGreaterThan(0);
  });

  it("re-ranking is pure arithmetic — same options, new order, no routing", () => {
    const options = [
      { poiId: 1, stayKind: "dispersed" as StayKind, factors: { ...factors, cost: 1, signal: 0.1 }, excludedReason: null, booked: false },
      { poiId: 2, stayKind: "lodging" as StayKind, factors: { ...factors, cost: 0.1, signal: 1 }, excludedReason: null, booked: false },
    ];

    const cheap = new Map(weights);
    cheap.set("kind-lodging", 1);
    cheap.set("cost", 3);
    cheap.set("signal", 0);
    expect(rankStays(options, cheap)[0]!.poiId).toBe(1);

    const connected = new Map(weights);
    connected.set("kind-lodging", 1);
    connected.set("cost", 0);
    connected.set("signal", 3);
    expect(rankStays(options, connected)[0]!.poiId).toBe(2);
  });

  it("sorts every excluded stay below every usable one, whatever it scores", () => {
    const options = [
      { poiId: 1, stayKind: "campground" as StayKind, factors, excludedReason: "the road in needs high clearance", booked: false },
      { poiId: 2, stayKind: "parking" as StayKind, factors: { ...factors, needs: 0, cost: 0 }, excludedReason: null, booked: false },
    ];
    expect(rankStays(options, weights).map((o) => o.poiId)).toEqual([2, 1]);
  });

  it("a booked stay outranks everything, including a better-scoring one", () => {
    const options = [
      { poiId: 1, stayKind: "campground" as StayKind, factors, excludedReason: null, booked: false },
      { poiId: 2, stayKind: "parking" as StayKind, factors: { ...factors, needs: 0, cost: 0, signal: 0 }, excludedReason: null, booked: true },
    ];
    // The app has no business re-ranking past a phone call it did not make.
    expect(rankStays(options, weights)[0]!.poiId).toBe(2);
  });

  it("names the reason when a kind is switched off, rather than silently dropping it", () => {
    const off = new Map(weights);
    off.set("kind-parking", 0);
    const ranked = rankStays(
      [{ poiId: 1, stayKind: "parking" as StayKind, factors, excludedReason: null, booked: false }],
      off,
    );
    expect(ranked[0]!.excludedReason).toContain("turned off");
  });
});
