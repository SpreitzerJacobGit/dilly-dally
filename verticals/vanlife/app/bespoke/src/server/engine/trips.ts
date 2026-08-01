/**
 * Trip-level writes that are more than a column set: editing the route's two
 * endpoints, and retiring a trip.
 *
 * Both live here rather than in routers.ts because both carry rules that are
 * worth testing without standing up a tRPC caller — what resets the frozen
 * baseline, what a delete is actually allowed to remove, and which trip may
 * push notifications at the operators.
 */
import { and, eq, like } from "@elements/storage-sqlite-drizzle";
import { appSettings } from "@elements/lifecycle-app-settings";
import {
  daySelections,
  digests,
  poiMarks,
  progressEvents,
  routeCandidates,
  routeLegs,
  trips,
  waypoints,
} from "../../db/schema.js";
import { loadNeedStates } from "./needs.js";
import { planDateOf } from "./candidates.js";

type Db = Parameters<typeof loadNeedStates>[0];

const nowIso = (): string => new Date().toISOString();

/**
 * Only the trip the van is actually on may push at the operators.
 *
 * Planning a second trip generates candidates for it — including urgent
 * warnings — but those warnings are about a journey nobody is on. Waking two
 * people's phones for a hypothetical is exactly the kind of noise that gets
 * push notifications turned off entirely.
 */
export function shouldPushWarnings(trip: { status: string }): boolean {
  return trip.status === "active";
}

export interface TripUpdateInput {
  id: number;
  name?: string;
  originName?: string;
  origin?: { lat: number; lng: number };
  destName?: string;
  dest?: { lat: number; lng: number };
  dailyDriveHours?: number;
  deviationBudgetRatio?: number;
  startDate?: string | null;
}

export interface TripUpdateResult {
  id: number;
  /** The endpoints moved, so the frozen direct duration was cleared. */
  baselineReset: boolean;
  /** Today's unselected candidates expired because they end somewhere else now. */
  expiredCandidates: number;
  /** Today's *selected* plan was kept, and still ends at the old final Target. */
  selectionStale: boolean;
}

/** Whether the update moves either endpoint of the route. */
export function movesEndpoints(
  trip: { originLat: number; originLng: number; destLat: number; destLng: number },
  input: TripUpdateInput,
): boolean {
  const movedOrigin =
    input.origin !== undefined && (input.origin.lat !== trip.originLat || input.origin.lng !== trip.originLng);
  const movedDest =
    input.dest !== undefined && (input.dest.lat !== trip.destLat || input.dest.lng !== trip.destLng);
  return movedOrigin || movedDest;
}

/**
 * Edit a trip's name, Origin, or final Target.
 *
 * Moving an endpoint invalidates the frozen baseline, because the deviation
 * budget is a multiple of the direct drive between exactly those two points.
 * Renaming does not — a spurious reset would silently move the budget the next
 * time routing answered, and a budget that changes for no stated reason is the
 * kind of quiet lie this app is built against.
 *
 * The re-route is deliberately NOT done here. ensureBaseline() fills the null
 * lazily on the next plan and already degrades honestly when OSRM is down;
 * routing inline would make *renaming a trip* fail with the router unreachable.
 */
