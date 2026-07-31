import { z } from "zod";
import { router, TRPCError } from "@elements/lifecycle-service-runtime";
import { protectedProcedure } from "@elements/identity-session-auth";
import { intakeWrite, rejectIntake } from "@elements/intake-form-intake";
import { and, asc, desc, eq, gte, inArray, lte } from "@elements/storage-sqlite-drizzle";
import {
  createPoiSourcesStatusRouter,
  importPoiDataset,
  PoiRecordSchema,
} from "@elements/intake-poi-sources";
import { createNtfyStatusRouter } from "@elements/output-ntfy-push";
import { getSetting, setSetting } from "@elements/lifecycle-app-settings";
import {
  checkIns,
  daySelections,
  digests,
  interestWeights,
  needRates,
  needs,
  poiMarks,
  pois,
  progressEvents,
  routeCandidates,
  routeLegs,
  trips,
  waypoints,
} from "../db/schema.js";
import {
  targetAddSchema,
  targetPinSchema,
  targetPromoteSchema,
  targetReorderSchema,
  targetReparentSchema,
  targetUpdateSchema,
  bboxSchema,
  checkInSchema,
  needConfigureSchema,
  rateSetSchema,
  tripCreateSchema,
  tripUpdateSchema,
} from "./schemas.js";
import { checkInHistory, loadNeedStates } from "./engine/needs.js";
import {
  budgetUsage,
  buildDailyCandidates,
  currentPosition,
  ensureBaseline,
  persistCandidates,
  planDateOf,
  planStateFingerprint,
  storedPlanFingerprint,
  type CandidateWarning,
  type TripRow,
} from "./engine/candidates.js";
import { anchorPois, corridorPois } from "./engine/pois.js";
import { withinDisc } from "./engine/geo.js";
import {
  anchorHorizons,
  depthUpdates,
  findNode,
  flattenPendingAnchors,
  isDescendant,
  loadAnchorTree,
  loadSiblings,
  resolveAnchorChain,
  subtreeHeight,
  subtreeIds,
} from "./engine/anchors.js";
import { osrmRoute, OsrmUnavailableError } from "./engine/osrm.js";
import { applyTripUpdate, deleteTrip, shouldPushWarnings } from "./engine/trips.js";
import { buildTargetViews } from "./engine/targets.js";
import {
  composeDigest,
  DIGEST_SETTINGS_KEY,
  DigestSettingsSchema,
  generateAndDeliverDigest,
  pushUrgentWarnings,
} from "./engine/digest.js";
import { onPois } from "./poiHook.js";

const op = protectedProcedure;
const nowIso = (): string => new Date().toISOString();

async function tripOr404(db: Parameters<typeof loadNeedStates>[0], id: number) {
  const rows = await db.select().from(trips).where(eq(trips.id, id));
  const trip = rows[0];
  if (!trip) throw new TRPCError({ code: "NOT_FOUND", message: "trip not found" });
  return trip;
}

async function activeTrip(db: Parameters<typeof loadNeedStates>[0]) {
  const rows = await db.select().from(trips).where(eq(trips.status, "active")).limit(1);
  return rows[0] ?? null;
}

