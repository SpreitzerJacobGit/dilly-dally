import { z } from "zod";
import { FULL_LEVEL, rateFromRange } from "../shared/levels.js";

/** Shared input schemas — one source for server validation and client forms. */

export const latLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const tripCreateSchema = z.object({
  name: z.string().min(1).max(120),
  originName: z.string().min(1).max(120),
  origin: latLngSchema,
  destName: z.string().min(1).max(120),
  dest: latLngSchema,
  dailyDriveHours: z.number().min(1).max(12).default(4),
  deviationBudgetRatio: z.number().min(1).max(4).default(2),
  startDate: z.iso.date().optional(),
});

/**
 * Editing a trip after creation. Every field is optional because the four
 * things an operator changes — the name, the Origin, the final Target, and the
 * pace — are edited independently and rarely together.
 */
export const tripUpdateSchema = z.object({
  id: z.number().int(),
  name: z.string().min(1).max(120).optional(),
  originName: z.string().min(1).max(120).optional(),
  origin: latLngSchema.optional(),
  destName: z.string().min(1).max(120).optional(),
  dest: latLngSchema.optional(),
  dailyDriveHours: z.number().min(1).max(12).optional(),
  deviationBudgetRatio: z.number().min(1).max(4).optional(),
  startDate: z.iso.date().nullable().optional(),
});

/**
 * Anchors: a waypoint with a radius. 0 miles is an exact point — the shape a
 * plain waypoint has always had — and anything larger is a region the route
 * must pass through.
 */
export const targetAddSchema = z.object({
  tripId: z.number().int(),
  name: z.string().min(1).max(120),
  center: latLngSchema,
  radiusMiles: z.number().min(0).max(400).default(0),
  parentId: z.number().int().nullable().default(null),
  kind: z.enum(["family", "custom", "poi"]).default("custom"),
  poiId: z.number().int().optional(),
  arriveBy: z.iso.date().optional(),
  notes: z.string().max(500).optional(),
});

