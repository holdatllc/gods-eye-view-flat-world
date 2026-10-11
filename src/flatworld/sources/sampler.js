/**
 * Source-tile cache and bilinear sampling for chunk reprojection.
 *
 * Usage per chunk: `request()` every (source, lat, lon, zoom) sample point, `await resolve()`,
 * then `sample*()` synchronously. Missing tiles (404, network errors, outside coverage) fall back
 * to the nearest available parent zoom, so a chunk is never left with a hole.
 */
import { decodeTerrarium, wrapPixelX } from './tileSchemes.js';

export class TileStore {
  /**
   * @param {{ loadTile: (source, z, x, y) => Promise<{width,height,rgba?:Uint8ClampedArray,heights?:Float32Array}|null>, maxEntries?: number }} options
   */
  constructor({ loadTile, maxEntries = 256 }) {
    this.loadTile = loadTile;
    this.maxEntries = maxEntries;
    this.entries = new Map(); // key -> { promise, value, done }
    this.stats = { requests: 0, hits: 0, failures: 0, failuresBySource: {} };
    /** Keys whose last load failed transiently (network/5xx/timeout) — not cached, retryable. */
    this.transientKeys = new Set();
  }

  key(source, z, x, y) {
    return `${source.id}/${z}/${x}/${y}`;
  }

  get(source, z, x, y) {
    const key = this.key(source, z, x, y);
    const existing = this.entries.get(key);
    if (existing) {
      this.stats.hits += 1;
      this.entries.delete(key);
      this.entries.set(key, existing); // LRU touch
      return existing.promise;
    }
    this.stats.requests += 1;
    const entry = { done: false, value: null, promise: null };
    entry.promise = this.loadTile(source, z, x, y)
      .catch(() => {
        // Transient failure: forget it so a later chunk can retry; this chunk uses a parent zoom.
        this.stats.transient = (this.stats.transient || 0) + 1;
        this.transientKeys.add(key);
        if (this.entries.get(key) === entry) this.entries.delete(key);
        return null;
      })
      .then((value) => {
        entry.done = true;
        entry.value = value;
        if (value) this.transientKeys.delete(key);
        if (!value) {
          this.stats.failures += 1;
          this.stats.failuresBySource[source.id] =
            (this.stats.failuresBySource[source.id] || 0) + 1;
        }
        return value;
      });
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
    return entry.promise;
  }

  /** Synchronous lookup of an already-loaded tile (undefined if not loaded, null if missing). */
  peek(source, z, x, y) {
    const entry = this.entries.get(this.key(source, z, x, y));
    if (!entry || !entry.done) return undefined;
    return entry.value;
  }
}

function tileAddress(source, lat, lon, z) {
  const { scheme } = source;
  const p = scheme.pixel(lat, lon, z);
  const px = wrapPixelX(p.px, p.nx);
  const py = Math.min(Math.max(p.py, 0), p.ny - 1e-9);
  const size = scheme.tileSize;
  const tx = Math.floor(px / size);
  const ty = Math.floor(py / size);
  return {
    tx,
    ty,
    fx: px - tx * size,
    fy: py - ty * size,
    px,
    py,
    nx: p.nx,
    ny: p.ny,
  };
}

/**
 * Per-chunk sampler. Tiles loaded for a chunk are pinned in `this.tiles`, so the shared LRU
 * evicting them mid-build cannot turn a chunk into "no data". Bilinear filtering reads across
 * source-tile edges from the neighbouring tile, so there is no seam at tile boundaries.
 */
export class ChunkSampler {
  constructor(store) {
    this.store = store;
    this.pending = new Map();
    this.tiles = new Map(); // key -> loaded tile (pinned for this chunk)
    this.incomplete = false; // a tile failed transiently: the chunk should be rebuilt later
  }

  _key(source, z, tx, ty) {
    return `${source.id}/${z}/${tx}/${ty}`;
  }

  _add(source, z, tx, ty) {
    const key = this._key(source, z, tx, ty);
    if (!this.pending.has(key)) this.pending.set(key, { source, z, tx, ty });
  }

  request(source, lat, lon, z) {
    if (!source.scheme.covers(lat)) return;
    const a = tileAddress(source, lat, lon, z);
    this._add(source, z, a.tx, a.ty);
    // Bilinear taps within a pixel of a tile edge need the neighbouring tile too.
    const size = source.scheme.tileSize;
    const cols = Math.ceil(a.nx / size);
    const rows = Math.ceil(a.ny / size);
    const dx = a.fx < 1 ? -1 : a.fx > size - 1 ? 1 : 0;
    const dy = a.fy < 1 ? -1 : a.fy > size - 1 ? 1 : 0;
    const wrapX = (x) => ((x % cols) + cols) % cols;
    if (dx) this._add(source, z, wrapX(a.tx + dx), a.ty);
    if (dy && a.ty + dy >= 0 && a.ty + dy < rows) {
      this._add(source, z, a.tx, a.ty + dy);
      if (dx) this._add(source, z, wrapX(a.tx + dx), a.ty + dy);
    }
  }

