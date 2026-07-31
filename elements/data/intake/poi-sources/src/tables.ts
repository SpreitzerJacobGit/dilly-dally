import { sqliteTable, text, integer } from "@elements/storage-sqlite-drizzle";

/**
 * Per-(source, region) fetch bookkeeping. Skipped runs record nothing, so
 * `lastRunAt` honestly means "last real attempt" and "never checked" is a
 * distinguishable state, not a blank pretending to be fine.
 */
export const poiSourceRuns = sqliteTable("poi_source_runs", {
  /** `<source>:<regionKey>` */
  key: text("key").primaryKey(),
  source: text("source").notNull(),
  region: text("region").notNull(),
  lastRunAt: text("last_run_at"),
  lastSuccessAt: text("last_success_at"),
  lastError: text("last_error"),
  fetchedCount: integer("fetched_count"),
  updatedAt: text("updated_at").notNull(),
});