export const targetUpdateSchema = z.object({
  id: z.number().int(),
  name: z.string().min(1).max(120).optional(),
  center: latLngSchema.optional(),
  radiusMiles: z.number().min(0).max(400).optional(),
  arriveBy: z.iso.date().nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

export const targetPinSchema = z.object({
  id: z.number().int(),
  /** null clears the pin and returns the anchor to automatic resolution. */
  point: latLngSchema.nullable(),
  poiId: z.number().int().nullable().default(null),
});

export const targetPromoteSchema = z.object({
  parentId: z.number().int(),
  poiId: z.number().int(),
  radiusMiles: z.number().min(0).max(100).default(0),
  name: z.string().min(1).max(120).optional(),
});

export const targetReparentSchema = z.object({
  id: z.number().int(),
  /** null drops the anchor at the top level. */
  parentId: z.number().int().nullable(),
  orderIndex: z.number().int().min(0).max(999).default(0),
});

export const targetReorderSchema = z.object({
  tripId: z.number().int(),
  parentId: z.number().int().nullable().default(null),
  orderedIds: z.array(z.number().int()).max(100),
});

export const checkInSchema = z.object({
  needId: z.number().int(),
  kind: z.enum(["service", "set-level"]),
  /** Percentage points. The ceiling is a constant now, not a per-need capacity. */
  quantity: z.number().min(0).max(FULL_LEVEL * 1.5).optional(),
  note: z.string().max(300).optional(),
  location: latLngSchema.optional(),
  poiId: z.number().int().optional(),
  clientId: z.string().max(64).optional(),
  occurredAt: z.iso.datetime().optional(),
});

export const trackingModeSchema = z.enum(["level", "date"]);

/**
 * A due date may be given as a bare day, which is how a date input reports it.
 * A bare day means the END of that day — a need due on the 15th is not overdue
 * at breakfast on the 15th.
 */
export const dueAtSchema = z
  .union([z.iso.date(), z.iso.datetime()])
  .transform((v) => (v.length === 10 ? `${v}T23:59:59.000Z` : v));

/**
 * A drain rate may arrive either way round. Storage is percent-per-day and
 * percent-per-mile, but an operator knows the RANGE — "a full tank lasts about
 * 450 miles" — so the range fields win when present and are inverted here, at
 * the boundary, rather than in each caller. An API client that already thinks
 * in percent is not forced to invert.
 */
const rangeFields = {
  ratePerDay: z.number().min(0).default(0),
  ratePerMile: z.number().min(0).default(0),
  daysToEmpty: z.number().positive().max(3650).optional(),
  milesToEmpty: z.number().positive().max(10000).optional(),
};

function resolveRates<T extends { ratePerDay: number; ratePerMile: number; daysToEmpty?: number; milesToEmpty?: number }>(
  v: T,
): T {
  return {
    ...v,
    ratePerDay: v.daysToEmpty === undefined ? v.ratePerDay : rateFromRange(v.daysToEmpty),
    ratePerMile: v.milesToEmpty === undefined ? v.ratePerMile : rateFromRange(v.milesToEmpty),
  };
}

/**
 * Creating a need. The two tracking modes need disjoint fields — a consumable
 * runs 0-100% at a rate, a date-tracked concern has a due date and lead times
 * — so the shared object validates whichever set the mode calls for.
 */
export const needCreateSchema = z
  .object({
    title: z.string().min(1).max(60),
    trackingMode: trackingModeSchema.default("level"),
    poiCategory: z.string().max(40).nullable().default(null),
    routingDriver: z.boolean().optional(),
    // Level mode.
    direction: z.enum(["depletes", "accumulates"]).default("depletes"),
    warnRatio: z.number().min(0).max(0.9).default(0.25),
    urgentRatio: z.number().min(0).max(0.5).default(0.1),
    ...rangeFields,
    // Date mode.
    dueAt: dueAtSchema.optional(),
    warnDays: z.number().min(0).max(3650).optional(),
    urgentDays: z.number().min(0).max(3650).optional(),
    serviceIntervalDays: z.number().min(0).max(3650).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.trackingMode === "date" && v.dueAt === undefined) {
      ctx.addIssue({ code: "custom", path: ["dueAt"], message: "A date-tracked need needs a due date" });
    }
    if (v.urgentRatio > v.warnRatio) {
      ctx.addIssue({ code: "custom", path: ["urgentRatio"], message: "Urgent must be at or below warn" });
    }
    if (v.warnDays !== undefined && v.urgentDays !== undefined && v.urgentDays > v.warnDays) {
      ctx.addIssue({ code: "custom", path: ["urgentDays"], message: "Urgent must fall at or after warn" });
    }
  })
  .transform(resolveRates);

/**
 * Editing a need. Every field is optional because rename, retune, re-mode and
 * archive are all separate gestures in the manager and never arrive together.
 * The mode-consistency checks that need the stored row live in the route.
 */
export const needConfigureSchema = z.object({
  needId: z.number().int(),
  title: z.string().min(1).max(60).optional(),
  trackingMode: trackingModeSchema.optional(),
  direction: z.enum(["depletes", "accumulates"]).optional(),
  warnRatio: z.number().min(0).max(0.9).optional(),
  urgentRatio: z.number().min(0).max(0.5).optional(),
  dueAt: dueAtSchema.nullable().optional(),
  warnDays: z.number().min(0).max(3650).nullable().optional(),
  urgentDays: z.number().min(0).max(3650).nullable().optional(),
  serviceIntervalDays: z.number().min(0).max(3650).nullable().optional(),
  poiCategory: z.string().max(40).nullable().optional(),
  routingDriver: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  active: z.boolean().optional(),
});

export const rateSetSchema = z
  .object({
    needId: z.number().int(),
    ...rangeFields,
    note: z.string().max(300).optional(),
  })
  .transform(resolveRates);

/**
 * Route-through-needs: the places that can service one need, ranked against
 * today's chosen route. Read-only, and answered entirely from places already
 * stored on the van server.
 */
export const needOptionsSchema = z.object({
  tripId: z.number().int(),
  needId: z.number().int(),
  /** Rank "on the way" against this candidate; defaults to the day's selection. */
  candidateId: z.number().int().optional(),
  radiusMiles: z.number().min(5).max(200).default(60),
  limit: z.number().int().min(1).max(50).default(20),
});

/**
 * Free-text place lookup. One field for all three ways in — a city, a region,
 * and a street address are the same query to Nominatim, so the operator is
 * never asked to declare which one they are typing. `near` only biases the
 * ranking; it never filters, so a far-away match is still reachable.
 */
export const placeSearchSchema = z.object({
  query: z.string().min(3).max(200),
  limit: z.number().int().min(1).max(10).default(5),
  near: latLngSchema.optional(),
});

export const bboxSchema = z.object({
  south: z.number().min(-90).max(90),
  west: z.number().min(-180).max(180),
  north: z.number().min(-90).max(90),
  east: z.number().min(-180).max(180),
});
