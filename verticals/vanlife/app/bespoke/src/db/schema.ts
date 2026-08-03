// GENERATED FROM data-model.yaml — DO NOT EDIT
// model: sha256:de99327fb0dcc5b9 (STALE — the anchor columns on `waypoints`, and
// the removal of `unit`/`capacity` from `needs` when levels became percentages,
// were hand-edited in lockstep with data-model.yaml; the designer that computes
// this hash is not in this repo. Re-run it to restore the invariant.)
/** Bespoke tables for Dilly-Dally. Element-owned tables live in their elements. */
import { sqliteTable, text, integer, real, index, uniqueIndex } from "@elements/storage-sqlite-drizzle";
import { users } from "@elements/identity-session-auth";

/** A journey from an Origin to a final Target, with its frozen budget baseline. */
export const trips = sqliteTable(
  "trips",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    status: text("status").notNull().default("planning"), // planning | active | completed | archived
    originName: text("origin_name").notNull(),
    originLat: real("origin_lat").notNull(),
    originLng: real("origin_lng").notNull(),
    destName: text("dest_name").notNull(),
    destLat: real("dest_lat").notNull(),
    destLng: real("dest_lng").notNull(),
    directDurationMinutes: real("direct_duration_minutes"), // The frozen 1x baseline; the deviation budget is this times budget ratio.
    deviationBudgetRatio: real("deviation_budget_ratio").notNull().default(2),
    dailyDriveHours: real("daily_drive_hours").notNull().default(4),
    startDate: text("start_date"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("trips_status").on(table.status)],
);

/** A region the route must pass through — center plus radius, nestable to narrow it. Radius 0 is an exact point. */
export const waypoints = sqliteTable(
  "waypoints",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tripId: integer("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    lat: real("lat").notNull(),
    lng: real("lng").notNull(),
    radiusMiles: real("radius_miles").notNull().default(0),
    parentId: integer("parent_id").references((): any => waypoints.id, { onDelete: "cascade" }),
    depth: integer("depth").notNull().default(0),
    kind: text("kind").notNull(), // family | custom | poi
    poiId: integer("poi_id")
      .references(() => pois.id, { onDelete: "set null" }),
    orderIndex: integer("order_index").notNull(),
    status: text("status").notNull().default("pending"), // pending | visited | skipped
    // The operator's chosen pass-through point. Auto-resolution is NEVER stored:
    // planStateFingerprint spreads this row, so a written-back resolution would
    // change the fingerprint as a consequence of building and replan forever.
    pinnedLat: real("pinned_lat"),
    pinnedLng: real("pinned_lng"),
    pinnedPoiId: integer("pinned_poi_id").references(() => pois.id, { onDelete: "set null" }),
    arriveBy: text("arrive_by"),
    notes: text("notes"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("waypoints_trip_order").on(table.tripId, table.orderIndex),
    index("waypoints_trip_parent_order").on(table.tripId, table.parentId, table.orderIndex),
  ],
);

/** An aggregated point of interest from a public source, deduped on (source, sourceId). */
export const pois = sqliteTable(
  "pois",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source: text("source").notNull(), // overpass | nps | recgov | opencharge | ioverlander | manual
    sourceId: text("source_id").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull(), // campground | water-fill | dump-station | laundry | grocery | fuel | ev-charge | restroom | hike | boulder | bike | scenic | family | other
    subcategory: text("subcategory"),
    lat: real("lat").notNull(),
    lng: real("lng").notNull(),
    popularity: real("popularity"), // Normalized 0-1 when the source has a signal; null means honestly unknown.
    tags: text("tags"),
    url: text("url"), // Deep link out to the source's own page.
    fetchedAt: text("fetched_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("pois_source_unique").on(table.source, table.sourceId),
    index("pois_category").on(table.category),
    index("pois_lat").on(table.lat),
  ],
);

/** Pin or reject a place for a trip — the progressive-narrowing mechanism. */
export const poiMarks = sqliteTable(
  "poi_marks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tripId: integer("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    poiId: integer("poi_id")
      .notNull()
      .references(() => pois.id, { onDelete: "cascade" }),
    mark: text("mark").notNull(), // pinned | rejected
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("poi_marks_trip_poi").on(table.tripId, table.poiId)],
);

