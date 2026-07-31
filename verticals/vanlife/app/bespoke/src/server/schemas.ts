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

export const waypointAddSchema = z.object({
  tripId: z.number().int(),
  name: z.string().min(1).max(120),
  location: latLngSchema,
  kind: z.enum(["family", "custom", "poi"]).default("custom"),
  poiId: z.number().int().optional(),
  notes: z.string().max(500).optional(),
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

export const bboxSchema = z.object({
  south: z.number().min(-90).max(90),
  west: z.number().min(-180).max(180),
  north: z.number().min(-90).max(90),
  east: z.number().min(-180).max(180),
});
