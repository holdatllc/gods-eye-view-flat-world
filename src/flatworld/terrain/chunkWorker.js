/**
 * Worker: builds terrain chunks off the main thread. Each worker owns a bounded source-tile cache;
 * the main thread routes chunks to workers by spatial locality so neighbours share cached tiles.
 */
import { createChunkBuilder } from './chunkBuilder.js';
import { TileStore, terrariumToHeights } from '../sources/sampler.js';

const MAX_DECODE = 2048;

async function decode(blob) {
  const bitmap = await createImageBitmap(blob, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const width = Math.min(bitmap.width, MAX_DECODE);
  const height = Math.min(bitmap.height, MAX_DECODE);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return { width, height, rgba: ctx.getImageData(0, 0, width, height).data };
}

/**
 * Esri answers HTTP 200 with a grey "Map data not yet available" image where it has no imagery
 * at a zoom. Detect it (94% of pixels are exactly RGB 204,204,204) and treat it as a missing
 * tile so the sampler falls back to a coarser real tile.
 */
function isEsriPlaceholder({ width, height, rgba }) {
  let grey = 0;
  let total = 0;
  for (let y = 2; y < height; y += 7) {
    for (let x = 3; x < width; x += 7) {
      const o = (y * width + x) * 4;
      total += 1;
      if (
        Math.abs(rgba[o] - 204) <= 2 &&
        Math.abs(rgba[o + 1] - 204) <= 2 &&
        Math.abs(rgba[o + 2] - 204) <= 2
      )
        grey += 1;
    }
  }
  return total > 0 && grey / total > 0.8;
}

const inflight = new Set();
// Bounded fetch concurrency per worker: the browser refuses work (ERR_INSUFFICIENT_RESOURCES)
// when many workers each start dozens of tile requests at once.
const MAX_FETCHES = 6;
const fetchStats = { count: 0, ms: 0, bySource: {} };
let lastUrl = '';
let active = 0;
const waiting = [];
async function acquire() {
  if (active < MAX_FETCHES) {
    active += 1;
    return;
  }
  await new Promise((resolve) => waiting.push(resolve));
  active += 1;
}
function release() {
  active -= 1;
  const next = waiting.shift();
  if (next) next();
}

async function loadTile(source, z, x, y) {
  await acquire();
  const controller = new AbortController();
  inflight.add(controller);
  const timer = setTimeout(() => controller.abort(), 12000);
  const t0 = performance.now();
  try {
    lastUrl = source.url(z, x, y);
    const response = await fetch(lastUrl, {
      signal: controller.signal,
      mode: 'cors',
    });
    // 400/404: the tile does not exist (outside coverage) — a definitive, cacheable miss.
    // Anything else (429, 5xx, network) is transient and must not poison the cache.
    if (
      response.status === 404 ||
      response.status === 400 ||
      response.status === 204
    )
      return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const image = await decode(await response.blob());
    if (source.id === 'esri' && isEsriPlaceholder(image)) return null;
    if (source.format === 'terrarium') {
      return {
        width: image.width,
        height: image.height,
        heights: terrariumToHeights(image.rgba, image.width, image.height),
      };
    }
    return image;
  } finally {
    clearTimeout(timer);
    fetchStats.count += 1;
    fetchStats.ms += performance.now() - t0;
    const bySrc = (fetchStats.bySource[source.id] ||= { n: 0, ms: 0 });
    bySrc.n += 1;
    bySrc.ms += performance.now() - t0;
    inflight.delete(controller);
    release();
  }
}

const imageryStore = new TileStore({ loadTile, maxEntries: 320 });
// One store handles both imagery and elevation; the LRU keeps the total bounded.
const builder = createChunkBuilder({ store: imageryStore });
const stats = { built: 0, failed: 0, ms: 0 };

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type === 'config') {
    if (msg.iceParams) builder.setIceParams(msg.iceParams);
    if (Number.isFinite(msg.rotationDeg))
      builder.setDisplayRotation(msg.rotationDeg);
    return;
  }
  if (msg.type === 'status') {
    self.postMessage({
      type: 'status',
      id: msg.id,
      active,
      waiting: waiting.length,
      lastUrl,
      inflight: inflight.size,
      fetchStats,
      cache: imageryStore.stats,
      stats,
    });
    return;
  }
  if (msg.type === 'build') {
    const t0 = performance.now();
    try {
      const result = await builder.build(msg.req);
      const ms = performance.now() - t0;
      stats.built += 1;
      stats.ms += ms;
      const transfer = [
        result.position.buffer,
        result.normal.buffer,
        result.bedNormal.buffer,
        result.bed.buffer,
        result.up.buffer,
        result.domain.buffer,
        result.water.buffer,
        result.skirt.buffer,
        result.uv.buffer,
        result.rgba.buffer,
      ];
      self.postMessage(
        {
          type: 'built',
          id: msg.id,
          result,
          ms,
          cache: imageryStore.stats,
          stats,
          fetchStats,
          queued: waiting.length,
        },
        transfer,
      );
    } catch (error) {
      stats.failed += 1;
      self.postMessage({
        type: 'failed',
        id: msg.id,
        error: String(error?.stack || error),
      });
    }
  }
};
