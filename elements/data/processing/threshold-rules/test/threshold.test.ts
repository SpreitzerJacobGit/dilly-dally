import { describe, expect, it } from "vitest";
import { evaluateThreshold, activeAlerts } from "../src/index.js";
import { deriveLevel } from "@elements/processing-derived-aggregates";

describe("threshold rules", () => {
  it("flags at-or-below threshold as low with the right deficit", () => {
    expect(evaluateThreshold({ level: 2, threshold: 4 })).toEqual({ status: "low", deficit: 2 });
    expect(evaluateThreshold({ level: 4, threshold: 4 })).toEqual({ status: "low", deficit: 0 });
    expect(evaluateThreshold({ level: 5, threshold: 4 })).toEqual({ status: "ok", deficit: 0 });
  });

  it("treats zero or negative level as out", () => {
    expect(evaluateThreshold({ level: 0, threshold: 4 }).status).toBe("out");
    expect(evaluateThreshold({ level: 0, threshold: null }).status).toBe("out");
  });

  it("never flags items without a threshold (unless out)", () => {
    expect(evaluateThreshold({ level: 1, threshold: null }).status).toBe("ok");
  });

  it("orders alerts by deficit, most urgent first", () => {
    const rows = activeAlerts(
      [
        { name: "chamomile", level: 5, threshold: 6 },
        { name: "gyokuro", level: 2, threshold: 4 },
      ],
      (t) => ({ level: t.level, threshold: t.threshold }),
    );
    expect(rows.map((r) => r.item.name)).toEqual(["gyokuro", "chamomile"]);
  });
});

describe("derived levels", () => {
  it("level equals deliveries minus usage", () => {
    const movements = [
      { kind: "delivery", quantity: 10 },
      { kind: "usage", quantity: 3 },
      { kind: "delivery", quantity: 5 },
      { kind: "usage", quantity: 2 },
    ];
    expect(deriveLevel(movements, "delivery")).toBe(10);
  });
});
