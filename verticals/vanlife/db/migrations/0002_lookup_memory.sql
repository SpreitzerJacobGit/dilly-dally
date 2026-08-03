CREATE TABLE `place_lookups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`query_key` text NOT NULL,
	`results_json` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `place_lookups_kind_query` ON `place_lookups` (`kind`,`query_key`);
