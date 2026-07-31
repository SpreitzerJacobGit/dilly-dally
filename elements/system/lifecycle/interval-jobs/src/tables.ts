import { sqliteTable, text, integer } from "@elements/storage-sqlite-drizzle";

/** Persisted job bookkeeping — the status surface reads THIS, never live objects. */
export const intervalJobStatus = sqliteTable("interval_job_status", {
  name: text("name").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  runCount: integer("run_count").notNull().default(0),
  failCount: integer("fail_count").notNull().default(0),
  lastRunAt: text("last_run_at"),
  lastSuccessAt: text("last_success_at"),
  lastError: text("last_error"),
  updatedAt: text("updated_at").notNull(),
});
