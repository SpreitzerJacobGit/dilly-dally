import { initTRPC, TRPCError } from "@trpc/server";
import type { BaseContext } from "./context.js";

/**
 * The one canonical tRPC instance. Every procedure in the application — element
 * or bespoke — is built from these builders, which is what keeps the client-server
 * seam statically checkable: a procedure exists in the merged appRouter or nowhere.
 */
const t = initTRPC.context<BaseContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;
export const mergeRouters = t.mergeRouters;
export { TRPCError };
