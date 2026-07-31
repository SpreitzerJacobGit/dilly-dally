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
