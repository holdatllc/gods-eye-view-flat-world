// Builds a set of ice-domain chunks (no network: ice needs no source tiles) and prints a SHA-256
// per chunk. Run twice (separate processes) and compare: identical output proves determinism.
import { createHash } from 'node:crypto';
import {
  createChunkBuilder,
  ROOT_TILE_SIZE,
} from '../../src/flatworld/terrain/chunkBuilder.js';
import { TileStore } from '../../src/flatworld/sources/sampler.js';

const store = new TileStore({ loadTile: async () => null });
const b = createChunkBuilder({ store });
const R = b.frame.boundaryRadius;
const tileAt = (level, x, y) => {
  const size = ROOT_TILE_SIZE / 2 ** level;
  return {
    level,
    tx: Math.floor((x + ROOT_TILE_SIZE / 2) / size),
    ty: Math.floor((y + ROOT_TILE_SIZE / 2) / size),
  };
};
const spots = [
  [8, R + 3e5, 0],
  [12, R + 9e5, -4e5],
  [15, -(R + 2e6), 1e6],
  [17, 3e7, -9e7],
  [14, 5e8, 2e8],
  [19, -1.2e9, 7e8],
];
for (const [level, x, y] of spots) {
  const t = tileAt(level, x, y);
  const c = await b.build({ ...t, grid: 32, texSize: 64 });
  const h = createHash('sha256');
  h.update(Buffer.from(c.position.buffer));
  h.update(Buffer.from(c.rgba.buffer));
  console.log(
    `${level}/${t.tx}/${t.ty} ${c.domainMix} h=[${c.minH.toFixed(1)},${c.maxH.toFixed(1)}] ${h.digest('hex').slice(0, 16)}`,
  );
}
