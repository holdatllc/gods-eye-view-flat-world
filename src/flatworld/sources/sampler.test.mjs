import test from 'node:test';
import assert from 'node:assert/strict';
import { TileStore, ChunkSampler } from './sampler.js';
import { webMercatorScheme } from './tileSchemes.js';

// A 2×2-pixel-per-tile fake source whose pixel values encode their global column, so bilinear
// filtering across a tile edge must blend values from two different tiles.
const SIZE = 2;
const source = {
  id: 'fake',
  scheme: webMercatorScheme({ tileSize: SIZE, maxZoom: 3 }),
  format: 'rgba',
};
const store = new TileStore({
  loadTile: async (src, z, x, y) => {
    const rgba = new Uint8ClampedArray(SIZE * SIZE * 4);
    for (let j = 0; j < SIZE; j += 1)
      for (let i = 0; i < SIZE; i += 1) {
        const o = (j * SIZE + i) * 4;
        rgba[o] = (x * SIZE + i) * 10;
        rgba[o + 1] = (y * SIZE + j) * 10;
        rgba[o + 3] = 255;
      }
    return { width: SIZE, height: SIZE, rgba };
  },
});

test('bilinear sampling blends across a source-tile edge (no seam)', async () => {
  // Zoom 2 → 4×4 tiles of 2 px. Longitude of the boundary between tile columns 1 and 2 is 0°.
  const s = new ChunkSampler(store);
  s.request(source, 10, 0.0001, 2);
  s.request(source, 10, -0.0001, 2);
  await s.resolve();
  const right = s.sampleColor(source, 10, 0.0001, 2, [0, 0, 0]);
  const left = s.sampleColor(source, 10, -0.0001, 2, [0, 0, 0]);
  // Global pixel columns 3 (value 30) and 4 (value 40) meet at lon 0: both sides ≈ 35.
  assert.ok(Math.abs(right[0] - 35) < 0.1, `right ${right[0]}`);
  assert.ok(Math.abs(left[0] - 35) < 0.1, `left ${left[0]}`);
});

test('tiles loaded for a chunk stay pinned even if the shared LRU evicts them', async () => {
  const tiny = new TileStore({ loadTile: store.loadTile, maxEntries: 1 });
  const s = new ChunkSampler(tiny);
  s.request(source, 10, 30, 2);
  s.request(source, -50, -120, 2);
  await s.resolve();
  assert.ok(s.sampleColor(source, 10, 30, 2, [0, 0, 0]));
  assert.ok(s.sampleColor(source, -50, -120, 2, [0, 0, 0]));
});

test('transient failures mark the chunk incomplete; definitive misses do not', async () => {
  const flaky = new TileStore({
    loadTile: async (src, z) => {
      if (z === 3) throw new Error('503');
      return store.loadTile(src, z, 0, 0);
    },
  });
  const s = new ChunkSampler(flaky);
  s.request(source, 10, 30, 3);
  await s.resolve();
  assert.equal(s.incomplete, true);
  const missing = new TileStore({
    loadTile: async (src, z) => (z === 3 ? null : store.loadTile(src, z, 0, 0)),
  });
  const s2 = new ChunkSampler(missing);
  s2.request(source, 10, 30, 3);
  await s2.resolve();
  assert.equal(s2.incomplete, false);
});