export const tripsRouter = router({
  list: op.query(async ({ ctx }) =>
    ctx.dbHandle.db.select().from(trips).orderBy(desc(trips.createdAt)),
  ),

  active: op.query(async ({ ctx }) => activeTrip(ctx.dbHandle.db)),

  get: op.input(z.object({ id: z.number().int() })).query(async ({ ctx, input }) => {
    const db = ctx.dbHandle.db;
    const trip = await tripOr404(db, input.id);
    const wps = await db
      .select()
      .from(waypoints)
      .where(eq(waypoints.tripId, trip.id))
      .orderBy(asc(waypoints.orderIndex), asc(waypoints.id));
    const usage = await budgetUsage(db, trip);
    const position = await currentPosition(db, trip);
    const recentProgress = await db
      .select()
      .from(progressEvents)
      .where(eq(progressEvents.tripId, trip.id))
      .orderBy(desc(progressEvents.occurredAt), desc(progressEvents.id))
      .limit(30);
    const targets = await buildTargetViews(db, trip, position, nowIso());
    return { ...trip, waypoints: wps, targets, usage, position, recentProgress };
  }),

  create: op.input(tripCreateSchema).mutation(
    intakeWrite(async ({ db, input }) => {
      const existing = await db.select({ id: trips.id }).from(trips).where(eq(trips.status, "active"));
      const now = nowIso();
      let directDurationMinutes: number | null = null;
      try {
        const route = await osrmRoute([input.origin, input.dest], { overview: "false" });
        directDurationMinutes = route.durationMinutes;
      } catch (err) {
        if (!(err instanceof OsrmUnavailableError)) throw err;
        // Created anyway; the baseline is computed lazily once routing is back.
      }
      const inserted = await db
        .insert(trips)
        .values({
          name: input.name,
          status: existing.length === 0 ? "active" : "planning",
          originName: input.originName,
          originLat: input.origin.lat,
          originLng: input.origin.lng,
          destName: input.destName,
          destLat: input.dest.lat,
          destLng: input.dest.lng,
          directDurationMinutes,
          deviationBudgetRatio: input.deviationBudgetRatio,
          dailyDriveHours: input.dailyDriveHours,
          startDate: input.startDate ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: trips.id });
      return {
        id: inserted[0]!.id,
        directDurationMinutes,
        budgetMinutes: directDurationMinutes === null ? null : directDurationMinutes * input.deviationBudgetRatio,
      };
    }),
  ),

  /**
   * Edit the trip's name, Origin, final Target, or pace. Moving an endpoint
   * resets the frozen baseline; renaming does not — see engine/trips.ts.
   */
  update: op.input(tripUpdateSchema).mutation(
    intakeWrite(async ({ db, input }) => {
      const trip = await tripOr404(db, input.id);
      const editsRoute =
        input.origin !== undefined ||
        input.dest !== undefined ||
        input.deviationBudgetRatio !== undefined ||
        input.dailyDriveHours !== undefined;
      if (editsRoute && (trip.status === "completed" || trip.status === "archived")) {
        rejectIntake("A completed trip's route can't be edited — its history is the record.");
      }
      return applyTripUpdate(db, input);
    }),
  ),

  delete: op.input(z.object({ id: z.number().int() })).mutation(
    intakeWrite(async ({ db, input }) => {
      const trip = await tripOr404(db, input.id);
      if (trip.status === "active") {
        rejectIntake(
          "This is the trip the van is on; the morning digest and needs runway follow it. Complete it first.",
        );
      }
      return deleteTrip(db, input.id);
    }),
  ),

  setStatus: op
    .input(z.object({ id: z.number().int(), status: z.enum(["planning", "active", "completed", "archived"]) }))
    .mutation(
      intakeWrite(async ({ db, input }) => {
        await tripOr404(db, input.id);
        if (input.status === "active") {
          // Exactly one active trip: activating one demotes any other.
          const others = await db.select({ id: trips.id }).from(trips).where(eq(trips.status, "active"));
          for (const o of others) {
            if (o.id !== input.id) {
              await db.update(trips).set({ status: "planning", updatedAt: nowIso() }).where(eq(trips.id, o.id));
            }
          }
        }
        await db.update(trips).set({ status: input.status, updatedAt: nowIso() }).where(eq(trips.id, input.id));
        return { id: input.id };
      }),
    ),

  markTarget: op
    .input(z.object({ id: z.number().int(), status: z.enum(["pending", "visited", "skipped"]) }))
    .mutation(
      intakeWrite(async ({ db, input }) => {
        const updated = await db
          .update(waypoints)
          .set({ status: input.status })
          .where(eq(waypoints.id, input.id))
          .returning({ id: waypoints.id });
        if (updated.length === 0) rejectIntake("Waypoint not found");
        return { id: input.id };
      }),
    ),

  /* ── Anchors ─────────────────────────────────────────────────────────────
   * A waypoint with a radius. Narrowing happens by adding a child, so the
   * broad intent survives and deleting the child restores it.
   */

  addTarget: op.input(targetAddSchema).mutation(
    intakeWrite(async ({ db, input }) => {
      await tripOr404(db, input.tripId);
      let depth = 0;
      if (input.parentId !== null) {
        const parent = (await db.select().from(waypoints).where(eq(waypoints.id, input.parentId)))[0];
        if (!parent) rejectIntake("That parent anchor no longer exists.");
        if (parent!.tripId !== input.tripId) rejectIntake("That parent anchor belongs to another trip.");
        if (parent!.depth >= 2) rejectIntake("Anchors nest three levels deep at most.");
        if (parent!.radiusMiles > 0) {
          if (input.radiusMiles >= parent!.radiusMiles) {
            rejectIntake(
              `A narrower anchor must be smaller than "${parent!.name}" (${String(parent!.radiusMiles)} mi).`,
            );
          }
          // Narrowing means narrowing: a child outside its parent's area would
          // make the parent's own region meaningless.
          if (!withinDisc(input.center, { lat: parent!.lat, lng: parent!.lng }, parent!.radiusMiles)) {
            rejectIntake(`That spot is outside "${parent!.name}".`);
          }
        }
        depth = parent!.depth + 1;
      }
      const siblings = await loadSiblings(db, input.tripId, input.parentId);
      const inserted = await db
        .insert(waypoints)
        .values({
          tripId: input.tripId,
          name: input.name,
          lat: input.center.lat,
          lng: input.center.lng,
          radiusMiles: input.radiusMiles,
          parentId: input.parentId,
          depth,
          kind: input.kind,
          poiId: input.poiId ?? null,
          orderIndex: (siblings[siblings.length - 1]?.orderIndex ?? -1) + 1,
          arriveBy: input.arriveBy ?? null,
          notes: input.notes ?? null,
          createdAt: nowIso(),
        })
        .returning({ id: waypoints.id });
      return { id: inserted[0]!.id };
    }),
  ),

  updateTarget: op.input(targetUpdateSchema).mutation(
    intakeWrite(async ({ db, input }) => {
      const row = (await db.select().from(waypoints).where(eq(waypoints.id, input.id)))[0];
      if (!row) rejectIntake("Anchor not found");
      const center = input.center ?? { lat: row!.lat, lng: row!.lng };
      const radius = input.radiusMiles ?? row!.radiusMiles;

      // Shrinking must not orphan what is already inside: say which child or
      // pin would fall out rather than silently moving it.
      if (radius > 0) {
        const kids = await db.select().from(waypoints).where(eq(waypoints.parentId, input.id));
        for (const k of kids) {
          if (!withinDisc({ lat: k.lat, lng: k.lng }, center, radius)) {
            rejectIntake(`"${k.name}" would fall outside this anchor — move or remove it first.`);
          }
        }
        if (row!.pinnedLat !== null && row!.pinnedLng !== null) {
          if (!withinDisc({ lat: row!.pinnedLat, lng: row!.pinnedLng }, center, radius)) {
            rejectIntake("The pinned spot would fall outside this anchor — clear the pin first.");
          }
        }
      }

      await db
        .update(waypoints)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.center !== undefined ? { lat: input.center.lat, lng: input.center.lng } : {}),
          ...(input.radiusMiles !== undefined ? { radiusMiles: input.radiusMiles } : {}),
          ...(input.arriveBy !== undefined ? { arriveBy: input.arriveBy } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        })
        .where(eq(waypoints.id, input.id));
      return { id: input.id };
    }),
  ),

  removeTarget: op.input(z.object({ id: z.number().int() })).mutation(
    intakeWrite(async ({ db, input }) => {
      const row = (await db.select().from(waypoints).where(eq(waypoints.id, input.id)))[0];
      if (!row) rejectIntake("Anchor not found");
      // Delete the subtree explicitly, deepest first. The FK cascade would do
      // it too, but being explicit means the count we report is the truth.
      const tree = await loadAnchorTree(db, row!.tripId);
      const node = findNode(tree, input.id);
      const ids = node ? subtreeIds(node) : [input.id];
      for (const id of [...ids].reverse()) {
        await db.delete(waypoints).where(eq(waypoints.id, id));
      }
      // Close the gap so the level stays dense, as after a move.
      const left = await loadSiblings(db, row!.tripId, row!.parentId ?? null);
      for (const [i, s] of left.entries()) {
        await db.update(waypoints).set({ orderIndex: i }).where(eq(waypoints.id, s.id));
      }
      return { removed: ids.length };
    }),
  ),

  reorderTargets: op.input(targetReorderSchema).mutation(
    intakeWrite(async ({ db, input }) => {
      for (let i = 0; i < input.orderedIds.length; i++) {
        await db
          .update(waypoints)
          .set({ orderIndex: i })
          .where(and(eq(waypoints.id, input.orderedIds[i]!), eq(waypoints.tripId, input.tripId)));
      }
      return { tripId: input.tripId };
    }),
  ),

  /**
   * Move an anchor to a new parent and position — the drag-and-drop verb.
   * Dropping onto an anchor nests (narrows); dropping between siblings
   * reorders. Every invariant addTarget enforces is re-checked here, because a
   * drag can violate all of them at once.
   */
  reparentTarget: op.input(targetReparentSchema).mutation(
    intakeWrite(async ({ db, input }) => {
      const row = (await db.select().from(waypoints).where(eq(waypoints.id, input.id)))[0];
      if (!row) rejectIntake("Anchor not found");
      if (input.parentId === input.id) rejectIntake("An anchor cannot be nested inside itself.");

      const tree = await loadAnchorTree(db, row!.tripId);
      const node = findNode(tree, input.id);
      if (!node) rejectIntake("Anchor not found");

      let depth = 0;
      if (input.parentId !== null) {
        const parent = (await db.select().from(waypoints).where(eq(waypoints.id, input.parentId)))[0];
        if (!parent) rejectIntake("That parent anchor no longer exists.");
        if (parent!.tripId !== row!.tripId) rejectIntake("That parent anchor belongs to another trip.");
        // Dropping a parent into its own descendant would detach the subtree
        // from the tree entirely.
        if (isDescendant(tree, input.parentId, input.id)) {
          rejectIntake("An anchor cannot be nested inside its own narrowing.");
        }
        depth = parent!.depth + 1;
        if (depth + subtreeHeight(node!) > 2) {
          rejectIntake("That move would nest anchors more than three levels deep.");
        }
        if (parent!.radiusMiles > 0) {
          if (row!.radiusMiles >= parent!.radiusMiles) {
            rejectIntake(
              `"${row!.name}" is not smaller than "${parent!.name}" (${String(parent!.radiusMiles)} mi), so it cannot narrow it.`,
            );
          }
          if (!withinDisc({ lat: row!.lat, lng: row!.lng }, { lat: parent!.lat, lng: parent!.lng }, parent!.radiusMiles)) {
            rejectIntake(`"${row!.name}" sits outside "${parent!.name}".`);
          }
        }
      }

      // Slot into the destination level, then resequence it so orderIndex stays
      // dense and the drop position is exactly what the operator saw.
      const siblings = (await loadSiblings(db, row!.tripId, input.parentId)).filter((s) => s.id !== input.id);
      const at = Math.max(0, Math.min(input.orderIndex, siblings.length));
      const ordered = [...siblings.slice(0, at).map((s) => s.id), input.id, ...siblings.slice(at).map((s) => s.id)];

      await db
        .update(waypoints)
        .set({ parentId: input.parentId })
        .where(eq(waypoints.id, input.id));
      for (const u of depthUpdates(node!, depth)) {
        await db.update(waypoints).set({ depth: u.depth }).where(eq(waypoints.id, u.id));
      }
      for (const [i, id] of ordered.entries()) {
        await db.update(waypoints).set({ orderIndex: i }).where(eq(waypoints.id, id));
      }
      // Close the hole the move left behind, so both levels stay dense and the
      // ↑/↓ buttons keep agreeing with what the list shows.
      const from = row!.parentId ?? null;
      if (from !== input.parentId) {
        const left = (await loadSiblings(db, row!.tripId, from)).filter((s) => s.id !== input.id);
        for (const [i, s] of left.entries()) {
          await db.update(waypoints).set({ orderIndex: i }).where(eq(waypoints.id, s.id));
        }
      }
      return { id: input.id, parentId: input.parentId, orderIndex: at };
    }),
  ),

  pinTargetPoint: op.input(targetPinSchema).mutation(
    intakeWrite(async ({ db, input }) => {
      const row = (await db.select().from(waypoints).where(eq(waypoints.id, input.id)))[0];
      if (!row) rejectIntake("Anchor not found");
      if (input.point !== null) {
        if (row!.radiusMiles <= 0) rejectIntake("An exact-point anchor has nothing to pin inside.");
        if (!withinDisc(input.point, { lat: row!.lat, lng: row!.lng }, row!.radiusMiles)) {
          rejectIntake("That spot is outside the anchor's area.");
        }
      }
      await db
        .update(waypoints)
        .set({
          pinnedLat: input.point?.lat ?? null,
          pinnedLng: input.point?.lng ?? null,
          pinnedPoiId: input.point === null ? null : input.poiId,
        })
        .where(eq(waypoints.id, input.id));
      return { id: input.id };
    }),
  ),

  /** The narrowing verb: a suggested place becomes a child anchor. */
  promotePoiToTarget: op.input(targetPromoteSchema).mutation(
    intakeWrite(async ({ db, input }) => {
      const parent = (await db.select().from(waypoints).where(eq(waypoints.id, input.parentId)))[0];
      if (!parent) rejectIntake("That anchor no longer exists.");
      if (parent!.depth >= 2) rejectIntake("Anchors nest three levels deep at most.");
      const poi = (await db.select().from(pois).where(eq(pois.id, input.poiId)))[0];
      if (!poi) rejectIntake("That place no longer exists.");
      if (parent!.radiusMiles > 0 && input.radiusMiles >= parent!.radiusMiles) {
        rejectIntake(`A narrower anchor must be smaller than "${parent!.name}".`);
      }
      const siblings = await loadSiblings(db, parent!.tripId, parent!.id);
      const inserted = await db
        .insert(waypoints)
        .values({
          tripId: parent!.tripId,
          name: input.name ?? poi!.name,
          lat: poi!.lat,
          lng: poi!.lng,
          radiusMiles: input.radiusMiles,
          parentId: parent!.id,
          depth: parent!.depth + 1,
          kind: "poi",
          poiId: poi!.id,
          orderIndex: (siblings[siblings.length - 1]?.orderIndex ?? -1) + 1,
          createdAt: nowIso(),
        })
        .returning({ id: waypoints.id });
      // Pin the place for the trip too, so the day engine already favours it.
      await db
        .insert(poiMarks)
        .values({ tripId: parent!.tripId, poiId: poi!.id, mark: "pinned", createdAt: nowIso() })
        .onConflictDoUpdate({
          target: [poiMarks.tripId, poiMarks.poiId],
          set: { mark: "pinned", createdAt: nowIso() },
        });
      return { id: inserted[0]!.id };
    }),
  ),

  targetSuggestions: op
    .input(z.object({ targetId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const db = ctx.dbHandle.db;
      const row = (await db.select().from(waypoints).where(eq(waypoints.id, input.targetId)))[0];
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "target not found" });
      const found = await anchorPois(db, {
        tripId: row.tripId,
        center: { lat: row.lat, lng: row.lng },
        radiusMiles: row.radiusMiles,
        serviceCategories: [],
      });
      return {
        targetId: row.id,
        name: row.name,
        radiusMiles: row.radiusMiles,
        bbox: found.bbox,
        suggestions: found.suggestions,
      };
    }),

  setPosition: op
    .input(
      z.object({
        tripId: z.number().int(),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        milesSinceLast: z.number().min(0).max(2000).default(0),
      }),
    )
    .mutation(
      intakeWrite(async ({ db, input, ctx }) => {
        await tripOr404(db, input.tripId);
        await db.insert(progressEvents).values({
          tripId: input.tripId,
          kind: "position-set",
          lat: input.lat,
          lng: input.lng,
          milesDriven: input.milesSinceLast,
          driveSeconds: (input.milesSinceLast / 45) * 3600,
          recordedBy: ctx.user.id,
          occurredAt: nowIso(),
        });
        return { tripId: input.tripId };
      }),
    ),
});

