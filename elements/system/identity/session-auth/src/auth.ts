import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  publicProcedure,
  router,
  middleware,
  TRPCError,
  type BaseContext,
} from "@elements/lifecycle-service-runtime";
import { eq, and } from "@elements/storage-sqlite-drizzle";
import type { DbHandle } from "@elements/storage-sqlite-drizzle";
import { users, sessions } from "./tables.js";
import { verifyPassword, hashPassword } from "./password.js";

const SESSION_COOKIE = "agger_session";

export interface SessionUser {
  id: number;
  email: string;
  role: string;
}

export interface AuthConfig {
  sessionTtlHours: number;
  roles: readonly string[];
}

async function userForToken(ctx: BaseContext, token: string): Promise<SessionUser | null> {
  const now = new Date().toISOString();
  const rows = await ctx.dbHandle.db
    .select({ id: users.id, email: users.email, role: users.role, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.token, token), eq(users.active, true)));
  const row = rows[0];
  if (!row || row.expiresAt < now) return null;
  return { id: row.id, email: row.email, role: row.role };
}

const requireUser = middleware(async ({ ctx, next }) => {
  const token = ctx.cookies.get(SESSION_COOKIE);
  const user = token ? await userForToken(ctx, token) : null;
  if (!user) throw new TRPCError({ code: "UNAUTHORIZED", message: "not signed in" });
  return next({ ctx: { ...ctx, user } });
});

/** Any signed-in, active user. */
export const protectedProcedure = publicProcedure.use(requireUser);

/** Signed-in user with a specific role. */
export function roleProcedure(role: string) {
  return protectedProcedure.use(({ ctx, next }) => {
    const user = (ctx as BaseContext & { user: SessionUser }).user;
    if (user.role !== role) {
      throw new TRPCError({ code: "FORBIDDEN", message: `requires role "${role}"` });
    }
    return next();
  });
}

export function createAuthRouter(config: AuthConfig) {
  return router({
    login: publicProcedure
      .input(z.object({ email: z.string(), password: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const rows = await ctx.dbHandle.db
          .select()
          .from(users)
          .where(and(eq(users.email, input.email), eq(users.active, true)));
        const user = rows[0];
        if (!user || !verifyPassword(input.password, user.passwordHash)) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "invalid email or password" });
        }
        const token = randomBytes(32).toString("hex");
        const now = new Date();
        const expires = new Date(now.getTime() + config.sessionTtlHours * 3600 * 1000);
        await ctx.dbHandle.db.insert(sessions).values({
          token,
          userId: user.id,
          expiresAt: expires.toISOString(),
          createdAt: now.toISOString(),
        });
        ctx.cookies.set(SESSION_COOKIE, token, {
          maxAgeSeconds: config.sessionTtlHours * 3600,
        });
        return { id: user.id, email: user.email, role: user.role };
      }),

    logout: protectedProcedure.mutation(async ({ ctx }) => {
      const token = ctx.cookies.get(SESSION_COOKIE);
      if (token) {
        await ctx.dbHandle.db.delete(sessions).where(eq(sessions.token, token));
      }
      ctx.cookies.clear(SESSION_COOKIE);
      return { ok: true };
    }),

    me: publicProcedure.query(async ({ ctx }) => {
      const token = ctx.cookies.get(SESSION_COOKIE);
      if (!token) return null;
      return userForToken(ctx, token);
    }),
  });
}

export function createUsersRouter(config: { adminRole: string; roles: readonly string[] }) {
  const admin = roleProcedure(config.adminRole);
  return router({
    list: admin.query(async ({ ctx }) => {
      return ctx.dbHandle.db
        .select({
          id: users.id,
          email: users.email,
          role: users.role,
          active: users.active,
          createdAt: users.createdAt,
        })
        .from(users);
    }),

    create: admin
      .input(
        z.object({
          email: z.string().email(),
          password: z.string().min(8),
          role: z.string(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        if (!config.roles.includes(input.role)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `unknown role "${input.role}"` });
        }
        const inserted = await ctx.dbHandle.db
          .insert(users)
          .values({
            email: input.email,
            passwordHash: hashPassword(input.password),
            role: input.role,
            active: true,
            createdAt: new Date().toISOString(),
          })
          .returning({ id: users.id });
        return { id: inserted[0]!.id };
      }),

    setRole: admin
      .input(z.object({ userId: z.number(), role: z.string() }))
      .mutation(async ({ ctx, input }) => {
        if (!config.roles.includes(input.role)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `unknown role "${input.role}"` });
        }
        await ctx.dbHandle.db.update(users).set({ role: input.role }).where(eq(users.id, input.userId));
        return { ok: true };
      }),

    deactivate: admin
      .input(z.object({ userId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await ctx.dbHandle.db.update(users).set({ active: false }).where(eq(users.id, input.userId));
        await ctx.dbHandle.db.delete(sessions).where(eq(sessions.userId, input.userId));
        return { ok: true };
      }),
  });
}

/** Seed helper: creates the given users on first boot (ledger-tracked by migrate-seed). */
export function seedUsersFn(
  usersToSeed: { email: string; password: string; role: string }[],
): { id: string; run: (handle: DbHandle) => Promise<void> } {
  return {
    id: "identity-seed-users-v1",
    run: async (handle) => {
      for (const u of usersToSeed) {
        await handle.db.insert(users).values({
          email: u.email,
          passwordHash: hashPassword(u.password),
          role: u.role,
          active: true,
          createdAt: new Date().toISOString(),
        });
      }
    },
  };
}
