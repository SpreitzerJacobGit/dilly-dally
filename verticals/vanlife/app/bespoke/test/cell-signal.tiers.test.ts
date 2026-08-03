/**
 * The cell signal overlay's judgement calls: which company is which carrier,
 * what counts as good LTE, and how three carriers' filings collapse onto one
 * hex grid.
 *
 * These are tested because they are the only part of that pipeline that can
 * be. Everything around them downloads gigabytes and shells out to GDAL and
 * tippecanoe; a mistake there fails loudly. A mistake here produces a map that
 * looks entirely normal and is wrong, which is the failure mode that matters
 * for a tool someone uses to decide where they can work for the day.
 */
import { describe, expect, it } from "vitest";
import {
  aggregate,
  carrierFor,
  technologyFor,
  tierFor,
  withCoverage,
  TIER_5G,
  TIER_5G_FAST,
  TIER_LTE,
  TIER_LTE_WEAK,
  TIER_NONE,
  type CoverageObservation,
} from "../../../deploy/cell-signal-tiers.js";

describe("carrierFor", () => {
  it("recognises the brands", () => {
    expect(carrierFor("AT&T Mobility LLC")).toBe("att");
    expect(carrierFor("T-Mobile US, Inc.")).toBe("tmo");
    expect(carrierFor("Verizon Wireless")).toBe("vzw");
  });

  it("recognises the corporate names the filings actually use", () => {
    // Carriers file under the entity, not the brand — matching only on the
    // brand would drop every one of their hexes and paint the map as dead.
    expect(carrierFor("New Cingular Wireless PCS, LLC")).toBe("att");
    expect(carrierFor("Cellco Partnership")).toBe("vzw");
    expect(carrierFor("Sprint Spectrum LLC")).toBe("tmo");
  });

  it("is null for anyone else rather than guessing", () => {
    // A regional carrier silently folded into one of the big three would be a
    // map claiming coverage that the operator's SIM cannot use.
    expect(carrierFor("Union Wireless")).toBeNull();
    expect(carrierFor("")).toBeNull();
  });
});

describe("technologyFor", () => {
  it("reads the FCC's own labels", () => {
    expect(technologyFor("5G-NR")).toBe("5g");
    expect(technologyFor("4G-LTE")).toBe("lte");
  });

  it("reads them out of a download file name", () => {
    expect(technologyFor("bdc_32_130077_5G-NR_mobile_broadband_h3_2025-06-30.csv")).toBe("5g");
    expect(technologyFor("bdc_32_130077_4G-LTE_mobile_broadband_h3_2025-06-30.csv")).toBe("lte");
  });

  it("is null for anything it does not recognise", () => {
    expect(technologyFor("mobile voice")).toBeNull();
  });
});

describe("tierFor", () => {
  it("splits LTE at the FCC's 5 Mbps benchmark", () => {
    expect(tierFor("lte", 4.9)).toBe(TIER_LTE_WEAK);
    expect(tierFor("lte", 5)).toBe(TIER_LTE);
    expect(tierFor("lte", 50)).toBe(TIER_LTE);
  });

  it("splits 5G at the 35 Mbps benchmark", () => {
    expect(tierFor("5g", 7)).toBe(TIER_5G);
    expect(tierFor("5g", 34.9)).toBe(TIER_5G);
    expect(tierFor("5g", 35)).toBe(TIER_5G_FAST);
  });

  it("keeps slow coverage rather than discarding it", () => {
    // One bar on a ridge is not the same answer as no service, and the map is
    // not allowed to merge them.
    expect(tierFor("lte", 0)).toBeGreaterThan(TIER_NONE);
  });

  it("orders every tier so `best` can be a plain max", () => {
    expect(TIER_LTE_WEAK).toBeLessThan(TIER_LTE);
    expect(TIER_LTE).toBeLessThan(TIER_5G);
    expect(TIER_5G).toBeLessThan(TIER_5G_FAST);
  });
});

describe("aggregate", () => {
  // Stands in for h3-js: the first character is the "parent", which is all
  // these tests need and keeps the icosahedral projection out of them.
  const toParent = (cell: string): string => cell.slice(0, 1);

  it("keeps every carrier on its own property", () => {
    const observations: CoverageObservation[] = [
      { cell: "a1", carrier: "att", tier: TIER_LTE },
      { cell: "a2", carrier: "vzw", tier: TIER_5G },
    ];
    const cell = aggregate(observations, toParent).get("a");
    expect(cell).toEqual({ cell: "a", att: TIER_LTE, tmo: TIER_NONE, vzw: TIER_5G, best: TIER_5G });
  });

  it("takes the best of the fine cells inside a coarse one", () => {
    // A coarse hex covers many fine ones; a carrier reaching any part of it
    // reaches it. Taking the last or the worst would send someone driving away
    // from signal they actually have.
    const observations: CoverageObservation[] = [
      { cell: "a1", carrier: "att", tier: TIER_5G_FAST },
      { cell: "a2", carrier: "att", tier: TIER_LTE_WEAK },
    ];
    expect(aggregate(observations, toParent).get("a")?.att).toBe(TIER_5G_FAST);
  });

  it("makes best the max across carriers, not a sum or a last-wins", () => {
    const observations: CoverageObservation[] = [
      { cell: "a1", carrier: "att", tier: TIER_5G_FAST },
      { cell: "a1", carrier: "tmo", tier: TIER_LTE_WEAK },
    ];
    const cell = aggregate(observations, toParent).get("a");
    expect(cell?.best).toBe(TIER_5G_FAST);
    expect(cell?.tmo).toBe(TIER_LTE_WEAK);
  });

  it("emits one feature per coarse cell, which is what keeps fills from overlapping", () => {
    const observations: CoverageObservation[] = [
      { cell: "a1", carrier: "att", tier: TIER_LTE },
      { cell: "a2", carrier: "tmo", tier: TIER_5G },
      { cell: "b1", carrier: "vzw", tier: TIER_LTE },
    ];
    expect(aggregate(observations, toParent).size).toBe(2);
  });

  it("is empty for no observations", () => {
    expect(aggregate([], toParent).size).toBe(0);
  });
});

describe("withCoverage", () => {
  it("drops cells nobody covers", () => {
    // They carry nothing the basemap does not already carry, and dropping them
    // is most of the archive's size saving.
    const kept = withCoverage([
      { cell: "a", att: TIER_NONE, tmo: TIER_NONE, vzw: TIER_NONE, best: TIER_NONE },
      { cell: "b", att: TIER_LTE, tmo: TIER_NONE, vzw: TIER_NONE, best: TIER_LTE },
    ]);
    expect(kept.map((c) => c.cell)).toEqual(["b"]);
  });
});