/** A tracked van-life need with its thresholds and its servicing place category. */
export const needs = sqliteTable("needs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("need_key").notNull().unique(), // Seeded: food | gas | water | laundry | trash | wastewater | electric | internet; operator-created needs slug their title.
  title: text("title").notNull(),
  direction: text("direction").notNull(), // depletes | accumulates
  warnRatio: real("warn_ratio").notNull().default(0.25), // Runway fraction at which the need is worth planning for.
  urgentRatio: real("urgent_ratio").notNull().default(0.1), // Runway fraction at which the need is urgent.
  poiCategory: text("poi_category"), // Which place category services this need; null for checklist-only concerns.
  routingDriver: integer("routing_driver", { mode: "boolean" }).notNull().default(true), // Internet is tracked but never generates stops.
  sortOrder: integer("sort_order").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  trackingMode: text("tracking_mode").notNull().default("level"), // level = a 0-100% consumable with a rate; date = simply due on a day.
  dueAt: text("due_at"), // When a date-tracked need falls due. Null for level-tracked needs.
  warnDays: real("warn_days"), // Days before dueAt at which a date-tracked need is worth planning for.
  urgentDays: real("urgent_days"), // Days before dueAt at which a date-tracked need is urgent.
  serviceIntervalDays: real("service_interval_days"), // How far a service check-in rolls dueAt forward; null means by hand only.
});

/** Rate history per need; the current rate is the latest effectiveFrom. Derived rows only exist via an accepted suggestion. */
export const needRates = sqliteTable(
  "need_rates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    needId: integer("need_id")
      .notNull()
      .references(() => needs.id, { onDelete: "cascade" }),
    ratePerDay: real("rate_per_day").notNull(),
    ratePerMile: real("rate_per_mile").notNull().default(0),
    source: text("source").notNull(), // manual | derived
    effectiveFrom: text("effective_from").notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("need_rates_need_from").on(table.needId, table.effectiveFrom)],
);

/** The only way a level changes — a service event or an explicit correction, always attributed. */
export const checkIns = sqliteTable(
  "check_ins",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    needId: integer("need_id")
      .notNull()
      .references(() => needs.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // service | set-level
    quantity: real("quantity"),
    note: text("note"),
    lat: real("lat"),
    lng: real("lng"),
    poiId: integer("poi_id")
      .references(() => pois.id, { onDelete: "set null" }),
    recordedBy: integer("recorded_by")
      .notNull()
      .references(() => users.id),
    clientId: text("client_id").unique(), // Client-generated id so an offline queue replay never records twice.
    prevDueAt: text("prev_due_at"), // The due date this check-in rolled forward, so undo restores it exactly.
    occurredAt: text("occurred_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("check_ins_need_time").on(table.needId, table.occurredAt)],
);

/** The driving log — stop visits, leg completions, and manual position pins; feeds budget accounting and mileage drain. */
export const progressEvents = sqliteTable(
  "progress_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tripId: integer("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // stop-visited | leg-completed | position-set
    lat: real("lat").notNull(),
    lng: real("lng").notNull(),
    milesDriven: real("miles_driven").notNull().default(0),
    driveSeconds: real("drive_seconds").notNull().default(0),
    candidateId: integer("candidate_id")
      .references(() => routeCandidates.id, { onDelete: "set null" }),
    stopSeq: integer("stop_seq"),
    recordedBy: integer("recorded_by")
      .notNull()
      .references(() => users.id),
    occurredAt: text("occurred_at").notNull(),
  },
  (table) => [index("progress_events_trip_time").on(table.tripId, table.occurredAt)],
);

/** One day-leg proposal — role tier, verified geometry, gray continuation, and honest warnings. */
export const routeCandidates = sqliteTable(
  "route_candidates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tripId: integer("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    planDate: text("plan_date").notNull(),
    tier: text("tier").notNull(), // direct | balanced | scenic | side-quest | max
    title: text("title").notNull(),
    summary: text("summary"),
    score: real("score").notNull().default(0),
    durationMinutes: real("duration_minutes").notNull(),
    distanceMiles: real("distance_miles").notNull(),
    remainingBudgetMinutes: real("remaining_budget_minutes"), // Budget left after this day plus the direct continuation - the honesty figure behind ROUTE-1.
    geometry: text("geometry").notNull(), // GeoJSON LineString of today's leg.
    projectedGeometry: text("projected_geometry"), // Gray continuation to the final Target.
    warnings: text("warnings"),
    status: text("status").notNull().default("proposed"), // proposed | selected | expired
    generatedAt: text("generated_at").notNull(),
  },
  (table) => [index("route_candidates_trip_date").on(table.tripId, table.planDate)],
);

