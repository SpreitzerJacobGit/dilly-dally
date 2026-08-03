ALTER TABLE `needs` ADD `tracking_mode` text DEFAULT 'level' NOT NULL;--> statement-breakpoint
ALTER TABLE `needs` ADD `due_at` text;--> statement-breakpoint
ALTER TABLE `needs` ADD `warn_days` real;--> statement-breakpoint
ALTER TABLE `needs` ADD `urgent_days` real;--> statement-breakpoint
ALTER TABLE `needs` ADD `service_interval_days` real;--> statement-breakpoint
ALTER TABLE `check_ins` ADD `prev_due_at` text;
