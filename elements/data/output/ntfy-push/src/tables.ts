import { sqliteTable, text, integer, index } from "@elements/storage-sqlite-drizzle";

/**
 * Append-only delivery log. Every publish attempt lands here — sent or failed —
 * so the application can always show what it claimed to deliver and what
 * actually left the building. `dedupeKey` backs publishOnce: a key with a sent
 * row is never published again, across restarts.
 */
export const notificationLog = sqliteTable(
  "notification_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    dedupeKey: text("dedupe_key"),
    title: text("title").notNull(),
    priority: text("priority").notNull(),
    status: text("status").notNull(), // "sent" | "failed"
    detail: text("detail"), // error message on failure
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("notification_log_dedupe").on(t.dedupeKey, t.status)],
);