/** An ordered stop of a candidate, annotated with the need it services. */
export const routeLegs = sqliteTable(
  "route_legs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    candidateId: integer("candidate_id")
      .notNull()
      .references(() => routeCandidates.id, { onDelete: "cascade" }),
    orderIndex: integer("order_index").notNull(),
    toName: text("to_name").notNull(),
    toLat: real("to_lat").notNull(),
    toLng: real("to_lng").notNull(),
    poiId: integer("poi_id")
      .references(() => pois.id, { onDelete: "set null" }),
    waypointId: integer("waypoint_id")
      .references(() => waypoints.id, { onDelete: "set null" }),
    needId: integer("need_id")
      .references(() => needs.id, { onDelete: "set null" }), // The need this stop services, when it is a service stop.
    purpose: text("purpose").notNull(), // drive | resupply | fuel | water | dump | laundry | charge | sight | camp | family
    etaMinutesFromStart: real("eta_minutes_from_start").notNull(),
    cumMiles: real("cum_miles").notNull(),
    dwellMinutes: real("dwell_minutes").notNull().default(0),
  },
  (table) => [index("route_legs_candidate_order").on(table.candidateId, table.orderIndex)],
);

/** The authoritative pick for a day - one per trip per date. */
export const daySelections = sqliteTable(
  "day_selections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tripId: integer("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    planDate: text("plan_date").notNull(),
    candidateId: integer("candidate_id")
      .notNull()
      .references(() => routeCandidates.id),
    selectedBy: integer("selected_by")
      .notNull()
      .references(() => users.id),
    selectedAt: text("selected_at").notNull(),
    completedAt: text("completed_at"),
    notes: text("notes"),
  },
  (table) => [uniqueIndex("day_selections_trip_date").on(table.tripId, table.planDate)],
);

/** The composed morning digest - readable in-app regardless of push delivery, one per trip per date. */
export const digests = sqliteTable(
  "digests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tripId: integer("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    body: text("body").notNull(),
    priority: text("priority").notNull().default("default"), // default | high | urgent
    generatedAt: text("generated_at").notNull(),
  },
  (table) => [uniqueIndex("digests_trip_date").on(table.tripId, table.date)],
);

/** Per-category bias for side-quest scoring; zero excludes the category entirely. */
export const interestWeights = sqliteTable("interest_weights", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  category: text("category").notNull().unique(),
  weight: real("weight").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
});

/** A remembered geocoder answer, so a place found with an uplink stays findable without one. */
export const placeLookups = sqliteTable(
  "place_lookups",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind").notNull(), // search | reverse
    queryKey: text("query_key").notNull(), // Normalized query - lowercased and collapsed for search, lat/lng rounded to 3dp for reverse.
    resultsJson: text("results_json").notNull(),
    fetchedAt: text("fetched_at").notNull(),
  },
  (table) => [uniqueIndex("place_lookups_kind_query").on(table.kind, table.queryKey)],
);
