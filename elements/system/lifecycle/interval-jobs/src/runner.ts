import { eq, type Db, type DbHandle } from "@elements/storage-sqlite-drizzle";
import { errorInfo, type AppLogger } from "@elements/observability-structured-logging";
import { intervalJobStatus } from "./tables.js";

export interface IntervalJob {
  name: string;
  intervalMs: number;
  /** false = registered but never scheduled — an honest, visible state. */
  enabled: boolean;
  /**
   * Return "skipped" when the job had nothing real to do (e.g. its integration
   * is not configured). A skipped run records NOTHING — no timestamps, no
   * counters — so lastRunAt honestly means "last real attempt".
   */
  run: () => Promise<void | "skipped">;
}

export interface JobStatus {
  name: string;
  enabled: boolean;
  running: boolean;
  runCount: number;
  failCount: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export interface JobRunner {
  /** In-memory only; safe to call before migrations have run. */
  register(job: IntervalJob): void;
  /** Upserts status rows and schedules enabled jobs (first run fires immediately). */
  start(): Promise<void>;
  /** Cancels timers and awaits in-flight runs. */
  stop(): Promise<void>;
  status(): JobStatus[];
  runNow(name: string): Promise<{ started: boolean; reason?: "unknown-job" | "disabled" | "already-running" }>;
}

interface JobState {
  job: IntervalJob;
  running: boolean;
  timer: NodeJS.Timeout | null;
  inFlight: Promise<void> | null;
  memo: { runCount: number; failCount: number; lastRunAt: string | null; lastSuccessAt: string | null; lastError: string | null };
}

/**
 * Named recurring jobs with STRUCTURAL overlap prevention: each job is a
 * setTimeout chain — the next run is scheduled only after the current run's
 * promise settles, so two runs of one job cannot overlap by construction.
 * A throwing job is recorded and logged; it never crashes the process.
 */
export function createJobRunner(opts: { dbHandle: DbHandle; logger: AppLogger }): JobRunner {
  const jobs = new Map<string, JobState>();
  let stopped = false;

  async function persist(state: JobState): Promise<void> {
    await opts.dbHandle.db
      .insert(intervalJobStatus)
      .values({
        name: state.job.name,
        enabled: state.job.enabled,
        runCount: state.memo.runCount,
        failCount: state.memo.failCount,
        lastRunAt: state.memo.lastRunAt,
        lastSuccessAt: state.memo.lastSuccessAt,
        lastError: state.memo.lastError,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: intervalJobStatus.name,
        set: {
          enabled: state.job.enabled,
          runCount: state.memo.runCount,
          failCount: state.memo.failCount,
          lastRunAt: state.memo.lastRunAt,
          lastSuccessAt: state.memo.lastSuccessAt,
          lastError: state.memo.lastError,
          updatedAt: new Date().toISOString(),
        },
      });
  }

  async function runOnce(state: JobState): Promise<void> {
    state.running = true;
    const startedAt = new Date().toISOString();
    let outcome: "ran" | "skipped" | "failed" = "ran";
    try {
      const result = await state.job.run();
      if (result === "skipped") {
        outcome = "skipped";
      } else {
        state.memo.lastRunAt = startedAt;
        state.memo.runCount += 1;
        state.memo.lastSuccessAt = new Date().toISOString();
        state.memo.lastError = null;
      }
    } catch (err) {
      outcome = "failed";
      state.memo.lastRunAt = startedAt;
      state.memo.failCount += 1;
      state.memo.lastError = errorInfo(err).message.slice(0, 500);
      opts.logger.warn({ job: state.job.name, ...errorInfo(err) }, "interval job failed");
    } finally {
      state.running = false;
      if (outcome !== "skipped") {
        try {
          await persist(state);
        } catch (err) {
          opts.logger.warn({ job: state.job.name, ...errorInfo(err) }, "interval job status persist failed");
        }
      }
    }
  }

  function scheduleNext(state: JobState, delayMs: number): void {
    if (stopped || !state.job.enabled) return;
    state.timer = setTimeout(() => {
      state.inFlight = runOnce(state).then(() => {
        state.inFlight = null;
        scheduleNext(state, state.job.intervalMs);
      });
    }, delayMs);
    state.timer.unref();
  }

  return {
    register(job) {
      if (jobs.has(job.name)) throw new Error(`Job "${job.name}" already registered`);
      jobs.set(job.name, {
        job,
        running: false,
        timer: null,
        inFlight: null,
        memo: { runCount: 0, failCount: 0, lastRunAt: null, lastSuccessAt: null, lastError: null },
      });
    },

    async start() {
      for (const state of jobs.values()) {
        await persist(state); // status row exists even for disabled jobs — visible, honest
        scheduleNext(state, 0); // enabled jobs fire immediately, then every intervalMs
      }
    },

    async stop() {
      stopped = true;
      for (const state of jobs.values()) {
        if (state.timer) clearTimeout(state.timer);
        if (state.inFlight) await state.inFlight;
      }
    },

    status() {
      return [...jobs.values()].map((s) => ({
        name: s.job.name,
        enabled: s.job.enabled,
        running: s.running,
        ...s.memo,
      }));
    },

    async runNow(name) {
      const state = jobs.get(name);
      if (!state) return { started: false, reason: "unknown-job" };
      if (!state.job.enabled) return { started: false, reason: "disabled" };
      if (state.running) return { started: false, reason: "already-running" };
      state.inFlight = runOnce(state).then(() => {
        state.inFlight = null;
      });
      await state.inFlight;
      return { started: true };
    },
  };
}

/** Read helper used by status routers and /__diag — always the persisted rows. */
export async function jobStatusRows(db: Db): Promise<(typeof intervalJobStatus.$inferSelect)[]> {
  return db.select().from(intervalJobStatus);
}

/** Fetch one job's persisted row. */
export async function jobStatusRow(
  db: Db,
  name: string,
): Promise<typeof intervalJobStatus.$inferSelect | null> {
  const rows = await db.select().from(intervalJobStatus).where(eq(intervalJobStatus.name, name));
  return rows[0] ?? null;
}

/**
 * Module-scope registry so router code (built at module scope) can reach the
 * live runner for runNow — same precedent as the one canonical tRPC instance.
 */
let active: JobRunner | null = null;
export function setActiveRunner(runner: JobRunner): void {
  active = runner;
}
export function activeRunner(): JobRunner | null {
  return active;
}