  /** Load every requested tile, then walk failed ones down to available parents. */
  async resolve() {
    let wave = [...this.pending.values()];
    this.pending.clear();
    const seen = new Set();
    while (wave.length) {
      const results = await Promise.all(
        wave.map((t) =>
          this.store.get(t.source, t.z, t.tx, t.ty).then((v) => ({ t, v })),
        ),
      );
      const next = [];
      for (const { t, v } of results) {
        const key = this._key(t.source, t.z, t.tx, t.ty);
        if (v) {
          this.tiles.set(key, v);
          continue;
        }
        if (this.store.transientKeys.has(key)) this.incomplete = true;
        if (t.z <= t.source.scheme.minZoom) continue;
        const parent = {
          source: t.source,
          z: t.z - 1,
          tx: t.tx >> 1,
          ty: t.ty >> 1,
        };
        const pkey = this._key(parent.source, parent.z, parent.tx, parent.ty);
        if (!seen.has(pkey)) {
          seen.add(pkey);
          next.push(parent);
        }
      }
      wave = next;
    }
  }

  _tile(source, z, tx, ty) {
    return (
      this.tiles.get(this._key(source, z, tx, ty)) ||
      this.store.peek(source, z, tx, ty) ||
      null
    );
  }

  _tileFor(source, lat, lon, z) {
    for (let zz = z; zz >= source.scheme.minZoom; zz -= 1) {
      const a = tileAddress(source, lat, lon, zz);
      const tile = this._tile(source, zz, a.tx, a.ty);
      if (tile) return { tile, a, z: zz };
    }
    return null;
  }

  /**
   * Bilinear sample of channel data at a lat/lon. `read(tile, x, y)` returns a value for an
   * in-tile pixel; samples that fall in a neighbouring tile read that tile when it is loaded.
   */
  _bilinear(source, lat, lon, z, read, fallback) {
    const hit = this._tileFor(source, lat, lon, z);
    if (!hit) return null;
    const { tile, a } = hit;
    const size = source.scheme.tileSize;
    const scale = tile.width / size;
    const gx = a.px * scale - 0.5;
    const gy = a.py * scale - 0.5;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const u = gx - x0;
    const v = gy - y0;
    const nxPx = a.nx * scale;
    const nyPx = a.ny * scale;
    const tilePx = tile.width;
    const at = (x, y) => {
      if (scale !== 1) {
        // Unusual decoded size: stay inside the base tile.
        const lx = Math.min(Math.max(x - a.tx * tilePx, 0), tile.width - 1);
        const ly = Math.min(Math.max(y - a.ty * tilePx, 0), tile.height - 1);
        return read(tile, lx, ly);
      }
      const wx = ((x % nxPx) + nxPx) % nxPx;
      const wy = Math.min(Math.max(y, 0), nyPx - 1);
      const tx = Math.floor(wx / tilePx);
      const ty = Math.floor(wy / tilePx);
      const t =
        tx === a.tx && ty === a.ty ? tile : this._tile(source, hit.z, tx, ty);
      if (!t) {
        const lx = Math.min(Math.max(wx - a.tx * tilePx, 0), tile.width - 1);
        const ly = Math.min(Math.max(wy - a.ty * tilePx, 0), tile.height - 1);
        return read(tile, lx, ly);
      }
      return read(t, wx - tx * tilePx, wy - ty * tilePx);
    };
    return fallback(
      at(x0, y0),
      at(x0 + 1, y0),
      at(x0, y0 + 1),
      at(x0 + 1, y0 + 1),
      u,
      v,
    );
  }

  /** Bilinear RGB sample (0–255) or null when no tile of any zoom is available. */
  sampleColor(source, lat, lon, z, out) {
    if (!source.scheme.covers(lat)) return null;
    const hit = this._tileFor(source, lat, lon, z);
    if (!hit || !hit.tile.rgba) return null;
    // One pass gathers the four taps (tile + pixel index); channels are blended below.
    const taps =
      this._taps || (this._taps = [null, 0, null, 0, null, 0, null, 0]);
    let n = 0;
    const weights = this._bilinear(
      source,
      lat,
      lon,
      z,
      (t, x, y) => {
        taps[n * 2] = t;
        taps[n * 2 + 1] = (y * t.width + x) * 4;
        n += 1;
        return 0;
      },
      (p00, p10, p01, p11, u, v) => [u, v],
    );
    const [u, v] = weights;
    const w00 = (1 - u) * (1 - v);
    const w10 = u * (1 - v);
    const w01 = (1 - u) * v;
    const w11 = u * v;
    for (let c = 0; c < 3; c += 1) {
      out[c] =
        taps[0].rgba[taps[1] + c] * w00 +
        taps[2].rgba[taps[3] + c] * w10 +
        taps[4].rgba[taps[5] + c] * w01 +
        taps[6].rgba[taps[7] + c] * w11;
    }
    return out;
  }

  /** Bilinear height sample in metres, or NaN when unavailable. */
  sampleHeight(source, lat, lon, z) {
    if (!source.scheme.covers(lat)) return NaN;
    const hit = this._tileFor(source, lat, lon, z);
    if (!hit || !hit.tile.heights) return NaN;
    const h = this._bilinear(
      source,
      lat,
      lon,
      z,
      (t, x, y) => t.heights[y * t.width + x],
      (p00, p10, p01, p11, u, v) =>
        (p00 * (1 - u) + p10 * u) * (1 - v) + (p01 * (1 - u) + p11 * u) * v,
    );
    return h ?? NaN;
  }
}

/** Convert decoded RGBA pixels of a terrarium tile to metres. */
export function terrariumToHeights(rgba, width, height) {
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = decodeTerrarium(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  }
  return out;
}
