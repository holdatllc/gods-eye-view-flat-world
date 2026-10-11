// Time full-size ice chunk builds (grid 64, texture 256) — CPU cost per worker.
import {
  createChunkBuilder,
  ROOT_TILE_SIZE,
} from '../../src/flatworld/terrain/chunkBuilder.js';
import { TileStore } from '../../src/flatworld/sources/sampler.js';
const b = createChunkBuilder({
  store: new TileStore({ loadTile: async () => null }),
});
const R = b.frame.boundaryRadius;
const times = [];
for (let i = 0; i < 12; i++) {
  const level = 10 + (i % 6);
  const size = ROOT_TILE_SIZE / 2 ** level;
  const x = R + 1e6 + i * 7e5,
    y = -3e5 * i;
  const t0 = performance.now();
  await b.build({
    level,
    tx: Math.floor((x + ROOT_TILE_SIZE / 2) / size),
    ty: Math.floor((y + ROOT_TILE_SIZE / 2) / size),
  });
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
console.log(
  'ice chunk build ms: median',
  times[6].toFixed(0),
  'max',
  times.at(-1).toFixed(0),
);
