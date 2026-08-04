-- Levels become a plain 0-100 percentage. Everything recorded in the old per-need
-- units is rescaled by 100/capacity BEFORE the capacity that gave those units their
-- meaning is dropped. Level-tracked needs only: a date-tracked need's capacity of 1
-- is inert, and multiplying its quantities by 100 would be catastrophic.
-- The `capacity > 0` guard lives in the WHERE, not the subquery: SQLite returns NULL
-- rather than erroring on x/0, and rate_per_day is NOT NULL, so an unguarded
-- zero-capacity need would abort this migration mid-boot.
UPDATE check_ins
SET quantity = quantity * (SELECT 100.0 / n.capacity FROM needs n WHERE n.id = check_ins.need_id)
WHERE quantity IS NOT NULL
  AND need_id IN (SELECT id FROM needs WHERE tracking_mode = 'level' AND capacity > 0);--> statement-breakpoint
UPDATE need_rates
SET rate_per_day  = rate_per_day  * (SELECT 100.0 / n.capacity FROM needs n WHERE n.id = need_rates.need_id),
    rate_per_mile = rate_per_mile * (SELECT 100.0 / n.capacity FROM needs n WHERE n.id = need_rates.need_id)
WHERE need_id IN (SELECT id FROM needs WHERE tracking_mode = 'level' AND capacity > 0);--> statement-breakpoint
-- A digest stores its composed body as JSON, carrying a unit of "gal" and a runway
-- in gallons. Rendered after this change it would silently read "7.5%" for 7.5
-- gallons. A digest is a disposable daily artifact, regenerated every morning.
DELETE FROM digests;--> statement-breakpoint
ALTER TABLE `needs` DROP COLUMN `unit`;--> statement-breakpoint
ALTER TABLE `needs` DROP COLUMN `capacity`;
