/**
 * Runtime-injected head tags — the generated index.html is pipeline-owned,
 * so PWA/meta niceties are added from here. The manifest (and icons) live in
 * the tiles asset volume, provisioned by the data-prep script; a 404 there
 * degrades to "no install prompt", never an error.
 */
export function injectInstallMeta(): void {
  if (document.querySelector('meta[name="theme-color"]')) return;
  const theme = document.createElement("meta");
  theme.name = "theme-color";
  theme.content = "#2563eb";
  document.head.appendChild(theme);

  const manifest = document.createElement("link");
  manifest.rel = "manifest";
  manifest.href = "/tiles/manifest.webmanifest";
  document.head.appendChild(manifest);
}
