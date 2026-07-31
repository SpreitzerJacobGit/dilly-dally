import path from "node:path";
import fs from "node:fs";
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import {
  fastifyTRPCPlugin,
  type CreateFastifyContextOptions,
} from "@trpc/server/adapters/fastify";
import type { AnyTRPCRouter } from "@trpc/server";
import type { DbHandle } from "@elements/storage-sqlite-drizzle";
import { errorInfo, type AppLogger } from "@elements/observability-structured-logging";
import { migrateAndSeed, type SeedFn } from "@elements/lifecycle-migrate-seed";
import type { BaseContext, Cookies } from "./context.js";

export interface ServiceOptions {
  port: number;
  host?: string;
  logger: AppLogger;
  dbHandle: DbHandle;
  appRouter: AnyTRPCRouter;
  migrationsFolder: string;
  seeds: SeedFn[];
  /** Built client assets; served with an SPA fallback when provided. */
  staticDir?: string;
  /** Extra plugins (health endpoints, etc.) registered before listen. */
  plugins?: FastifyPluginAsync[];
}

export interface Service {
  app: FastifyInstance;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * The canonical boot order: storage is already open (config → logger → storage
 * happen in the composition root), then HERE: migrate/seed → routes → listen.
 * There is no other way a vertical comes up.
 */
export async function createService(opts: ServiceOptions): Promise<Service> {
  const log = opts.logger;

  const result = await migrateAndSeed(opts.dbHandle, {
    migrationsFolder: opts.migrationsFolder,
    seeds: opts.seeds,
  });
  log.info(
    { seedsRun: result.seedsRun, seedsSkipped: result.seedsSkipped },
    "migrations and seeds applied",
  );

  // maxParamLength: Fastify's router refuses to match any path parameter over
  // 100 chars by default — tRPC batch URLs (comma-joined procedure paths)
  // routinely exceed that and would 404. The documented fix for the adapter.
  const app = Fastify({ logger: false, maxParamLength: 5000 });
  await app.register(cookie);

  app.addHook("onResponse", (req, reply, done) => {
    log.info({ method: req.method, url: req.url, status: reply.statusCode }, "request");
    done();
  });
  app.setErrorHandler((err, req, reply) => {
    log.error({ ...errorInfo(err), url: req.url }, "unhandled error");
    void reply.status(500).send({ error: "internal error" });
  });

  await app.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: {
      router: opts.appRouter,
      createContext: ({ req, res }: CreateFastifyContextOptions): BaseContext => {
        const cookies: Cookies = {
          get: (name) => req.cookies[name],
          set: (name, value, o) =>
            void res.setCookie(name, value, {
              httpOnly: true,
              sameSite: "lax",
              path: "/",
              maxAge: o?.maxAgeSeconds,
            }),
          clear: (name) => void res.clearCookie(name, { path: "/" }),
        };
        return { dbHandle: opts.dbHandle, logger: log, cookies };
      },
      onError: ({ error, path: procPath }: { error: Error; path?: string }) => {
        log.warn({ ...errorInfo(error), procedure: procPath }, "trpc error");
      },
    },
  });

  for (const plugin of opts.plugins ?? []) {
    await app.register(plugin);
  }

  if (opts.staticDir && fs.existsSync(opts.staticDir)) {
    await app.register(fastifyStatic, { root: path.resolve(opts.staticDir) });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/trpc")) {
        void reply.status(404).send({ error: "not found" });
        return;
      }
      void reply.sendFile("index.html");
    });
  }

  return {
    app,
    start: async () => {
      await app.listen({ port: opts.port, host: opts.host ?? "0.0.0.0" });
      log.info({ port: opts.port }, "service listening");
    },
    stop: async () => {
      await app.close();
      opts.dbHandle.close();
    },
  };
}
