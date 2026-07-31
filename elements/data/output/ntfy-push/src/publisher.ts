import { z } from "zod";
import { and, desc, eq, type DbHandle } from "@elements/storage-sqlite-drizzle";
import { getSetting, setSetting } from "@elements/lifecycle-app-settings";
import { errorInfo, type AppLogger } from "@elements/observability-structured-logging";
import { notificationLog } from "./tables.js";

/** Stored lifecycle configuration — operator-entered, never from the environment. */
export const NtfySettingsSchema = z.object({
  serverUrl: z.url().default("https://ntfy.sh"),
  topic: z.string().min(1),
  token: z.string().optional(),
});
export type NtfySettings = z.infer<typeof NtfySettingsSchema>;
export const NTFY_SETTINGS_KEY = "ntfy-push";

export interface NtfyMessage {
  title: string;
  body: string;
  priority?: "default" | "high" | "urgent";
  /** ntfy tags, rendered as emoji/labels on the notification. */
  tags?: string[];
  /** URL opened when the notification is tapped. */
  clickUrl?: string;
}

export type PublishResult =
  | { ok: true; skipped?: undefined }
  | { ok: false; skipped: "unconfigured" | "duplicate" }
  | { ok: false; skipped?: undefined; error: string };

export interface NtfyPublisher {
  /** Publish unconditionally (still logged). */
  publish(msg: NtfyMessage): Promise<PublishResult>;
  /**
   * At-most-once per key, across restarts: a key that has ever been SENT is
   * never sent again; a failed attempt does not burn the key, so retries work.
   */
  publishOnce(dedupeKey: string, msg: NtfyMessage): Promise<PublishResult>;
}

export function createNtfyPublisher(opts: { dbHandle: DbHandle; logger: AppLogger }): NtfyPublisher {
  const { db } = opts.dbHandle;
  const log = opts.logger;

  async function record(
    dedupeKey: string | null,
    msg: NtfyMessage,
    status: "sent" | "failed",
    detail: string | null,
  ): Promise<void> {
    await db.insert(notificationLog).values({
      dedupeKey,
      title: msg.title,
      priority: msg.priority ?? "default",
      status,
      detail,
      createdAt: new Date().toISOString(),
    });
  }

  async function send(dedupeKey: string | null, msg: NtfyMessage): Promise<PublishResult> {
    const settings = await getSetting(db, NTFY_SETTINGS_KEY, NtfySettingsSchema);
    if (!settings) return { ok: false, skipped: "unconfigured" };
    const { serverUrl, topic, token } = settings.value;

    const headers: Record<string, string> = {
      Title: msg.title,
      Priority: msg.priority ?? "default",
    };
    if (msg.tags?.length) headers.Tags = msg.tags.join(",");
    if (msg.clickUrl) headers.Click = msg.clickUrl;
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const res = await fetch(`${serverUrl.replace(/\/$/, "")}/${encodeURIComponent(topic)}`, {
        method: "POST",
        headers,
        body: msg.body,
      });
      if (!res.ok) {
        const detail = `ntfy responded ${String(res.status)}: ${(await res.text()).slice(0, 200)}`;
        await record(dedupeKey, msg, "failed", detail);
        log.warn({ dedupeKey, status: res.status }, "ntfy publish failed");
        return { ok: false, error: detail };
      }
      await record(dedupeKey, msg, "sent", null);
      log.info({ dedupeKey, title: msg.title }, "ntfy published");
      return { ok: true };
    } catch (err) {
      const detail = errorInfo(err).message;
      await record(dedupeKey, msg, "failed", detail);
      log.warn({ dedupeKey, ...errorInfo(err) }, "ntfy publish failed");
      return { ok: false, error: detail };
    }
  }

  return {
    publish: (msg) => send(null, msg),
    publishOnce: async (dedupeKey, msg) => {
      const sent = await db
        .select({ id: notificationLog.id })
        .from(notificationLog)
        .where(and(eq(notificationLog.dedupeKey, dedupeKey), eq(notificationLog.status, "sent")))
        .limit(1);
      if (sent.length > 0) return { ok: false, skipped: "duplicate" };
      return send(dedupeKey, msg);
    },
  };
}

export interface NtfyStatus {
  configured: boolean;
  serverUrl: string | null;
  topic: string | null;
  hasToken: boolean;
  recent: {
    id: number;
    title: string;
    priority: string;
    status: "sent" | "failed";
    detail: string | null;
    createdAt: string;
  }[];
}

/** Status readers exported separately so tests hit the same queries as the router. */
export async function recentNotifications(db: DbHandle["db"], limit: number) {
  return db
    .select()
    .from(notificationLog)
    .orderBy(desc(notificationLog.id))
    .limit(limit);
}

export async function saveNtfySettings(
  db: DbHandle["db"],
  value: NtfySettings,
  updatedBy: string | null,
): Promise<void> {
  await setSetting(db, NTFY_SETTINGS_KEY, NtfySettingsSchema, value, updatedBy);
}
