import type { SeedFn } from "@elements/lifecycle-migrate-seed";
import { users } from "@elements/identity-session-auth";
import {
  checkIns,
  interestWeights,
  needRates,
  needs,
  pois,
  staySites,
  trips,
  waypoints,
} from "../db/schema.js";
import {
  FIXTURE_NEEDS,
  fixtureRates,
  FIXTURE_POIS,
  FIXTURE_TRIP,
  FIXTURE_ANCHOR,
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
      name: FIXTURE_ANCHOR.name,
      lat: FIXTURE_ANCHOR.lat,
      lng: FIXTURE_ANCHOR.lng,
      radiusMiles: FIXTURE_ANCHOR.radiusMiles,
      parentId: null,
      depth: 0,
      kind: FIXTURE_ANCHOR.kind,
      orderIndex: 0,
      status: "pending",
      notes: FIXTURE_ANCHOR.notes,
      createdAt: iso(FIXTURE_TRIP.startedDaysAgo),
    });

    for (const need of FIXTURE_NEEDS) {
      const inserted = (
        await db
          .insert(needs)
          .values({
            key: need.key,
            title: need.title,
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
        ...fixtureRates(need),
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
      const inserted = await db
        .insert(pois)
        .values({
          source: p.source,
          sourceId: p.sourceId,
          name: p.name,
          category: p.category,
          lat: p.lat,
          lng: p.lng,
          popularity: p.popularity,
          fetchedAt: poiStamp,
          updatedAt: poiStamp,
        })
        .returning({ id: pois.id });
      if (!p.stay) continue;
      // Everything the fixture leaves unsaid stays unknown: an unpriced site is
      // not free and an untagged road is not passable.
      await db.insert(staySites).values({
        poiId: inserted[0]!.id,
        stayKind: p.stay.stayKind,
        nightlyCostUsd: p.stay.nightlyCostUsd ?? null,
        hookupElectric: p.stay.hookupElectric ?? false,
        hookupWater: p.stay.hookupWater ?? false,
        dumpStation: p.stay.dumpStation ?? false,
        showers: p.stay.showers ?? false,
        laundryOnSite: p.stay.laundryOnSite ?? false,
        reservable: p.stay.reservable ?? "unknown",
        access: p.stay.access ?? "unknown",
        maxNights: p.stay.maxNights ?? null,
        lastReportedAt: poiStamp,
        confidence: p.stay.confidence ?? "unverified",
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
