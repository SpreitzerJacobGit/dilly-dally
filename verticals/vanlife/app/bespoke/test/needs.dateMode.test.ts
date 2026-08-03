/**
 * Date-tracked needs — an oil change, a registration renewal.
 *
 * The point of the design is that a date-tracked need speaks the same
 * runway/urgency/deadline vocabulary as a consumable, so the gauges, the sort,
 * the digest and the candidate engine need no idea the two kinds differ. Most
 * of these assertions are therefore about SHAPE compatibility as much as about
 * arithmetic — particularly that a date need reports a zero rate, which is the
 * single thing keeping it out of the service-stop loop in candidates.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, type DbHandle } from "@elements/storage-sqlite-drizzle";
import { needs } from "../src/db/schema.js";
import {
  DEFAULT_URGENT_DAYS,
  DEFAULT_WARN_DAYS,
  deriveDateState,
  loadNeedStates,
  rollDueDate,
} from "../src/server/engine/needs.js";

const NOW = "2026-08-03T12:00:00.000Z";

/** A due date exactly `days` from NOW, so every expectation is exact. */
function dueIn(days: number): string {
  return new Date(Date.parse(NOW) + days * 86_400_000).toISOString();
}

describe("deriveDateState — days until due, in runway's clothing", () => {
  it("counts down in days and reports the due date as the deadline", () => {
    const s = deriveDateState(
      { dueAt: dueIn(45), warnDays: 14, urgentDays: 3, serviceIntervalDays: 180 },
      NOW,
    );
    expect(s.runway).toBe(45);
    expect(s.level).toBe(45);
    expect(s.deadlineAt).toBe(dueIn(45));
    expect(s.urgency).toBe("ok");
  });

  it("crosses into warn and then urgent at the configured lead times", () => {
    const need = { dueAt: dueIn(20), warnDays: 14, urgentDays: 3, serviceIntervalDays: 180 };
    expect(deriveDateState(need, NOW).urgency).toBe("ok");
    expect(deriveDateState({ ...need, dueAt: dueIn(14) }, NOW).urgency).toBe("warn");
    expect(deriveDateState({ ...need, dueAt: dueIn(3.5) }, NOW).urgency).toBe("warn");
    expect(deriveDateState({ ...need, dueAt: dueIn(3) }, NOW).urgency).toBe("urgent");
  });

  it("treats the boundaries as inclusive — due in exactly warnDays is already warning", () => {
    const need = { dueAt: dueIn(14), warnDays: 14, urgentDays: 3, serviceIntervalDays: null };
    expect(deriveDateState(need, NOW).urgency).toBe("warn");
    expect(deriveDateState({ ...need, dueAt: dueIn(14.001) }, NOW).urgency).toBe("ok");
  });

  it("clamps an overdue need at zero rather than reporting negative days", () => {
    const s = deriveDateState({ dueAt: dueIn(-30), warnDays: 14, urgentDays: 3, serviceIntervalDays: null }, NOW);
    expect(s.runway).toBe(0);
    expect(s.runwayRatio).toBe(0);
    expect(s.urgency).toBe("urgent");
    // The deadline stays in the past — the screen should say how overdue it is.
    expect(s.deadlineAt).toBe(dueIn(-30));
  });

  it("falls back to the default lead times when the need names none", () => {
    const bare = { dueAt: dueIn(DEFAULT_WARN_DAYS), warnDays: null, urgentDays: null, serviceIntervalDays: null };
    expect(deriveDateState(bare, NOW).urgency).toBe("warn");
    expect(deriveDateState({ ...bare, dueAt: dueIn(DEFAULT_URGENT_DAYS) }, NOW).urgency).toBe("urgent");
    expect(deriveDateState({ ...bare, dueAt: dueIn(DEFAULT_WARN_DAYS + 1) }, NOW).urgency).toBe("ok");
  });

  it("reads calm rather than overdue when no due date has been set", () => {
    const s = deriveDateState({ dueAt: null, warnDays: 14, urgentDays: 3, serviceIntervalDays: null }, NOW);
    expect(s.urgency).toBe("ok");
    expect(s.deadlineAt).toBeNull();
    expect(s.runway).toBe(0);
  });

  it("fills the gauge against the service interval, so a fresh service reads full", () => {
    const need = { dueAt: dueIn(180), warnDays: 14, urgentDays: 3, serviceIntervalDays: 180 };
    expect(deriveDateState(need, NOW).runwayRatio).toBe(1);
    expect(deriveDateState({ ...need, dueAt: dueIn(90) }, NOW).runwayRatio).toBe(0.5);
  });

  it("never overflows the bar when the due date is beyond the interval", () => {
    const s = deriveDateState({ dueAt: dueIn(400), warnDays: 14, urgentDays: 3, serviceIntervalDays: 180 }, NOW);
    expect(s.runwayRatio).toBe(1);
  });

  it("falls back to twice the warn lead when there is no interval to fill against", () => {
    const s = deriveDateState({ dueAt: dueIn(14), warnDays: 14, urgentDays: 3, serviceIntervalDays: null }, NOW);
    expect(s.runwayRatio).toBe(0.5);
  });
});

