import type { SeedFn } from "@elements/lifecycle-migrate-seed";
import { users } from "@elements/identity-session-auth";
import {
  checkIns,
  interestWeights,
  needRates,
  needs,
  pois,
  trips,
  waypoints,
} from "../db/schema.js";
import {
  FIXTURE_NEEDS,
  FIXTURE_POIS,
  FIXTURE_TRIP,
  FIXTURE_WAYPOINT,
  FIXTURE_WEIGHTS,
} from "../seed/fixtures.js";

/** Runs exactly once per database (seed ledger); identity users exist first. */
export const seedVanlifeData: SeedFn = {
  id: "vanlife-fixtures",
  run: async (handle) => {
    const db = handle.db;
    const now = Date.now();
    const iso = (daysAgo: number): string => new Date(now - daysAgo * 86_400_000).toISOString();

    const firstUser = (await db.select({ id: users.id }).from(users).limit(1))[0];
    if (!firstUser) throw new Error("identity seed must run before vanlife fixtures");

    const trip = (
      await db
        .insert(trips)
        .values({
          name: FIXTURE_TRIP.name,
          status: "active",
          originName: FIXTURE_TRIP.originName,
          originLat: FIXTURE_TRIP.originLat,
          originLng: FIXTURE_TRIP.originLng,
          destName: FIXTURE_TRIP.destName,
          destLat: FIXTURE_TRIP.destLat,
          destLng: FIXTURE_TRIP.destLng,
          directDurationMinutes: null, // computed lazily from the router
          deviationBudgetRatio: FIXTURE_TRIP.deviationBudgetRatio,
          dailyDriveHours: FIXTURE_TRIP.dailyDriveHours,
          startDate: iso(FIXTURE_TRIP.startedDaysAgo).slice(0, 10),
          createdAt: iso(FIXTURE_TRIP.startedDaysAgo),
          updatedAt: iso(FIXTURE_TRIP.startedDaysAgo),
        })
        .returning({ id: trips.id })
    )[0]!;

    await db.insert(waypoints).values({
      tripId: trip.id,
      name: FIXTURE_WAYPOINT.name,
      lat: FIXTURE_WAYPOINT.lat,
      lng: FIXTURE_WAYPOINT.lng,
      kind: FIXTURE_WAYPOINT.kind,
      orderIndex: 0,
      status: "pending",
      notes: FIXTURE_WAYPOINT.notes,
      createdAt: iso(FIXTURE_TRIP.startedDaysAgo),
    });

    for (const need of FIXTURE_NEEDS) {
      const inserted = (
        await db
          .insert(needs)
          .values({
            key: need.key,
            title: need.title,
            unit: need.unit,
            capacity: need.capacity,
            direction: need.direction,
            warnRatio: need.warnRatio,
            urgentRatio: need.urgentRatio,
            poiCategory: need.poiCategory,
            routingDriver: need.routingDriver,
            sortOrder: need.sortOrder,
            active: true,
          })
          .returning({ id: needs.id })
      )[0]!;
      await db.insert(needRates).values({
        needId: inserted.id,
        ratePerDay: need.ratePerDay,
        ratePerMile: need.ratePerMile,
        source: "manual",
        effectiveFrom: iso(30),
        note: "Initial manual estimate",
        createdAt: iso(30),
      });
      for (const c of need.checkIns) {
        await db.insert(checkIns).values({
          needId: inserted.id,
          kind: c.kind,
          quantity: c.quantity,
          note: c.note ?? null,
          recordedBy: firstUser.id,
          occurredAt: iso(c.daysAgo),
          createdAt: iso(c.daysAgo),
        });
      }
    }

    const poiStamp = iso(1);
    for (const p of FIXTURE_POIS) {
      await db.insert(pois).values({
        source: p.source,
        sourceId: p.sourceId,
        name: p.name,
        category: p.category,
        lat: p.lat,
        lng: p.lng,
        popularity: p.popularity,
        fetchedAt: poiStamp,
        updatedAt: poiStamp,
      });
    }

    for (const w of FIXTURE_WEIGHTS) {
      await db.insert(interestWeights).values({
        category: w.category,
        weight: w.weight,
        updatedAt: poiStamp,
      });
    }
  },
};
