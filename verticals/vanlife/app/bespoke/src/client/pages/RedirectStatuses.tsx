import type { JSX } from "react";
import { Navigate } from "react-router-dom";
import type { PageUser } from "../index.js";
import { STATUSES_PATH } from "../components/NeedsStrip.js";

/**
 * The needs screen became the statuses manager. Its old route is kept for the
 * same reason the map and trip routes are: a bookmark, a pinned tab or an
 * installed PWA shortcut should still land somewhere, and the generated router
 * has no catch-all.
 */
export function RedirectStatuses(_props: { user: PageUser }): JSX.Element {
  return <Navigate to={STATUSES_PATH} replace />;
}
