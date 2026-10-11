/**
 * Ice wall model: deterministic height around the rim, low inlets, and the visibility exaggeration.
 * Pure functions (no three.js) so they are unit-tested and reproducible. Everything here is a
 * HYPOTHETICAL model feature; the heights are a design choice informed by the cited sources.
 */

export const WALL = Object.freeze({
  seed: 7919,
  baselineM: 50,
  minM: 20,
  maxM: 85,
  hardCapM: 100,
  inletFloorM: 3,
  inletCells: 56,
  inletChance: 0.34,
  /** True scale up to this camera distance; beyond it the height is exaggerated. */
  trueScaleUntilM: 2000,
  exaggerationStepM: 2000,
  maxExaggeration: 12000,
});

/** Source heights shown in the UI (metres). */
export const WALL_SOURCES = Object.freeze([
  { label: 'Ross 1841', text: 'a perpendicular cliff of ice, 150 to 200 feet above the sea', metres: [46, 61] },
  { label: 'Modern Ross Ice Shelf front', text: '15 to 50 m', metres: [15, 50] },
  { label: 'Iceberg freeboard (Romanov et al. 2012)', text: 'averages 41 m', metres: [41, 41] },
  { label: 'Shackleton 1908', text: 'over 250 feet', metres: [76, 76] },
  { label: 'Scott 1902', text: '280 feet', metres: [85, 85] },
  { label: 'Physical limit of a floating ice cliff', text: 'about 100 m', metres: [100, 100] },
]);

function hash1(i, seed) {
  let h = (Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);

/** Periodic value noise on a ring: u in [0,1), cells wrap, result in [-1, 1]. */
function ringNoise(u, cells, seed) {
  const x = (((u % 1) + 1) % 1) * cells;
  const i = Math.floor(x);
  const f = smooth(x - i);
  const a = hash1(i % cells, seed);
  const b = hash1((i + 1) % cells, seed);
  return (a + (b - a) * f) * 2 - 1;
}

function baseHeight(u) {
  const n =
    0.5 * ringNoise(u, 9, WALL.seed + 1) +
    0.3 * ringNoise(u, 31, WALL.seed + 2) +
    0.14 * ringNoise(u, 117, WALL.seed + 3) +
    0.06 * ringNoise(u, 523, WALL.seed + 4);
  // n is roughly in [-0.8, 0.8]; centre on the baseline, and stretch so most of 20..85 is used.
  const h = WALL.baselineM + n * 52;
  return Math.min(WALL.maxM, Math.max(WALL.minM, h));
}

/**
 * Inlet weight in [0,1] at u (1 = bottom of an inlet). Inlets live in a hashed lattice so their
 * count and widths do not depend on how finely the wall is sampled.
 */
export function inletWeight(u, circumferenceM) {
  const cells = WALL.inletCells;
  const x = (((u % 1) + 1) % 1) * cells;
  const c = Math.floor(x);
  let w = 0;
  for (let k = -1; k <= 1; k++) {
    const ci = (((c + k) % cells) + cells) % cells;
    if (hash1(ci, WALL.seed + 21) > WALL.inletChance) continue;
    const frac = 0.15 + 0.7 * hash1(ci, WALL.seed + 22);
    const d = Math.abs(x - ((c + k) + frac));
    const halfM = 6000 + 8000 * hash1(ci, WALL.seed + 23);
    const dM = (d / cells) * circumferenceM;
    const t = Math.max(0, 1 - dM / halfM);
    w = Math.max(w, smooth(Math.min(1, t * 1.6)));
  }
  return w;
}

/** True wall height in metres at u in [0,1) around the rim. */
export function wallHeightM(u, circumferenceM) {
  const w = inletWeight(u, circumferenceM);
  const h = baseHeight(u) * (1 - w) + (WALL.inletFloorM + 2 * hash1(Math.floor(u * 4096), WALL.seed + 5)) * w;
  return Math.min(WALL.hardCapM, h);
}

/** Vertical exaggeration for a camera at distanceM from the nearest wall point. */
export function wallExaggeration(distanceM) {
  if (!(distanceM > WALL.trueScaleUntilM)) return 1;
  const e = 1 + (distanceM - WALL.trueScaleUntilM) / WALL.exaggerationStepM;
  return Math.min(WALL.maxExaggeration, e);
}

/** On-screen label text, or null when the wall is at true scale. */
export function wallLabel(exaggeration) {
  const n = Math.round(exaggeration);
  if (exaggeration < 1.5) {
    return 'Ice wall: hypothetical model feature, shown at true height (about 50 m)';
  }
  return `Ice wall: hypothetical model feature. Height x${n.toLocaleString('en-US')} for visibility; true height about 50 m`;
}