async function candidatesWithLegs(db: Parameters<typeof loadNeedStates>[0], tripId: number, date: string) {
  const rows = await db
    .select()
    .from(routeCandidates)
    .where(
      and(
        eq(routeCandidates.tripId, tripId),
        eq(routeCandidates.planDate, date),
        inArray(routeCandidates.status, ["proposed", "selected"]),
      ),
    )
    .orderBy(asc(routeCandidates.id));
  const ids = rows.map((r) => r.id);
  const legs =
    ids.length === 0
      ? []
      : await db
          .select()
          .from(routeLegs)
          .where(inArray(routeLegs.candidateId, ids))
          .orderBy(asc(routeLegs.orderIndex));
  const selection = await db
    .select()
    .from(daySelections)
    .where(and(eq(daySelections.tripId, tripId), eq(daySelections.planDate, date)));
  return rows.map((c) => ({
    ...c,
    warnings: JSON.parse(c.warnings ?? "[]") as CandidateWarning[],
    stops: legs.filter((l) => l.candidateId === c.id),
    selected: selection[0]?.candidateId === c.id,
  }));
}

export const planRouter = router({
  today: op.input(z.object({ tripId: z.number().int() })).query(async ({ ctx, input }) => {
    const db = ctx.dbHandle.db;
    const trip = (await tripOr404(db, input.tripId)) as TripRow & { name: string; status: string };
    const date = planDateOf(nowIso());
    let stale = false;
    let message: string | null = null;
    let candidates = await candidatesWithLegs(db, trip.id, date);
    if (candidates.length === 0) {
      try {
        const built = await buildDailyCandidates(db, trip, nowIso());
        await persistCandidates(db, trip.id, date, built);
        if (shouldPushWarnings(trip)) {
          await pushUrgentWarnings(ctx.dbHandle, ctx.logger, trip, built.flatMap((b) => b.warnings), nowIso());
        }
        candidates = await candidatesWithLegs(db, trip.id, date);
      } catch (err) {
        if (!(err instanceof OsrmUnavailableError)) throw err;
        stale = true;
        message = err.message;
        // Serve the most recent plan we have, clearly marked stale.
        const latest = await db
          .select({ planDate: routeCandidates.planDate })
          .from(routeCandidates)
          .where(eq(routeCandidates.tripId, trip.id))
          .orderBy(desc(routeCandidates.planDate))
          .limit(1);
        if (latest[0]) candidates = await candidatesWithLegs(db, trip.id, latest[0].planDate);
      }
    }
    return { date, stale, message, candidates };
  }),

  replan: op.input(z.object({ tripId: z.number().int() })).mutation(async ({ ctx, input }) => {
    const db = ctx.dbHandle.db;
    const trip = (await tripOr404(db, input.tripId)) as TripRow & { name: string; status: string };
    const date = planDateOf(nowIso());
    // ROUTE-5: with no check-in, selection, position, or other state change
    // since today's build, replan is a read — serve the persisted candidates
    // byte-for-byte rather than regenerating them under a newer clock.
    const existing = await candidatesWithLegs(db, trip.id, date);
    if (existing.length > 0) {
      const stored = await storedPlanFingerprint(db, trip.id, date);
      if (stored !== null && stored === (await planStateFingerprint(db, trip.id))) {
        return { date, candidates: existing };
      }
    }
    try {
      const built = await buildDailyCandidates(db, trip, nowIso());
      await persistCandidates(db, trip.id, date, built);
      if (shouldPushWarnings(trip)) {
        await pushUrgentWarnings(ctx.dbHandle, ctx.logger, trip, built.flatMap((b) => b.warnings), nowIso());
      }
    } catch (err) {
      if (err instanceof OsrmUnavailableError) {
        throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: err.message });
      }
      throw err;
    }
    return { date, candidates: await candidatesWithLegs(db, trip.id, date) };
  }),

  select: op.input(z.object({ candidateId: z.number().int() })).mutation(
    intakeWrite(async ({ db, input, ctx }) => {
      const rows = await db.select().from(routeCandidates).where(eq(routeCandidates.id, input.candidateId));
      const candidate = rows[0];
      if (!candidate) rejectIntake("Candidate not found");
      const existing = await db
        .select()
        .from(daySelections)
        .where(and(eq(daySelections.tripId, candidate.tripId), eq(daySelections.planDate, candidate.planDate)));
      if (existing[0]) {
        await db
          .update(daySelections)
          .set({ candidateId: candidate.id, selectedBy: ctx.user.id, selectedAt: nowIso() })
          .where(eq(daySelections.id, existing[0].id));
        await db
          .update(routeCandidates)
          .set({ status: "proposed" })
          .where(eq(routeCandidates.id, existing[0].candidateId));
      } else {
        await db.insert(daySelections).values({
          tripId: candidate.tripId,
          planDate: candidate.planDate,
          candidateId: candidate.id,
          selectedBy: ctx.user.id,
          selectedAt: nowIso(),
        });
      }
      await db.update(routeCandidates).set({ status: "selected" }).where(eq(routeCandidates.id, candidate.id));
      return { candidateId: candidate.id };
    }),
  ),

  completeStop: op
    .input(z.object({ candidateId: z.number().int(), orderIndex: z.number().int().min(0) }))
    .mutation(
      intakeWrite(async ({ db, input, ctx }) => {
        const legs = await db
          .select()
          .from(routeLegs)
          .where(eq(routeLegs.candidateId, input.candidateId))
          .orderBy(asc(routeLegs.orderIndex));
        const leg = legs.find((l) => l.orderIndex === input.orderIndex);
        if (!leg) rejectIntake("Stop not found");
        const candidate = (
          await db.select().from(routeCandidates).where(eq(routeCandidates.id, input.candidateId))
        )[0]!;
        const visited = await db
          .select({ stopSeq: progressEvents.stopSeq })
          .from(progressEvents)
          .where(
            and(eq(progressEvents.candidateId, input.candidateId), eq(progressEvents.kind, "stop-visited")),
          );
        const priorMiles = Math.max(
          0,
          ...visited.map((v) => legs.find((l) => l.orderIndex === v.stopSeq)?.cumMiles ?? 0),
        );
        const priorEta = Math.max(
          0,
          ...visited.map((v) => legs.find((l) => l.orderIndex === v.stopSeq)?.etaMinutesFromStart ?? 0),
        );
        await db.insert(progressEvents).values({
          tripId: candidate.tripId,
          kind: "stop-visited",
          lat: leg.toLat,
          lng: leg.toLng,
          milesDriven: Math.max(0, leg.cumMiles - priorMiles),
          driveSeconds: Math.max(0, (leg.etaMinutesFromStart - priorEta - leg.dwellMinutes) * 60),
          candidateId: input.candidateId,
          stopSeq: input.orderIndex,
          recordedBy: ctx.user.id,
          occurredAt: nowIso(),
        });
        if (leg.waypointId !== null) {
          await db.update(waypoints).set({ status: "visited" }).where(eq(waypoints.id, leg.waypointId));
        }
        return { candidateId: input.candidateId, orderIndex: input.orderIndex };
      }),
    ),

  fanout: op.input(z.object({ tripId: z.number().int() })).query(async ({ ctx, input }) => {
    const db = ctx.dbHandle.db;
    const trip = await tripOr404(db, input.tripId);
    const baseline = trip.directDurationMinutes ?? (await ensureBaseline(db, trip));
    const states = await loadNeedStates(db, trip.id, nowIso());
    const serviceCategories = [
      ...new Set(
        states.filter((s) => s.need.poiCategory).map((s) => s.need.poiCategory!),
      ),
    ];
    const pool = await corridorPois(db, {
      tripId: trip.id,
      position: { lat: trip.originLat, lng: trip.originLng },
      dest: { lat: trip.destLat, lng: trip.destLng },
      budgetMinutes: baseline * trip.deviationBudgetRatio,
      serviceCategories,
    });
    const marks = await db.select().from(poiMarks).where(eq(poiMarks.tripId, trip.id));
    const all = new Map<number, (typeof pool.sideQuests)[number]>();
    for (const p of [...pool.sideQuests, ...[...pool.byCategory.values()].flat(), ...pool.pinned]) {
      all.set(p.id, p);
    }
    return {
      bbox: pool.bbox,
      pois: [...all.values()].sort((a, b) => b.score - a.score || a.id - b.id).slice(0, 300),
      marks,
    };
  }),

  markPoi: op
    .input(z.object({ tripId: z.number().int(), poiId: z.number().int(), mark: z.enum(["pinned", "rejected"]).nullable() }))
    .mutation(
      intakeWrite(async ({ db, input }) => {
        await db
          .delete(poiMarks)
          .where(and(eq(poiMarks.tripId, input.tripId), eq(poiMarks.poiId, input.poiId)));
        if (input.mark !== null) {
          await db.insert(poiMarks).values({
            tripId: input.tripId,
            poiId: input.poiId,
            mark: input.mark,
            createdAt: nowIso(),
          });
        }
        return { poiId: input.poiId, mark: input.mark };
      }),
    ),
});

