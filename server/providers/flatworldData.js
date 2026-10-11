import { createReadStream, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Directory of locally built flat-world tiles (ETOPO pyramid and any other local datasets).
 * Defaults to `../data/tiles` beside the checkout; override with GEV_FLATWORLD_DATA_DIR.
 */
export function flatworldDataDir(env = process.env) {
  return path.resolve(
    env.GEV_FLATWORLD_DATA_DIR || path.join(root, '..', 'data', 'tiles'),
  );
}

const TYPES = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
  '.pbf': 'application/x-protobuf',
};

/**
 * Resolve a request path to a servable file inside `dir`, or return an HTTP status.
 * Rules: tile-like paths only (letters, digits, `_`, `-`, `.`, `/`), no dot-segments or dotfiles,
 * a known extension, and the real path (after following symlinks) must stay inside `dir`.
 */
export function resolveFlatworldFile(dir, rawUrl) {
  let relative;
  try {
    relative = decodeURIComponent(String(rawUrl || '/').split('?')[0]);
  } catch {
    return { status: 400 };
  }
  if (
    relative.length > 256 ||
    !/^\/[A-Za-z0-9_\-/.]+$/.test(relative) ||
    relative.split('/').some((part) => part.startsWith('.'))
  )
    return { status: 400 };
  if (!TYPES[path.extname(relative)]) return { status: 404 };
  const file = path.join(dir, relative);
  if (!file.startsWith(dir + path.sep)) return { status: 400 };
  let real;
  let realDir;
  try {
    real = realpathSync(file);
    realDir = realpathSync(dir);
  } catch {
    return { status: 404 };
  }
  if (!real.startsWith(realDir + path.sep)) return { status: 404 };
  let stat;
  try {
    stat = statSync(real);
  } catch {
    return { status: 404 };
  }
  if (!stat.isFile()) return { status: 404 };
  return {
    status: 200,
    file: real,
    size: stat.size,
    type: TYPES[path.extname(real)],
  };
}

/** Serve read-only local tiles at /flatworld-data/* with no directory traversal. */
export function flatworldDataPlugin({ dir = flatworldDataDir() } = {}) {
  const install = (server) => {
    server.middlewares.use('/flatworld-data', (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const found = resolveFlatworldFile(dir, req.url);
      if (found.status !== 200) {
        res.writeHead(found.status, { 'Cache-Control': 'no-store' }).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': found.type,
        'Content-Length': found.size,
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') return res.end();
      const stream = createReadStream(found.file);
      // A read failing after the stat (file removed, I/O error) must not crash the server.
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    });
  };
  return {
    name: 'flatworld-data',
    configureServer: install,
    configurePreviewServer: install,
  };
}
