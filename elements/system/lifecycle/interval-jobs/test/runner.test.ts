import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb, type DbHandle } from "@elements/storage-sqlite-drizzle";
import { createLogger } from "@elements/observability-structured-logging";
import { createJobRunner, jobStatusRow } from "../src/runner.js";

async function testDb(): Promise<DbHandle> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agger-jobs-"));
  const handle = await createDb({ dbFile: path.join(dir, "test.db") });
  await handle.client.execute(
    `CREATE TABLE interval_job_status (
       name TEXT PRIMARY KEY, enabled INTEGER NOT NULL,
       run_count INTEGER NOT NULL DEFAULT 0, fail_count INTEGER NOT NULL DEFAULT 0,
       last_run_at TEXT, last_success_at TEXT, last_error TEXT, updated_at TEXT NOT NULL
     )`,
  );
  return handle;
}

const logger = createLogger({ name: "test", level: "silent" });

describe("interval-jobs runner", () => {
  it("prevents overlapping runs structurally", async () => {
    const handle = await testDb();
    let concurrent = 0;
    let maxConcurrent = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));

    const runner = createJobRunner({ dbHandle: handle, logger });
    runner.register({
      name: "slow",
      intervalMs: 1,
      enabled: true,
      run: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await gate;
        concurrent--;
      },
    });
    await runner.start();
    await new Promise((r) => setTimeout(r, 50)); // several intervals pass while first run is blocked
    expect(runner.status()[0]!.running).toBe(true);
    const second = await runner.runNow("slow");
    expect(second).toEqual({ started: false, reason: "already-running" });
    release();
    await runner.stop();
    expect(maxConcurrent).toBe(1);
    handle.close();
  });

  it("records success and failure transitions in the status table", async () => {
    const handle = await testDb();
    let shouldFail = true;
    const runner = createJobRunner({ dbHandle: handle, logger });
    runner.register({
      name: "flaky",
      intervalMs: 60_000,
      enabled: true,
      run: async () => {
        if (shouldFail) throw new Error("poll exploded");
      },
    });
    await runner.start();
    await new Promise((r) => setTimeout(r, 30)); // immediate first run (failure)
    let row = await jobStatusRow(handle.db, "flaky");
    expect(row?.failCount).toBe(1);
    expect(row?.lastError).toContain("poll exploded");
    expect(row?.lastSuccessAt).toBeNull();

    shouldFail = false;
    const result = await runner.runNow("flaky");
    expect(result.started).toBe(true);
    row = await jobStatusRow(handle.db, "flaky");
    expect(row?.runCount).toBe(1);
    expect(row?.lastError).toBeNull();
    expect(row?.lastSuccessAt).not.toBeNull();
    await runner.stop();
    handle.close();
  });

  it("never runs disabled jobs but keeps them visible, and runNow answers honestly", async () => {
    const handle = await testDb();
    let ran = false;
    const runner = createJobRunner({ dbHandle: handle, logger });
    runner.register({
      name: "unconfigured",
      intervalMs: 1,
      enabled: false,
      run: async () => {
        ran = true;
      },
    });
    await runner.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(ran).toBe(false);
    const row = await jobStatusRow(handle.db, "unconfigured");
    expect(row?.enabled).toBe(false); // visible, honest
    expect(await runner.runNow("unconfigured")).toEqual({ started: false, reason: "disabled" });
    expect(await runner.runNow("nope")).toEqual({ started: false, reason: "unknown-job" });
    await runner.stop();
    handle.close();
  });
});

describe("skipped runs", () => {
  it("records nothing at all for a skipped run", async () => {
    const handle = await testDb();
    let calls = 0;
    const runner = createJobRunner({ dbHandle: handle, logger });
    runner.register({
      name: "sometimes",
      intervalMs: 60_000,
      enabled: true,
      run: async () => {
        calls++;
        if (calls <= 2) return "skipped";
      },
    });
    await runner.start();
    await new Promise((r) => setTimeout(r, 30)); // immediate first run: skipped
    let row = await jobStatusRow(handle.db, "sometimes");
    expect(row?.lastRunAt).toBeNull();
    expect(row?.runCount).toBe(0);

    await runner.runNow("sometimes"); // second: skipped
    row = await jobStatusRow(handle.db, "sometimes");
    expect(row?.lastRunAt).toBeNull();

    await runner.runNow("sometimes"); // third: real
    row = await jobStatusRow(handle.db, "sometimes");
    expect(row?.lastRunAt).not.toBeNull();
    expect(row?.runCount).toBe(1);
    await runner.stop();
    handle.close();
  });
});