export const needsRouter = router({
  list: op.query(async ({ ctx }) => {
    const db = ctx.dbHandle.db;
    const trip = await activeTrip(db);
    return loadNeedStates(db, trip?.id ?? null, nowIso());
  }),

  history: op
    .input(z.object({ needId: z.number().int(), limit: z.number().int().max(200).default(50) }))
    .query(async ({ ctx, input }) => checkInHistory(ctx.dbHandle.db, input.needId, input.limit)),

  checkin: op.input(checkInSchema).mutation(
    intakeWrite(async ({ db, input, ctx }) => {
      const need = (await db.select().from(needs).where(eq(needs.id, input.needId)))[0];
      if (!need) rejectIntake("Need not found");
      if (input.kind === "set-level" && input.quantity === undefined) {
        rejectIntake("A set-level correction needs a level");
      }
      if (input.quantity !== undefined && input.quantity > need.capacity * 1.5) {
        rejectIntake(`Quantity exceeds ${need.title}'s capacity by too much to be plausible`);
      }
      if (input.clientId) {
        const dupe = await db
          .select({ id: checkIns.id })
          .from(checkIns)
          .where(eq(checkIns.clientId, input.clientId));
        if (dupe[0]) return { id: dupe[0].id, deduped: true };
      }
      const inserted = await db
        .insert(checkIns)
        .values({
          needId: input.needId,
          kind: input.kind,
          quantity: input.quantity ?? null,
          note: input.note ?? null,
          lat: input.location?.lat ?? null,
          lng: input.location?.lng ?? null,
          poiId: input.poiId ?? null,
          recordedBy: ctx.user.id,
          clientId: input.clientId ?? null,
          occurredAt: input.occurredAt ?? nowIso(),
          createdAt: nowIso(),
        })
        .returning({ id: checkIns.id });
      return { id: inserted[0]!.id, deduped: false };
    }),
  ),

  undoCheckin: op.input(z.object({ id: z.number().int() })).mutation(
    intakeWrite(async ({ db, input }) => {
      const deleted = await db.delete(checkIns).where(eq(checkIns.id, input.id)).returning({ id: checkIns.id });
      if (deleted.length === 0) rejectIntake("Check-in not found");
      return { id: input.id };
    }),
  ),

  configure: op.input(needConfigureSchema).mutation(
    intakeWrite(async ({ db, input }) => {
      const { needId, ...fields } = input;
      const updated = await db.update(needs).set(fields).where(eq(needs.id, needId)).returning({ id: needs.id });
      if (updated.length === 0) rejectIntake("Need not found");
      return { id: needId };
    }),
  ),

  setRate: op.input(rateSetSchema).mutation(
    intakeWrite(async ({ db, input }) => {
      await db.insert(needRates).values({
        needId: input.needId,
        ratePerDay: input.ratePerDay,
        ratePerMile: input.ratePerMile,
        source: "manual",
        effectiveFrom: nowIso(),
        note: input.note ?? null,
        createdAt: nowIso(),
      });
      return { needId: input.needId };
    }),
  ),

  acceptRateSuggestion: op.input(z.object({ needId: z.number().int() })).mutation(
    intakeWrite(async ({ db, input, ctx }) => {
      const trip = await activeTrip(db);
      const states = await loadNeedStates(db, trip?.id ?? null, nowIso());
      const state = states.find((s) => s.need.id === input.needId);
      if (!state) rejectIntake("Need not found");
      if (!state.suggestion) rejectIntake("No rate suggestion available for this need");
      await db.insert(needRates).values({
        needId: input.needId,
        ratePerDay: state.suggestion.ratePerDay,
        ratePerMile: state.suggestion.ratePerMile,
        source: "derived",
        effectiveFrom: nowIso(),
        note: `Accepted from ${String(state.suggestion.samples)} check-in samples by ${ctx.user.email}`,
        createdAt: nowIso(),
      });
      return { needId: input.needId };
    }),
  ),
});

