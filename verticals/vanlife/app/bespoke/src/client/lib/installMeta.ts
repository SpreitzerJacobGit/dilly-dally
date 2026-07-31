/**
 * Runtime-injected head tags — the generated index.html is pipeline-owned,
 * so PWA/meta niceties are added from here.
 *
 * The manifest and icons ship inside the image (web `public/`, served from
 * STATIC_DIR), not on the tiles volume. They are application identity, not map
 * data: keeping them with the build means they survive a `down -v`, stay
 * versioned with the app, and need no provisioning step. It also avoids a real
 * trap — an absent file under a client-routed prefix does not 404, it falls
 * through to the SPA's index.html, and the browser then reports the manifest as
 * a syntax error rather than simply declining to offer an install.
 */
export function injectInstallMeta(): void {
  if (document.querySelector('meta[name="theme-color"]')) return;
  const theme = document.createElement("meta");
  theme.name = "theme-color";
  // Matches the app shell header, which is what the OS tints on install.
  theme.content = "#234236";
  document.head.appendChild(theme);

  const manifest = document.createElement("link");
  manifest.rel = "manifest";
  manifest.href = "/manifest.webmanifest";
  document.head.appendChild(manifest);
}
