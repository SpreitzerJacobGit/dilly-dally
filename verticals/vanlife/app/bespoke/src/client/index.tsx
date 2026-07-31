/**
 * Bespoke client layer for Dilly-Dally: pages and navigation.
 */
import type { JSX } from "react";
import { AnchorsPage } from "./pages/AnchorsPage.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { NeedsPage } from "./pages/NeedsPage.js";
import { TripPage } from "./pages/TripPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { StatusPage } from "./pages/StatusPage.js";
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
  { path: "/", nav: { label: "Map" }, component: DashboardPage },
  { path: "/needs", nav: { label: "Needs" }, component: NeedsPage },
  { path: "/anchors", nav: { label: "Anchors" }, component: AnchorsPage },
  { path: "/trip", nav: { label: "Trip" }, component: TripPage },
  { path: "/settings", nav: { label: "Settings" }, component: SettingsPage },
  { path: "/status", nav: { label: "Status" }, component: StatusPage },
];
