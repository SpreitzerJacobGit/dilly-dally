ALTER TABLE `waypoints` ADD `radius_miles` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `waypoints` ADD `parent_id` integer REFERENCES waypoints(id) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `waypoints` ADD `depth` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `waypoints` ADD `pinned_lat` real;--> statement-breakpoint
ALTER TABLE `waypoints` ADD `pinned_lng` real;--> statement-breakpoint
ALTER TABLE `waypoints` ADD `pinned_poi_id` integer REFERENCES pois(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `waypoints_trip_parent_order` ON `waypoints` (`trip_id`,`parent_id`,`order_index`);