export async function applyTripUpdate(db: Db, input: TripUpdateInput): Promise<TripUpdateResult> {
  const trip = (await db.select().from(trips).where(eq(trips.id, input.id)))[0];
  if (!trip) throw new Error("Trip not found");

  const baselineReset = movesEndpoints(trip, input);

  await db
    .update(trips)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.originName !== undefined ? { originName: input.originName } : {}),
      ...(input.origin !== undefined ? { originLat: input.origin.lat, originLng: input.origin.lng } : {}),
      ...(input.destName !== undefined ? { destName: input.destName } : {}),
      ...(input.dest !== undefined ? { destLat: input.dest.lat, destLng: input.dest.lng } : {}),
      ...(input.dailyDriveHours !== undefined ? { dailyDriveHours: input.dailyDriveHours } : {}),
      ...(input.deviationBudgetRatio !== undefined ? { deviationBudgetRatio: input.deviationBudgetRatio } : {}),
      ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
      ...(baselineReset ? { directDurationMinutes: null } : {}),
      updatedAt: nowIso(),
    })
    .where(eq(trips.id, input.id));

  // The stored plan fingerprint is deliberately left alone: it spreads the
  // whole trip row, so moving an endpoint already makes the live hash differ
  // and replan rebuilds on its own.
  let expiredCandidates = 0;
  let selectionStale = false;
  if (baselineReset) {
    const date = planDateOf(nowIso());
    // Today's proposals end at a place that is no longer the destination, and
    // plan.today only rebuilds when none exist. Expire them so the map stops
    // showing routes to somewhere the trip no longer goes.
    const expired = await db
      .update(routeCandidates)
      .set({ status: "expired" })
      .where(
        and(
          eq(routeCandidates.tripId, input.id),
          eq(routeCandidates.planDate, date),
          eq(routeCandidates.status, "proposed"),
        ),
      )
      .returning({ id: routeCandidates.id });
    expiredCandidates = expired.length;
    // A plan the operators actually chose is theirs, not ours to delete. Keep
    // it and say it is stale.
    const kept = await db
      .select({ id: routeCandidates.id })
      .from(routeCandidates)
      .where(
        and(
          eq(routeCandidates.tripId, input.id),
          eq(routeCandidates.planDate, date),
          eq(routeCandidates.status, "selected"),
        ),
      );
    selectionStale = kept.length > 0;
  }

  return { id: input.id, baselineReset, expiredCandidates, selectionStale };
}

export interface TripDeleteResult {
  id: number;
  deleted: {
    legs: number;
    selections: number;
    candidates: number;
    digests: number;
    progress: number;
    marks: number;
    targets: number;
  };
  settingsCleared: number;
}

/**
 * Delete a trip and everything hanging off it.
 *
 * Explicit and deepest-first, following removeAnchor's precedent: the FK
 * cascades would do most of it, but being explicit means the counts reported
 * back are the truth. The one thing no cascade covers is the plan-fingerprint
 * settings row, which is keyed by string and would otherwise outlive the trip.
 */
export async function deleteTrip(db: Db, id: number): Promise<TripDeleteResult> {
  const candidateIds = (
    await db.select({ id: routeCandidates.id }).from(routeCandidates).where(eq(routeCandidates.tripId, id))
  ).map((r) => r.id);

  let legs = 0;
  for (const candidateId of candidateIds) {
    const removed = await db
      .delete(routeLegs)
      .where(eq(routeLegs.candidateId, candidateId))
      .returning({ id: routeLegs.id });
    legs += removed.length;
  }
  const selections = await db.delete(daySelections).where(eq(daySelections.tripId, id)).returning({
    id: daySelections.id,
  });
  const candidates = await db.delete(routeCandidates).where(eq(routeCandidates.tripId, id)).returning({
    id: routeCandidates.id,
  });
  const digestRows = await db.delete(digests).where(eq(digests.tripId, id)).returning({ id: digests.id });
  const progress = await db.delete(progressEvents).where(eq(progressEvents.tripId, id)).returning({
    id: progressEvents.id,
  });
  const marks = await db.delete(poiMarks).where(eq(poiMarks.tripId, id)).returning({ id: poiMarks.id });

  // Deepest first, so a parent never disappears out from under a child.
  const targetRows = await db
    .select({ id: waypoints.id, depth: waypoints.depth })
    .from(waypoints)
    .where(eq(waypoints.tripId, id));
  for (const row of [...targetRows].sort((a, b) => b.depth - a.depth)) {
    await db.delete(waypoints).where(eq(waypoints.id, row.id));
  }

  const settingsCleared = await clearPlanFingerprints(db, id);
  await db.delete(trips).where(eq(trips.id, id));

  return {
    id,
    deleted: {
      legs,
      selections: selections.length,
      candidates: candidates.length,
      digests: digestRows.length,
      progress: progress.length,
      marks: marks.length,
      targets: targetRows.length,
    },
    settingsCleared,
  };
}

/** The `plan-fingerprint:<tripId>:<date>` rows no foreign key reaches. */
async function clearPlanFingerprints(db: Db, tripId: number): Promise<number> {
  const removed = await db
    .delete(appSettings)
    .where(like(appSettings.key, `plan-fingerprint:${String(tripId)}:%`))
    .returning({ key: appSettings.key });
  return removed.length;
}
