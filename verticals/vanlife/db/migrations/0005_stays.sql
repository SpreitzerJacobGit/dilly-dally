CREATE TABLE `stay_sites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`poi_id` integer NOT NULL,
	`stay_kind` text NOT NULL,
	`nightly_cost_usd` real,
	`hookup_electric` integer DEFAULT false NOT NULL,
	`hookup_water` integer DEFAULT false NOT NULL,
	`dump_station` integer DEFAULT false NOT NULL,
	`showers` integer DEFAULT false NOT NULL,
	`laundry_on_site` integer DEFAULT false NOT NULL,
	`reservable` text DEFAULT 'unknown' NOT NULL,
	`access` text DEFAULT 'unknown' NOT NULL,
	`max_nights` integer,
	`last_reported_at` text,
	`confidence` text DEFAULT 'unverified' NOT NULL,
	`notes` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`poi_id`) REFERENCES `pois`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stay_sites_poi` ON `stay_sites` (`poi_id`);--> statement-breakpoint
CREATE INDEX `stay_sites_kind` ON `stay_sites` (`stay_kind`);--> statement-breakpoint
CREATE TABLE `stay_availability` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`poi_id` integer NOT NULL,
	`for_date` text NOT NULL,
	`state` text NOT NULL,
	`source` text NOT NULL,
	`detail` text,
	`last_error` text,
	`fetched_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`poi_id`) REFERENCES `pois`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stay_availability_poi_date` ON `stay_availability` (`poi_id`,`for_date`);--> statement-breakpoint
CREATE TABLE `stay_options` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`candidate_id` integer NOT NULL,
	`poi_id` integer NOT NULL,
	`stay_kind` text NOT NULL,
	`marginal_minutes` real NOT NULL,
	`to_stay_minutes` real NOT NULL,
	`from_stay_minutes` real NOT NULL,
	`to_stay_miles` real NOT NULL,
	`arrival_iso` text,
	`sunset_iso` text,
	`factors` text NOT NULL,
	`score` real NOT NULL,
	`excluded_reason` text,
	`order_index` integer NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `route_candidates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`poi_id`) REFERENCES `pois`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `stay_options_candidate_order` ON `stay_options` (`candidate_id`,`order_index`);--> statement-breakpoint
CREATE TABLE `stay_weights` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trip_id` integer NOT NULL,
	`factor` text NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stay_weights_trip_factor` ON `stay_weights` (`trip_id`,`factor`);--> statement-breakpoint
CREATE TABLE `stay_plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trip_id` integer NOT NULL,
	`plan_date` text NOT NULL,
	`poi_id` integer NOT NULL,
	`state` text NOT NULL,
	`cost_usd` real,
	`confirmation` text,
	`notes` text,
	`recorded_by` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`poi_id`) REFERENCES `pois`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stay_plans_trip_date` ON `stay_plans` (`trip_id`,`plan_date`);--> statement-breakpoint
-- Existing campground places become stay sites, so an upgraded installation has
-- somewhere to sleep on the first replan instead of an empty shortlist. Cost,
-- hookups and access stay unknown rather than assumed: the row records that the
-- place is a campground, not that anyone has checked what it offers.
INSERT INTO `stay_sites` (`poi_id`, `stay_kind`, `confidence`, `updated_at`)
SELECT `id`, 'campground', 'unverified', CURRENT_TIMESTAMP FROM `pois` WHERE `category` = 'campground';