describe("rollDueDate — what a service check-in does to a due date", () => {
  it("moves the due date one interval past the service, not past the old due date", () => {
    // Servicing early must not compound: an oil change done 30 days early is
    // due one interval from TODAY, not one interval from when it was due.
    expect(rollDueDate({ serviceIntervalDays: 180 }, NOW)).toBe(dueIn(180));
  });

  it("is not invertible by subtraction — which is why undo records the old date", () => {
    // The roll is measured from the SERVICE date, so a need serviced 135 days
    // early lands 180 days out, and subtracting 180 gives the service date back
    // rather than the 45-days-out date it actually had. Undo must restore the
    // recorded prevDueAt instead of recomputing.
    const rolledTo = rollDueDate({ serviceIntervalDays: 180 }, NOW)!;
    const naiveUndo = new Date(Date.parse(rolledTo) - 180 * 86_400_000).toISOString();
    expect(naiveUndo).toBe(NOW);
    expect(naiveUndo).not.toBe(dueIn(45));
  });

  it("leaves a one-off alone — no interval means the date only ever moves by hand", () => {
    expect(rollDueDate({ serviceIntervalDays: null }, NOW)).toBeNull();
    expect(rollDueDate({ serviceIntervalDays: 0 }, NOW)).toBeNull();
  });
});

describe("loadNeedStates — a date need in the shape every reader expects", () => {
  let handle: DbHandle;

  async function migrate(h: DbHandle): Promise<void> {
    const md = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
    for (const f of fs.readdirSync(md).filter((x) => x.endsWith(".sql")).sort())
      for (const s of fs.readFileSync(path.join(md, f), "utf8").split("--> statement-breakpoint"))
        if (s.trim()) await h.client.execute(s);
  }

  beforeEach(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vl-needs-date-"));
    handle = await createDb({ dbFile: path.join(dir, "t.db") });
    await migrate(handle);
  });
  afterEach(() => handle.close());

  async function insertNeed(over: Record<string, unknown>): Promise<number> {
    const rows = await handle.db
      .insert(needs)
      .values({
        key: "oil-change",
        title: "Oil change",
        unit: "days",
        capacity: 1,
        direction: "depletes",
        warnRatio: 0.25,
        urgentRatio: 0.1,
        poiCategory: null,
        routingDriver: false,
        sortOrder: 1,
        active: true,
        trackingMode: "date",
        ...over,
      })
      .returning({ id: needs.id });
    return rows[0]!.id;
  }

  it("reports a zero rate, which is what keeps it out of the service-stop loop", async () => {
    await insertNeed({ dueAt: dueIn(45), warnDays: 14, urgentDays: 3, serviceIntervalDays: 180 });
    const [state] = await loadNeedStates(handle.db, null, NOW);
    expect(state!.rate.ratePerDay).toBe(0);
    expect(state!.rate.ratePerMile).toBe(0);
  });

  it("never offers a rate suggestion — there is no rate to refine", async () => {
    await insertNeed({ dueAt: dueIn(45), serviceIntervalDays: 180 });
    const [state] = await loadNeedStates(handle.db, null, NOW);
    expect(state!.suggestion).toBeNull();
  });

  it("carries the same keys a level need does, so one gauge renders both", async () => {
    await insertNeed({ dueAt: dueIn(45), warnDays: 14, urgentDays: 3, serviceIntervalDays: 180 });
    const [state] = await loadNeedStates(handle.db, null, NOW);
    for (const key of ["need", "rate", "level", "runway", "runwayRatio", "urgency", "asOf", "deadlineAt"]) {
      expect(state).toHaveProperty(key);
    }
    expect(state!.urgency).toBe("ok");
    expect(state!.deadlineAt).toBe(dueIn(45));
  });

  it("existing level needs are untouched by the new columns", async () => {
    await insertNeed({
      key: "water",
      title: "Fresh water",
      unit: "gal",
      capacity: 40,
      trackingMode: "level",
      dueAt: null,
      routingDriver: true,
    });
    const [state] = await loadNeedStates(handle.db, null, NOW);
    // No check-ins and no rate: full tank, by the trip-start assumption.
    expect(state!.level).toBe(40);
    expect(state!.urgency).toBe("ok");
  });

  it("hides archived needs from every reader unless they are asked for", async () => {
    await insertNeed({ dueAt: dueIn(45), active: false });
    expect(await loadNeedStates(handle.db, null, NOW)).toHaveLength(0);
    expect(await loadNeedStates(handle.db, null, NOW, true)).toHaveLength(1);
  });
});
