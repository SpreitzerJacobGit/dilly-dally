---
id: shell/app-shell
package: "@elements/shell-app-shell"
plane: system
category: shell
version: 0.1.0
variationGroup: null
variationAxis: null
summary: Application chrome — header, role-filtered navigation, signed-in user display, sign-out control, layout, and the shared visual theme.
provides: [AppShell, AppShellProps, NavItem, ShellUser]
requiresElements: []
requiresConfig: []
claims:
  - "Every screen of the application is reachable from the navigation, and navigation entries reserved for a role are invisible to everyone else."
whenToUse: "Every vertical with a web interface."
whenNotToUse: "Marketing or public pages outside the signed-in application."
---

## Purpose

One consistent frame around every page: the application name, navigation whose entries can be reserved for a role, the signed-in user with a sign-out control, and the shared stylesheet the other UI elements rely on.

## Behavior

The application name is always visible. Each navigation entry leads to the screen its label names, and the entry for the current screen is visibly marked. A user never sees a navigation entry for an area their role cannot use. The signed-in user's email and role are always visible, and the sign-out control works from any screen.

## Configuration

`appName` and the `nav` list (label, route, optional required role) come from the assembly manifest's shell config via the generated composition root.

## Wiring

Wraps the routed page content in the vertical's client composition root. `onLogout` is wired by the vertical to the auth.logout procedure, keeping the control-to-procedure edge derivable.

## Variations & alternatives

None. A sidebar or multi-tenant shell would be variations if a client's information architecture demands one.

## Limits

Single-level navigation. Theming is a fixed palette in v1 — per-client theming tokens are a planned config surface, not yet exposed.
