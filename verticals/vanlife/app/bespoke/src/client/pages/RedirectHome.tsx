import type { JSX } from "react";
import { Navigate } from "react-router-dom";
import type { PageUser } from "../index.js";

/**
 * The old Map, Anchors and Trip screens are one screen now.
 *
 * Their routes are kept so a bookmark or a pinned tab still lands somewhere —
 * the generated router has no catch-all, so without this they would render an
 * empty shell rather than a page.
 */
export function RedirectHome(_props: { user: PageUser }): JSX.Element {
  return <Navigate to="/" replace />;
}