export const poisRouter = router({
  byBbox: op
    .input(z.object({ bbox: bboxSchema, categories: z.array(z.string()).optional(), limit: z.number().int().max(500).default(300) }))
    .query(async ({ ctx, input }) => {
      const db = ctx.dbHandle.db;
      const conditions = [
        gte(pois.lat, input.bbox.south),
        lte(pois.lat, input.bbox.north),
        gte(pois.lng, input.bbox.west),
        lte(pois.lng, input.bbox.east),
      ];
      if (input.categories && input.categories.length > 0) {
        conditions.push(inArray(pois.category, input.categories));
      }
      return db
        .select()
        .from(pois)
        .where(and(...conditions))
        .orderBy(desc(pois.popularity), asc(pois.id))
        .limit(input.limit);
    }),

  byId: op.input(z.object({ id: z.number().int() })).query(async ({ ctx, input }) => {
    const rows = await ctx.dbHandle.db.select().from(pois).where(eq(pois.id, input.id));
    if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "place not found" });
    return rows[0];
  }),

  importDataset: op
    .input(z.object({ records: z.array(PoiRecordSchema).max(5000), label: z.string().max(60).optional() }))
    .mutation(async ({ ctx, input }) =>
      importPoiDataset({ db: ctx.dbHandle.db, onPois, records: input.records, label: input.label }),
    ),
});

