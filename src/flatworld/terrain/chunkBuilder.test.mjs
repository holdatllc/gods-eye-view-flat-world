import test from 'node:test';
import assert from 'node:assert/strict';
import { createChunkBuilder, tileBounds, chunkIndices, ROOT_TILE_SIZE } from './chunkBuilder.js';
import { TileStore } from '../sources/sampler.js';

// A fake source: flat 100 m elevation everywhere, no imagery.
const store = new TileStore({
  loadTile: async (source) =>
    source.format === 'terrarium'
      ? { width: 4, height: 4, heights: new Float32Array(16).fill(100) }
      : null,
});
const builder = createChunkBuilder({ store });
const R = builder.frame.boundaryRadius;

function tileAt(level, x, y) {
  const size = ROOT_TILE_SIZE / 2 ** level;
  return {
    level,
    tx: Math.floor((x + ROOT_TILE_SIZE / 2) / size),
    ty: Math.floor((y + ROOT_TILE_SIZE / 2) / size),
  };
}

test('root tile 0/0/0 covers the whole GPS disc', () => {
  const b = tileBounds(0, 0, 0);
  assert.ok(b.x0 < -R && b.x1 > R && b.y0 < -R && b.y1 > R);
});

test('a GPS chunk samples real elevation and is classified gps', async () => {
  const t = tileAt(12, 1000000, 2000000);
  const c = await builder.build({ ...t, grid: 8, texSize: 16 });
  assert.equal(c.domainMix, 'gps');
  assert.ok(Math.abs(c.maxH - 100) < 1e-6);
  assert.equal(c.domain.every((d) => d === 0), true);
});

test('an ice chunk never carries geodetic up-vectors and is deterministic', async () => {
  const t = tileAt(10, R + 600000, 0);
  const a = await builder.build({ ...t, grid: 8, texSize: 16 });
  const b = await builder.build({ ...t, grid: 8, texSize: 16 });
  assert.equal(a.domainMix, 'ice');
  assert.deepEqual(a.position, b.position);
  assert.deepEqual(a.rgba, b.rgba);
  for (let i = 0; i < a.domain.length; i += 1) assert.equal(a.domain[i], 1);
});

test('adjacent ice chunks share identical edge heights (seamless)', async () => {
  const t = tileAt(11, R + 900000, 300000);
  const left = await builder.build({ ...t, grid: 8, texSize: 8 });
  const right = await builder.build({ ...t, tx: t.tx + 1, grid: 8, texSize: 8 });
  const G = 8;
  for (let j = 0; j <= G; j += 1) {
    const hl = left.position[(j * (G + 1) + G) * 3 + 1];
    const hr = right.position[(j * (G + 1)) * 3 + 1];
    assert.equal(hl, hr, `row ${j}`);
  }
});

test('a chunk straddling the South-Pole circle is mixed', async () => {
  const t = tileAt(9, R, 0);
  const c = await builder.build({ ...t, grid: 8, texSize: 32 });
  assert.equal(c.domainMix, 'mixed');
});

test('shared index buffer stays inside the vertex range', () => {
  const G = 8;
  const idx = chunkIndices(G);
  const vertices = (G + 1) ** 2 + 4 * G;
  assert.ok(idx.every((i) => i < vertices));
  assert.equal(idx.length, G * G * 6 + 4 * G * 6);
});
