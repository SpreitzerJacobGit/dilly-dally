// GENERATED FROM assembly.manifest.yaml — DO NOT EDIT
import { router } from "@elements/lifecycle-service-runtime";
import { createAuthRouter, createUsersRouter } from "@elements/identity-session-auth";
import { bespokeRouters } from "@vanlife/bespoke/server";

export const appRouter = router({
  auth: createAuthRouter({
    sessionTtlHours: 720,
    roles: ["operator"],
  }),
  users: createUsersRouter({
    adminRole: "operator",
    roles: ["operator"],
  }),
  ...bespokeRouters,
});

export type AppRouter = typeof appRouter;
