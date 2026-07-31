---
id: identity/session-auth
package: "@elements/identity-session-auth"
plane: system
category: identity
version: 0.1.0
variationGroup: identity/auth
variationAxis: "Cookie-session with server-side state vs. a future stateless-token variation; choosing sessions propagates a same-origin, single-service deployment shape."
summary: Cookie-session authentication with a role model — login, logout, session lookup, role-gated procedures, user administration, and seeded first-run accounts.
provides: [users, sessions, hashPassword, verifyPassword, createAuthRouter, createUsersRouter, protectedProcedure, roleProcedure, seedUsersFn, AuthConfig, SessionUser]
requiresElements: [lifecycle/service-runtime, storage/sqlite-drizzle]
requiresConfig: []
claims:
  - "Signing in with valid credentials succeeds on the first attempt and the session persists across page reloads until it expires or the user signs out."
  - "A user without the required role can neither see nor successfully invoke an action reserved for that role."
  - "Working accounts exist on first run — the login page is never a wall."
whenToUse: "Any vertical with more than one user or any action that must be attributed or restricted."
whenNotToUse: "Single sign-on against a client's identity provider — that is a separate variation in group identity/auth."
---

## Purpose

Everything about who is using the application: password sign-in with server-side sessions, a role per user, tRPC middleware that gates procedures by sign-in and by role, an administration surface for accounts, and a seed hook so demo accounts exist the moment the application first starts.

## Behavior

A visitor who is not signed in is taken to the sign-in page, and the credentials provided with the installation work on the first attempt. After signing in, the user stays signed in across page reloads until the session expires or they sign out. Signing out returns to the sign-in page immediately. Every action reserved for a specific role is refused by the server for anyone else, and the interface does not show controls the current user is not permitted to use. An administrator can create accounts, change a user's role, and deactivate an account; a deactivated user is signed out everywhere and can no longer sign in.

## Configuration

`sessionTtlHours` (session lifetime), `roles` (the closed set of role names), `adminRole` (which role may administer users). Passwords are hashed with scrypt from node:crypto — no native dependencies.

## Wiring

Server: `createAuthRouter` and `createUsersRouter` merge into the vertical's appRouter; `protectedProcedure`/`roleProcedure` are the builders bespoke routers use for gated procedures; `seedUsersFn` joins the seed list with credentials from the assembly manifest. Tables `users`/`sessions` join the vertical's schema barrel for migrations. Client: `LoginPage` and `RequireRole` are presentational; the vertical wires them to the auth procedures so the control-to-procedure edges stay in derivable code.

## Variations & alternatives

Future variations in group `identity/auth`: stateless tokens (for API-first clients), SSO/OIDC (for clients with an identity provider). Not interchangeable — switching propagates to session storage, logout semantics, and deployment shape.

## Limits

No password reset flow in v1 (administrators set passwords). No account lockout or rate limiting yet. Single role per user.
