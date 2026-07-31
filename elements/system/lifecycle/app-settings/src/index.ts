import { eq, sqliteTable, text, type Db } from "@elements/storage-sqlite-drizzle";
import type { ZodType } from "zod";

/**
 * Stored lifecycle configuration: typed, named settings records that an
 * operator manages through the application rather than the environment.
 * Each consumer owns its key and its zod schema; this element owns the
 * storage discipline.
 */
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(), // JSON, validated by the consumer's schema
  updatedBy: text("updated_by"), // user id as text; no FK — identity-agnostic
  updatedAt: text("updated_at").notNull(),
});

export interface SettingRecord<T> {
  value: T;
  updatedAt: string;
}

/**
 * Read and validate a setting. Absent -> null. A corrupted or schema-invalid
 * record THROWS — loud, visible corruption (a job hitting it records the error)
 * rather than silently pretending to be unconfigured.
 */
export async function getSetting<T>(
  db: Db,
  key: string,
  schema: ZodType<T>,
): Promise<SettingRecord<T> | null> {
  const rows = await db.select().from(appSettings).where(eq(appSettings.key, key));
  const row = rows[0];
  if (!row) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    throw new Error(`Setting "${key}" is corrupted (invalid JSON)`);
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`Setting "${key}" does not match its schema: ${validated.error.message.slice(0, 200)}`);
  }
  return { value: validated.data, updatedAt: row.updatedAt };
}

export async function setSetting<T>(
  db: Db,
  key: string,
  schema: ZodType<T>,
  value: T,
  updatedBy: string | null,
): Promise<void> {
  const validated = schema.parse(value);
  const now = new Date().toISOString();
  await db
    .insert(appSettings)
    .values({ key, value: JSON.stringify(validated), updatedBy, updatedAt: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: JSON.stringify(validated), updatedBy, updatedAt: now },
    });
}

export async function deleteSetting(db: Db, key: string): Promise<void> {
  await db.delete(appSettings).where(eq(appSettings.key, key));
}
