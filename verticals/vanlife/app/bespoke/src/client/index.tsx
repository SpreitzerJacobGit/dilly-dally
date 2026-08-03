/**
 * Bespoke client layer for Dilly-Dally: pages and navigation.
 */
import type { JSX } from "react";
import { PlannerPage } from "./pages/PlannerPage.js";
import { StatusesPage } from "./pages/StatusesPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { StatusPage } from "./pages/StatusPage.js";
import { RedirectHome } from "./pages/RedirectHome.js";
import { RedirectStatuses } from "./pages/RedirectStatuses.js";
import { injectInstallMeta } from "./lib/installMeta.js";

export { trpc } from "./trpc.js";

injectInstallMeta();

export interface PageUser {
  email: string;
  role: string;
}

export interface BespokePage {
  path: string;
  nav: { label: string } | null;
  /** When set, the ROUTE (not just the nav entry) is reserved for this role. */
  requiresRole?: string;
  component: (props: { user: PageUser }) => JSX.Element;
}

export const bespokePages: BespokePage[] = [
  { path: "/", nav: { label: "Plan" }, component: PlannerPage },
  { path: "/statuses", nav: { label: "Statuses" }, component: StatusesPage },
  { path: "/settings", nav: { label: "Settings" }, component: SettingsPage },
  { path: "/status", nav: { label: "Status" }, component: StatusPage },
  // The map, anchors and trip screens became one; their routes still land.
  { path: "/plan", nav: null, component: RedirectHome },
  { path: "/anchors", nav: null, component: RedirectHome },
  { path: "/trip", nav: null, component: RedirectHome },
  // The needs screen grew into the statuses manager and took its route with it.
  { path: "/needs", nav: null, component: RedirectStatuses },
];
