/**
 * Bundler asset imports. `?worker&url` asks the bundler to build the target as a
 * worker — resolving its own imports into one self-contained file — and hand back
 * the URL it was emitted at. That is how MapLibre's worker script gets served
 * alongside the app bundle instead of 404ing into the SPA fallback. Declared here
 * because the workspace does not pull in `vite/client`.
 */
declare module "*?worker&url" {
  const url: string;
  export default url;
}

declare module "*?url" {
  const url: string;
  export default url;
}
