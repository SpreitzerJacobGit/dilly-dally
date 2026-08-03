/**
 * Managing the set of tracked needs itself: keys, archiving, and what deletion
 * actually destroys.
 *
 * The assertions that matter here are the ones about data loss. Archiving must
 * keep everything; permanent deletion must take the check-ins and rates with it
 * rather than orphaning them; and a mode switch must not quietly discard the
 * history that justified the old mode.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, createDb, type DbHandle } from "@elements/storage-sqlite-drizzle";
import { users } from "@elements/identity-session-auth";
import { checkIns, needRates, needs } from "../src/db/schema.js";
import { loadNeedStates, slugifyKey } from "../src/server/engine/needs.js";

const NOW = "2026-08-03T12:00:00.000Z";

describe("slugifyKey — a stable key that survives renames", () => {
  it("slugifies a title", () => {
    expect(slugifyKey("Oil change", new Set())).toBe("oil-change");
    expect(slugifyKey("Propane", new Set())).toBe("propane");
  });

  it("collapses punctuation and trims the edges rather than emitting bare dashes", () => {
    expect(slugifyKey("  Waste-water (grey)!! ", new Set())).toBe("waste-water-grey");
  });

  it("suffixes a collision instead of rejecting it — a second Propane is reasonable", () => {
    expect(slugifyKey("Propane", new Set(["propane"]))).toBe("propane-2");
    expect(slugifyKey("Propane", new Set(["propane", "propane-2"]))).toBe("propane-3");
  });

  it("still yields a usable key when the title has nothing sluggable in it", () => {
    expect(slugifyKey("!!!", new Set())).toBe("need");
    expect(slugifyKey("!!!", new Set(["need"]))).toBe("need-2");
  });
});

describe("archiving and deleting a need", () => {
  let handle: DbHandle;
  let userId: number;

  async function migrate(h: DbHandle): Promise<void> {
    const md = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
    for (const f of fs.readdirSync(md).filter((x) => x.endsWith(".sql")).sort())
      for (const s of fs.readFileSync(path.join(md, f), "utf8").split("--> statement-breakpoint"))
        if (s.trim()) await h.client.execute(s);
  }

  /** A level need with one rate and one check-in — enough to lose something. */
  async function insertNeedWithHistory(): Promise<number> {
    const rows = await handle.db
      .insert(needs)
      .values({
        key: "propane",
        title: "Propane",
        direction: "depletes",
        warnRatio: 0.25,
        urgentRatio: 0.1,
        poiCategory: null,
        routingDriver: false,
        sortOrder: 9,
        active: true,
        trackingMode: "level",
      })
      .returning({ id: needs.id });
    const needId = rows[0]!.id;
    await handle.db.insert(needRates).values({
      needId,
      ratePerDay: 2.5,
      ratePerMile: 0,
      source: "manual",
      effectiveFrom: NOW,
      note: null,
      createdAt: NOW,
    });
    await handle.db.insert(checkIns).values({
      needId,
      kind: "service",
      quantity: null,
      note: "Filled in Bishop",
      lat: null,
      lng: null,
      poiId: null,
      recordedBy: userId,
      clientId: null,
      occurredAt: NOW,
      createdAt: NOW,
    });
    return needId;
  }

  beforeEach(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vl-needs-crud-"));
    handle = await createDb({ dbFile: path.join(dir, "t.db") });
    await migrate(handle);
    const u = await handle.db
      .insert(users)
      .values({ email: "jacob@vanlife.test", passwordHash: "x", role: "operator", createdAt: NOW })
      .returning({ id: users.id });
    userId = u[0]!.id;
  });
  afterEach(() => handle.close());

  it("archiving hides the need everywhere but keeps every row it owns", async () => {
    const needId = await insertNeedWithHistory();
    await handle.db.update(needs).set({ active: false }).where(eq(needs.id, needId));

    expect(await loadNeedStates(handle.db, null, NOW)).toHaveLength(0);
    expect(await loadNeedStates(handle.db, null, NOW, true)).toHaveLength(1);
    expect(await handle.db.select().from(checkIns).where(eq(checkIns.needId, needId))).toHaveLength(1);
    expect(await handle.db.select().from(needRates).where(eq(needRates.needId, needId))).toHaveLength(1);
  });

  it("restoring an archived need brings it back with its history intact", async () => {
    const needId = await insertNeedWithHistory();
    await handle.db.update(needs).set({ active: false }).where(eq(needs.id, needId));
    await handle.db.update(needs).set({ active: true }).where(eq(needs.id, needId));

    const states = await loadNeedStates(handle.db, null, NOW);
    expect(states).toHaveLength(1);
    expect(states[0]!.lastCheckInAt).toBe(NOW);
  });

  it("deleting takes the check-ins and rates with it rather than orphaning them", async () => {
    const needId = await insertNeedWithHistory();
    await handle.db.delete(needs).where(eq(needs.id, needId));

    expect(await handle.db.select().from(needs)).toHaveLength(0);
    expect(await handle.db.select().from(checkIns)).toHaveLength(0);
    expect(await handle.db.select().from(needRates)).toHaveLength(0);
  });

  it("switching a level need to date tracking keeps its check-in history", async () => {
    const needId = await insertNeedWithHistory();
    await handle.db
      .update(needs)
      .set({ trackingMode: "date", dueAt: "2026-12-01T23:59:59.000Z", warnDays: 30, urgentDays: 7 })
      .where(eq(needs.id, needId));

    expect(await handle.db.select().from(checkIns).where(eq(checkIns.needId, needId))).toHaveLength(1);
    const [state] = await loadNeedStates(handle.db, null, NOW);
    expect(state!.deadlineAt).toBe("2026-12-01T23:59:59.000Z");
    // The old rate row survives, but a date need must not report a rate.
    expect(state!.rate.ratePerDay).toBe(0);
  });
});
