import type { FastifyPluginAsync } from "fastify";
import type { LogRingBuffer } from "@elements/observability-structured-logging";

export interface NamedCheck {
  name: string;
  /** Throws or resolves false when unhealthy. */
  check: () => boolean | Promise<boolean>;
}

export interface HealthPluginOptions {
  checks: NamedCheck[];
  /** Static identity of this build: vertical, version, manifest hash. */
  identity: Record<string, string>;
  ringBuffer?: LogRingBuffer;
  /** Extra named diagnostics merged into /__diag (e.g. background job statuses). */
  sections?: Record<string, () => unknown | Promise<unknown>>;
}

/**
 * /healthz  — liveness: the process is up.
 * /readyz   — readiness: storage reachable, migrations and seeds applied.
 * /__diag   — identity, uptime, and recent warnings/errors. The only window
 *             into infrastructure the operator cannot inspect directly.
 */
export function createHealthPlugin(opts: HealthPluginOptions): FastifyPluginAsync {
  const startedAt = Date.now();
  return async (app) => {
    app.get("/healthz", async () => ({ ok: true }));

    app.get("/readyz", async (_req, reply) => {
      const failures: string[] = [];
      for (const c of opts.checks) {
        try {
          if (!(await c.check())) failures.push(c.name);
        } catch {
          failures.push(c.name);
        }
      }
      if (failures.length > 0) {
        return reply.status(503).send({ ok: false, failing: failures });
      }
      return { ok: true };
    });

    app.get("/__diag", async () => {
      const extra: Record<string, unknown> = {};
      for (const [name, provide] of Object.entries(opts.sections ?? {})) {
        try {
          extra[name] = await provide();
        } catch (err) {
          extra[name] = { error: err instanceof Error ? err.message : String(err) };
        }
      }
      return {
        identity: opts.identity,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        recentProblems: opts.ringBuffer?.recent(50) ?? [],
        ...extra,
      };
    });
  };
}
