import { z } from "zod";

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
  quantity: z.number().min(0).optional(),
  note: z.string().max(300).optional(),
  location: latLngSchema.optional(),
  poiId: z.number().int().optional(),
  clientId: z.string().max(64).optional(),
  occurredAt: z.iso.datetime().optional(),
});

export const needConfigureSchema = z.object({
  needId: z.number().int(),
  capacity: z.number().positive().optional(),
  warnRatio: z.number().min(0).max(0.9).optional(),
  urgentRatio: z.number().min(0).max(0.5).optional(),
  active: z.boolean().optional(),
});

export const rateSetSchema = z.object({
  needId: z.number().int(),
  ratePerDay: z.number().min(0),
  ratePerMile: z.number().min(0).default(0),
  note: z.string().max(300).optional(),
});

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