export const interestsRouter = router({
  list: op.query(async ({ ctx }) =>
    ctx.dbHandle.db.select().from(interestWeights).orderBy(asc(interestWeights.category)),
  ),

  setWeight: op
    .input(z.object({ category: z.string().min(1).max(40), weight: z.number().min(0).max(2) }))
    .mutation(
      intakeWrite(async ({ db, input }) => {
        await db
          .insert(interestWeights)
          .values({ category: input.category, weight: input.weight, updatedAt: nowIso() })
          .onConflictDoUpdate({
            target: interestWeights.category,
            set: { weight: input.weight, updatedAt: nowIso() },
          });
        return { category: input.category, weight: input.weight };
      }),
    ),
});

export const digestRouter = router({
  today: op.input(z.object({ tripId: z.number().int() })).query(async ({ ctx, input }) => {
    const db = ctx.dbHandle.db;
    const date = planDateOf(nowIso());
    const rows = await db
      .select()
      .from(digests)
      .where(and(eq(digests.tripId, input.tripId), eq(digests.date, date)));
    const row = rows[0];
    return row ? { ...row, body: JSON.parse(row.body) as unknown } : null;
  }),

  history: op.input(z.object({ tripId: z.number().int(), limit: z.number().int().max(30).default(7) })).query(
    async ({ ctx, input }) => {
      const rows = await ctx.dbHandle.db
        .select()
        .from(digests)
        .where(eq(digests.tripId, input.tripId))
        .orderBy(desc(digests.date))
        .limit(input.limit);
      return rows.map((r) => ({ ...r, body: JSON.parse(r.body) as unknown }));
    },
  ),

  preview: op.input(z.object({ tripId: z.number().int() })).query(async ({ ctx, input }) => {
    const db = ctx.dbHandle.db;
    const trip = (await tripOr404(db, input.tripId)) as TripRow & { name: string; status: string };
    return composeDigest(db, trip, nowIso());
  }),

  sendNow: op.input(z.object({ tripId: z.number().int() })).mutation(async ({ ctx, input }) => {
    const db = ctx.dbHandle.db;
    const trip = (await tripOr404(db, input.tripId)) as TripRow & { name: string; status: string };
    return generateAndDeliverDigest(ctx.dbHandle, ctx.logger, trip, nowIso(), { forcePush: true });
  }),

  settings: op.query(async ({ ctx }) => {
    const stored = await getSetting(ctx.dbHandle.db, DIGEST_SETTINGS_KEY, DigestSettingsSchema);
    return { hour: stored?.value.hour ?? 7 };
  }),

  saveSettings: op.input(z.object({ hour: z.number().int().min(0).max(23) })).mutation(
    intakeWrite(async ({ db, input, ctx }) => {
      await setSetting(db, DIGEST_SETTINGS_KEY, DigestSettingsSchema, { hour: input.hour }, String(ctx.user.id));
      return { hour: input.hour };
    }),
  ),
});

export const sourcesRouter = router({
  poiSources: createPoiSourcesStatusRouter({ sources: ["overpass", "nps", "recgov", "opencharge"] }),
  ntfy: createNtfyStatusRouter(),
});
