import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Directory of locally built flat-world tiles (ETOPO pyramid and any other local datasets).
 * Defaults to `../data/tiles` beside the checkout; override with GEV_FLATWORLD_DATA_DIR.
 */
export function flatworldDataDir(env = process.env) {
  return path.resolve(env.GEV_FLATWORLD_DATA_DIR || path.join(root, '..', 'data', 'tiles'));
}

const TYPES = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
  '.pbf': 'application/x-protobuf',
};

/** Serve read-only local tiles at /flatworld-data/* with no directory traversal. */
export function flatworldDataPlugin({ dir = flatworldDataDir() } = {}) {
  const install = (server) => {
    server.middlewares.use('/flatworld-data', (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const relative = decodeURIComponent((req.url || '/').split('?')[0]);
      if (!/^\/[A-Za-z0-9_\-/.]+$/.test(relative) || relative.includes('..')) {
        res.writeHead(400).end();
        return;
      }
      const file = path.join(dir, relative);
      if (!file.startsWith(dir + path.sep)) {
        res.writeHead(400).end();
        return;
      }
      let stat;
      try {
        stat = statSync(file);
      } catch {
        res.writeHead(404, { 'Cache-Control': 'no-store' }).end();
        return;
      }
      if (!stat.isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=86400',
      });
      if (req.method === 'HEAD') return res.end();
      createReadStream(file).pipe(res);
    });
  };
  return {
    name: 'flatworld-data',
    configureServer: install,
    configurePreviewServer: install,
  };
}
