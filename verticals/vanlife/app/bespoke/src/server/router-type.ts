/**
 * Type-only construction of the full app router, so the client in this package
 * can be typed without importing the generated server package (a cycle).
 */
import { router } from "@elements/lifecycle-service-runtime";
import { createAuthRouter, createUsersRouter } from "@elements/identity-session-auth";
import { bespokeRouters } from "./index.js";

function build() {
  return router({
    auth: createAuthRouter(null as never),
    users: createUsersRouter(null as never),
    ...bespokeRouters,
  });
}

export type AppRouter = ReturnType<typeof build>;
