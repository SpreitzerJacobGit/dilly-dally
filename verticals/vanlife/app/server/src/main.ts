// GENERATED FROM assembly.manifest.yaml — DO NOT EDIT
import { z } from "zod";
import { loadConfig, envInt, envString } from "@elements/lifecycle-app-config";
import { createLogger, LogRingBuffer } from "@elements/observability-structured-logging";
import { createDb } from "@elements/storage-sqlite-drizzle";
import { createService } from "@elements/lifecycle-service-runtime";
import { createHealthPlugin } from "@elements/observability-health";
import { isReady } from "@elements/lifecycle-migrate-seed";
import { seedUsersFn } from "@elements/identity-session-auth";
import { createJobRunner, jobStatusRows, setActiveRunner } from "@elements/lifecycle-interval-jobs";
import { createTileAssetsPlugin } from "@elements/shell-map-view";
import { bespokeSeeds, createBespokeJobs } from "@vanlife/bespoke/server";
import { appRouter } from "./router.js";
import { SEED_CREDENTIALS } from "./seed-credentials.js";

async function main(): Promise<void> {
  const config = loadConfig(
    z.object({
      PORT: envInt().default(18081),
      DB_FILE: envString(),
      STATIC_DIR: envString().optional(),
      MIGRATIONS_DIR: envString().default("./migrations"),
      LOG_LEVEL: envString().default("info"),
      TILES_DIR: envString().default("/data/tiles"),
    }),
  );

  const ring = new LogRingBuffer();
  const logger = createLogger({ name: "vanlife", level: config.LOG_LEVEL, ringBuffer: ring });
  const dbHandle = await createDb({ dbFile: config.DB_FILE });

  // Jobs are always registered; each run loads its stored configuration and
  // skips (recording nothing) while unconfigured.
  const runner = createJobRunner({ dbHandle, logger });
  for (const job of createBespokeJobs({ dbHandle, logger, config })) runner.register(job);
  setActiveRunner(runner);

  const seeds = [
    seedUsersFn(
      SEED_CREDENTIALS.map((c) => ({ email: c.username, password: c.password, role: c.role })),
    ),
    ...bespokeSeeds,
  ];

  const service = await createService({
    port: config.PORT,
    logger,
    dbHandle,
    appRouter,
    migrationsFolder: config.MIGRATIONS_DIR,
    seeds,
    staticDir: config.STATIC_DIR,
    plugins: [
      createHealthPlugin({
        identity: {
          vertical: "vanlife",
          version: "0.1.0",
          manifestHash: "8af878c9",
        },
        ringBuffer: ring,
        checks: [
          {
            name: "database",
            check: async () => {
              await dbHandle.client.execute("SELECT 1");
              return true;
            },
          },
          { name: "seeded", check: async () => isReady(dbHandle, seeds) },
        ],
        sections: { jobs: () => jobStatusRows(dbHandle.db) },
      }),
      createTileAssetsPlugin({ dir: config.TILES_DIR }),
    ],
  });

  await service.start();
  await runner.start();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
