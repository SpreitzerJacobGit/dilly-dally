import fs from "node:fs";
import path from "node:path";
import type { FastifyPluginAsync } from "fastify";
import fastifyStatic from "@fastify/static";

export interface TileAssetsOptions {
  /** Directory holding basemap.pmtiles plus glyphs/ and sprites/ subtrees. */
  dir: string;
  /** URL prefix the assets are served under. */
  prefix?: string;
}

/**
 * Serves the offline basemap bundle — the .pmtiles archive (range requests are
 * what make a multi-GB archive servable at all) and the glyph/sprite assets the
 * style references. Everything a map render needs resolves to this host: no
 * request leaves the building for tiles, fonts, or icons.
 *
 * A missing directory is not fatal at boot (data volumes are provisioned out of
 * band) — but /<prefix>/status reports it honestly so a status page can say
 * "basemap missing" instead of the map silently failing.
 */
/**
 * Sidecar manifests: any *.json sitting beside the archives, parsed and keyed
 * by basename.
 *
 * Tile volumes are filled out of band by scripts this server never sees, and a
 * manifest is how such a script reports what it installed and when it last
 * managed to — the difference between "no coverage here" and "the refresh has
 * been failing since March". Deliberately untyped and generic: this element
 * knows about archives, not about what any particular archive contains.
 */
function readManifests(root: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!fs.existsSync(root)) return out;
  for (const file of fs.readdirSync(root)) {
    if (!file.endsWith(".json")) continue;
    try {
      const full = path.join(root, file);
      // A manifest is a handful of fields. Anything larger is not one, and
      // parsing it would put an unbounded read inside a status endpoint.
      if (fs.statSync(full).size > 64 * 1024) continue;
      out[file.slice(0, -".json".length)] = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      // Half-written or malformed: skip it. A bad manifest must not take down
      // the endpoint whose whole job is to report that something is wrong.
    }
  }
  return out;
}

export function createTileAssetsPlugin(opts: TileAssetsOptions): FastifyPluginAsync {
  const prefix = opts.prefix ?? "/tiles";
  const root = path.resolve(opts.dir);

  return async (app) => {
    app.get(`${prefix}/status`, () => {
      const pmtiles = fs.existsSync(root)
        ? fs.readdirSync(root).filter((f) => f.endsWith(".pmtiles"))
        : [];
      return {
        dir: root,
        present: fs.existsSync(root),
        archives: pmtiles,
        glyphs: fs.existsSync(path.join(root, "glyphs")),
        sprites: fs.existsSync(path.join(root, "sprites")),
        manifests: readManifests(root),
      };
    });

    if (!fs.existsSync(root)) return;
    await app.register(fastifyStatic, {
      root,
      prefix: `${prefix}/`,
      decorateReply: false,
      // acceptRanges defaults to true — load-bearing for pmtiles.
    });
  };
}
