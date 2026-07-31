CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_by` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `interval_job_status` (
	`name` text PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`run_count` integer DEFAULT 0 NOT NULL,
	`fail_count` integer DEFAULT 0 NOT NULL,
	`last_run_at` text,
	`last_success_at` text,
	`last_error` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dedupe_key` text,
	`title` text NOT NULL,
	`priority` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notification_log_dedupe` ON `notification_log` (`dedupe_key`,`status`);--> statement-breakpoint
CREATE TABLE `poi_source_runs` (
	`key` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`region` text NOT NULL,
	`last_run_at` text,
	`last_success_at` text,
	`last_error` text,
	`fetched_count` integer,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `check_ins` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`need_id` integer NOT NULL,
	`kind` text NOT NULL,
	`quantity` real,
	`note` text,
	`lat` real,
	`lng` real,
	`poi_id` integer,
	`recorded_by` integer NOT NULL,
	`client_id` text,
	`occurred_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`need_id`) REFERENCES `needs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`poi_id`) REFERENCES `pois`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `check_ins_client_id_unique` ON `check_ins` (`client_id`);--> statement-breakpoint
CREATE INDEX `check_ins_need_time` ON `check_ins` (`need_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `day_selections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trip_id` integer NOT NULL,
	`plan_date` text NOT NULL,
	`candidate_id` integer NOT NULL,
	`selected_by` integer NOT NULL,
	`selected_at` text NOT NULL,
	`completed_at` text,
	`notes` text,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`candidate_id`) REFERENCES `route_candidates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`selected_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `day_selections_trip_date` ON `day_selections` (`trip_id`,`plan_date`);--> statement-breakpoint
CREATE TABLE `digests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trip_id` integer NOT NULL,
	`date` text NOT NULL,
	`body` text NOT NULL,
	`priority` text DEFAULT 'default' NOT NULL,
	`generated_at` text NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `digests_trip_date` ON `digests` (`trip_id`,`date`);--> statement-breakpoint
CREATE TABLE `interest_weights` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category` text NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `interest_weights_category_unique` ON `interest_weights` (`category`);--> statement-breakpoint
CREATE TABLE `need_rates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`need_id` integer NOT NULL,
	`rate_per_day` real NOT NULL,
	`rate_per_mile` real DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`effective_from` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`need_id`) REFERENCES `needs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `need_rates_need_from` ON `need_rates` (`need_id`,`effective_from`);--> statement-breakpoint
CREATE TABLE `needs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`need_key` text NOT NULL,
	`title` text NOT NULL,
	`unit` text NOT NULL,
	`capacity` real NOT NULL,
	`direction` text NOT NULL,
	`warn_ratio` real DEFAULT 0.25 NOT NULL,
	`urgent_ratio` real DEFAULT 0.1 NOT NULL,
	`poi_category` text,
	`routing_driver` integer DEFAULT true NOT NULL,
	`sort_order` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `needs_need_key_unique` ON `needs` (`need_key`);--> statement-breakpoint
CREATE TABLE `poi_marks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trip_id` integer NOT NULL,
	`poi_id` integer NOT NULL,
	`mark` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`poi_id`) REFERENCES `pois`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `poi_marks_trip_poi` ON `poi_marks` (`trip_id`,`poi_id`);--> statement-breakpoint
CREATE TABLE `pois` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`subcategory` text,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`popularity` real,
	`tags` text,
	`url` text,
	`fetched_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pois_source_unique` ON `pois` (`source`,`source_id`);--> statement-breakpoint
CREATE INDEX `pois_category` ON `pois` (`category`);--> statement-breakpoint
CREATE INDEX `pois_lat` ON `pois` (`lat`);--> statement-breakpoint
CREATE TABLE `progress_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trip_id` integer NOT NULL,
	`kind` text NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`miles_driven` real DEFAULT 0 NOT NULL,
	`drive_seconds` real DEFAULT 0 NOT NULL,
	`candidate_id` integer,
	`stop_seq` integer,
	`recorded_by` integer NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`candidate_id`) REFERENCES `route_candidates`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `progress_events_trip_time` ON `progress_events` (`trip_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `route_candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trip_id` integer NOT NULL,
	`plan_date` text NOT NULL,
	`tier` text NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`score` real DEFAULT 0 NOT NULL,
	`duration_minutes` real NOT NULL,
	`distance_miles` real NOT NULL,
	`remaining_budget_minutes` real,
	`geometry` text NOT NULL,
	`projected_geometry` text,
	`warnings` text,
	`status` text DEFAULT 'proposed' NOT NULL,
	`generated_at` text NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `route_candidates_trip_date` ON `route_candidates` (`trip_id`,`plan_date`);--> statement-breakpoint
CREATE TABLE `route_legs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`candidate_id` integer NOT NULL,
	`order_index` integer NOT NULL,
	`to_name` text NOT NULL,
	`to_lat` real NOT NULL,
	`to_lng` real NOT NULL,
	`poi_id` integer,
	`waypoint_id` integer,
	`need_id` integer,
	`purpose` text NOT NULL,
	`eta_minutes_from_start` real NOT NULL,
	`cum_miles` real NOT NULL,
	`dwell_minutes` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `route_candidates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`poi_id`) REFERENCES `pois`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`waypoint_id`) REFERENCES `waypoints`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`need_id`) REFERENCES `needs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `route_legs_candidate_order` ON `route_legs` (`candidate_id`,`order_index`);--> statement-breakpoint
CREATE TABLE `trips` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'planning' NOT NULL,
	`origin_name` text NOT NULL,
	`origin_lat` real NOT NULL,
	`origin_lng` real NOT NULL,
	`dest_name` text NOT NULL,
	`dest_lat` real NOT NULL,
	`dest_lng` real NOT NULL,
	`direct_duration_minutes` real,
	`deviation_budget_ratio` real DEFAULT 2 NOT NULL,
	`daily_drive_hours` real DEFAULT 4 NOT NULL,
	`start_date` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `trips_status` ON `trips` (`status`);--> statement-breakpoint
CREATE TABLE `waypoints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trip_id` integer NOT NULL,
	`name` text NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`kind` text NOT NULL,
	`poi_id` integer,
	`order_index` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`arrive_by` text,
	`notes` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`poi_id`) REFERENCES `pois`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `waypoints_trip_order` ON `waypoints` (`trip_id`,`order_index`);