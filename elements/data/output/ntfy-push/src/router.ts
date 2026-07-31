import { z } from "zod";
import { router } from "@elements/lifecycle-service-runtime";
import { protectedProcedure } from "@elements/identity-session-auth";
import { getSetting, deleteSetting } from "@elements/lifecycle-app-settings";
import {
  NTFY_SETTINGS_KEY,
  NtfySettingsSchema,
  createNtfyPublisher,
  recentNotifications,
  saveNtfySettings,
  type NtfyStatus,
} from "./publisher.js";

/**
 * Status + settings surface. The topic is shown back (it is not a secret the
 * operator typed blind — they chose it), but the token never leaves the server.
 */
export function createNtfyStatusRouter() {
  return router({
    status: protectedProcedure.query(async ({ ctx }): Promise<NtfyStatus> => {
      const db = ctx.dbHandle.db;
      const stored = await getSetting(db, NTFY_SETTINGS_KEY, NtfySettingsSchema);
      const recent = await recentNotifications(db, 20);
      return {
        configured: stored !== null,
        serverUrl: stored?.value.serverUrl ?? null,
        topic: stored?.value.topic ?? null,
        hasToken: Boolean(stored?.value.token),
        recent: recent.map((r) => ({
          id: r.id,
          title: r.title,
          priority: r.priority,
          status: r.status as "sent" | "failed",
          detail: r.detail,
          createdAt: r.createdAt,
        })),
      };
    }),

    saveSettings: protectedProcedure
      .input(
        z.object({
          serverUrl: z.url(),
          topic: z.string().min(1),
          token: z.string().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await saveNtfySettings(ctx.dbHandle.db, input, String(ctx.user.id));
        return { saved: true as const };
      }),

    clearSettings: protectedProcedure.mutation(async ({ ctx }) => {
      await deleteSetting(ctx.dbHandle.db, NTFY_SETTINGS_KEY);
      return { cleared: true as const };
    }),

    testPublish: protectedProcedure.mutation(async ({ ctx }) => {
      const publisher = createNtfyPublisher({ dbHandle: ctx.dbHandle, logger: ctx.logger });
      return publisher.publish({
        title: "Test notification",
        body: "ntfy delivery is working.",
        priority: "default",
        tags: ["white_check_mark"],
      });
    }),
  });
}
