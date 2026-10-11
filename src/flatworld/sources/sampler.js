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
        if (this.entries.get(key) === entry) this.entries.delete(key);
        return null;
      })
      .then((value) => {
        entry.done = true;
        entry.value = value;
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
  return { tx, ty, fx: px - tx * size, fy: py - ty * size };
}

export class ChunkSampler {
  constructor(store) {
    this.store = store;
    this.pending = new Map();
  }

  request(source, lat, lon, z) {
    if (!source.scheme.covers(lat)) return;
    const { tx, ty } = tileAddress(source, lat, lon, z);
    const key = `${source.id}/${z}/${tx}/${ty}`;
    if (!this.pending.has(key)) this.pending.set(key, { source, z, tx, ty });
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
        if (v || t.z <= t.source.scheme.minZoom) continue;
        const parent = {
          source: t.source,
          z: t.z - 1,
          tx: t.tx >> 1,
          ty: t.ty >> 1,
        };
        const key = `${parent.source.id}/${parent.z}/${parent.tx}/${parent.ty}`;
        if (!seen.has(key)) {
          seen.add(key);
          next.push(parent);
        }
      }
      wave = next;
    }
  }

  _tileFor(source, lat, lon, z) {
    for (let zz = z; zz >= source.scheme.minZoom; zz -= 1) {
      const a = tileAddress(source, lat, lon, zz);
      const tile = this.store.peek(source, zz, a.tx, a.ty);
      if (tile) return { tile, a };
    }
    return null;
  }

  /** Bilinear RGB sample (0–255) or null when no tile of any zoom is available. */
  sampleColor(source, lat, lon, z, out) {
    if (!source.scheme.covers(lat)) return null;
    const hit = this._tileFor(source, lat, lon, z);
    if (!hit || !hit.tile.rgba) return null;
    const { tile, a } = hit;
    const w = tile.width;
    const h = tile.height;
    const scale = w / source.scheme.tileSize;
    const x = Math.min(Math.max(a.fx * scale - 0.5, 0), w - 1);
    const y = Math.min(Math.max(a.fy * scale - 0.5, 0), h - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, w - 1);
    const y1 = Math.min(y0 + 1, h - 1);
    const u = x - x0;
    const v = y - y0;
    const d = tile.rgba;
    for (let c = 0; c < 3; c += 1) {
      const p00 = d[(y0 * w + x0) * 4 + c];
      const p10 = d[(y0 * w + x1) * 4 + c];
      const p01 = d[(y1 * w + x0) * 4 + c];
      const p11 = d[(y1 * w + x1) * 4 + c];
      out[c] =
        (p00 * (1 - u) + p10 * u) * (1 - v) + (p01 * (1 - u) + p11 * u) * v;
    }
    return out;
  }

  /** Bilinear height sample in metres, or NaN when unavailable. */
  sampleHeight(source, lat, lon, z) {
    if (!source.scheme.covers(lat)) return NaN;
    const hit = this._tileFor(source, lat, lon, z);
    if (!hit || !hit.tile.heights) return NaN;
    const { tile, a } = hit;
    const w = tile.width;
    const h = tile.height;
    const scale = w / source.scheme.tileSize;
    const x = Math.min(Math.max(a.fx * scale - 0.5, 0), w - 1);
    const y = Math.min(Math.max(a.fy * scale - 0.5, 0), h - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, w - 1);
    const y1 = Math.min(y0 + 1, h - 1);
    const u = x - x0;
    const v = y - y0;
    const d = tile.heights;
    return (
      (d[y0 * w + x0] * (1 - u) + d[y0 * w + x1] * u) * (1 - v) +
      (d[y1 * w + x0] * (1 - u) + d[y1 * w + x1] * u) * v
    );
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
