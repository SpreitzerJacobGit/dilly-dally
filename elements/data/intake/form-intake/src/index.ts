import { TRPCError, type BaseContext } from "@elements/lifecycle-service-runtime";
import { withTransaction, type Db } from "@elements/storage-sqlite-drizzle";

/**
 * The write-side seam: every intake mutation resolver is
 *   validate (zod .input on the procedure) -> transactional write -> typed result.
 * A failed write leaves the data exactly as it was.
 *
 * Usage in bespoke code:
 *   create: ownerProcedure.input(teaCreateSchema).mutation(intakeWrite(async ({ db, input }) => ...))
 */
export function intakeWrite<TCtx extends BaseContext, TInput, TOut>(
  write: (args: { db: Db; input: TInput; ctx: TCtx }) => Promise<TOut>,
): (opts: { ctx: TCtx; input: TInput }) => Promise<TOut> {
  return async ({ ctx, input }) =>
    withTransaction(ctx.dbHandle, (db) => write({ db, input, ctx }));
}

/** Reject an intake with a message the form will show next to itself. */
export function rejectIntake(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}
