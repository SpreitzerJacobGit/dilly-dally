import { z } from "zod";
import type { BaseContext } from "@elements/lifecycle-service-runtime";
import type { Db } from "@elements/storage-sqlite-drizzle";

/**
 * The read-side seam: list procedures share one parameter vocabulary and one
 * resolver shape, so every listing behaves the same way.
 *
 * Usage in bespoke code:
 *   list: staffProcedure.input(listParams({ includeArchived: z.boolean().default(false) }))
 *     .query(listRead(async ({ db, input }) => ...rows))
 */
export function listParams<S extends z.ZodRawShape = Record<string, never>>(extra?: S) {
  return z.object({ search: z.string().optional() }).extend(extra ?? ({} as S));
}

export function listRead<TCtx extends BaseContext, TInput, TOut>(
  read: (args: { db: Db; input: TInput; ctx: TCtx }) => Promise<TOut>,
): (opts: { ctx: TCtx; input: TInput }) => Promise<TOut> {
  return async ({ ctx, input }) => read({ db: ctx.dbHandle.db, input, ctx });
}

/** Case-insensitive contains match for in-query search filters. */
export function searchPattern(search: string): string {
  return `%${search.replace(/[%_]/g, "")}%`;
}
