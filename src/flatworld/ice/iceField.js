/**
 * Deterministic procedural ice world for the hypothetical domain beyond the South-Pole circle.
 *
 * Every value is a pure function of (seed, params, local XY in metres), evaluated in float64, so
 * chunks generated in any order, on any worker, at any time produce identical, seamless edges.
 * Nothing here has, or produces, a latitude or longitude: the ice domain is not real geography.
 *
 * Features: continental swells, ridged mountain ranges with rock nunataks, glacier valleys that
 * flow outward, terraced ice cliffs, crevasse fields, snow-filled valleys and wind-scoured blue ice.
 */

export const DEFAULT_ICE_PARAMS = Object.freeze({
  seed: 1892,
  /** Height of the real surface at the South-Pole circle (ETOPO 2022 ice surface at 90°S, mean 2,832 m). */
  rimHeightM: 2832,
  /** Distance over which hypothetical relief fades in beyond the circle. */
  transitionM: 250000,
  mountainAmplitudeM: 4200,
  mountainScaleM: 180000,
  swellAmplitudeM: 1400,
  glacierDepthM: 900,
  glacierAmount: 0.65,
  cliffAmount: 0.55,
  cliffStepM: 140,
  crevasseDensity: 0.6,
  crevasseDepthM: 28,
  snowFill: 0.45,
});

// ---------------------------------------------------------------------------------------------
// Seeded hashing and gradient noise (unbounded integer lattice; float64 inputs).

function hash2(ix, iy, seed) {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function hashUnit(ix, iy, seed) {
  return hash2(ix, iy, seed) / 4294967296;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** 2D gradient noise in [-1, 1]. Lattice cells are split into integer + fraction in float64. */
export function gradientNoise(x, y, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const g = (cx, cy, dx, dy) => {
    const a = hashUnit(cx, cy, seed) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const n00 = g(ix, iy, fx, fy);
  const n10 = g(ix + 1, iy, fx - 1, fy);
  const n01 = g(ix, iy + 1, fx, fy - 1);
  const n11 = g(ix + 1, iy + 1, fx - 1, fy - 1);
  const u = fade(fx);
  const v = fade(fy);
  return 1.4142 * ((n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v);
}

function fbm(x, y, seed, octaves, lacunarity = 2.03, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i += 1) {
    sum += amp * gradientNoise(fx, fy, seed + i * 1013);
    norm += amp;
    amp *= gain;
    // Rotate each octave to hide lattice alignment.
    const rx = fx * 0.8 - fy * 0.6;
    const ry = fx * 0.6 + fy * 0.8;
    fx = rx * lacunarity + 17.13;
    fy = ry * lacunarity - 9.71;
  }
  return sum / norm;
}

function ridged(x, y, seed, octaves) {
  let sum = 0;
  let amp = 0.5;
  let weight = 1;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i += 1) {
    let n = 1 - Math.abs(gradientNoise(fx, fy, seed + i * 7919));
    n *= n;
    n *= weight;
    weight = Math.min(1, Math.max(0, n * 2));
    sum += n * amp;
    amp *= 0.5;
    const rx = fx * 0.8 - fy * 0.6;
    const ry = fx * 0.6 + fy * 0.8;
    fx = rx * 2.07 + 3.3;
    fy = ry * 2.07 - 5.1;
  }
  return sum; // ~[0, 1]
}

/** Cellular (Worley) F1/F2 distances in lattice units. */
function worley(x, y, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let f1 = 9;
  let f2 = 9;
  for (let j = -1; j <= 1; j += 1) {
    for (let i = -1; i <= 1; i += 1) {
      const cx = ix + i;
      const cy = iy + j;
      const px = cx + hashUnit(cx, cy, seed);
      const py = cy + hashUnit(cx, cy, seed + 31);
      const d = Math.hypot(px - x, py - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) f2 = d;
    }
  }
  return { f1, f2 };
}

const smoothstep = (a, b, t) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

// ---------------------------------------------------------------------------------------------

/**
 * Create a sampler for the ice domain.
 * @param {object} [overrides] parameters merged over DEFAULT_ICE_PARAMS
 * @param {{ boundaryRadius: number }} frame the world frame's South-Pole circle radius (metres)
 */
export function createIceField(overrides = {}, { boundaryRadius }) {
  const p = { ...DEFAULT_ICE_PARAMS, ...overrides };
  const s = p.seed | 0;

  /**
   * Height and surface attributes at local XY (metres, display frame).
   * Returns { height, rock, blueIce, crevasse, snow } with the material weights in [0, 1].
   */
  function sample(x, y) {
    const r = Math.hypot(x, y);
    const beyond = r - boundaryRadius;
    const t = smoothstep(0, p.transitionM, beyond);

    // Domain warp keeps ranges and glaciers from looking grid-aligned.
    const ms = p.mountainScaleM;
    const wx = x / ms + 2.2 * fbm(x / (ms * 3.1), y / (ms * 3.1), s + 11, 3);
    const wy = y / ms + 2.2 * fbm(x / (ms * 2.9) + 40, y / (ms * 2.9) - 13, s + 23, 3);

    const swell = p.swellAmplitudeM * fbm(x / 2.2e6, y / 2.2e6, s + 1, 4);
    const rangeMask = smoothstep(-0.15, 0.45, fbm(x / (ms * 6), y / (ms * 6), s + 5, 3));
    const mountains = p.mountainAmplitudeM * rangeMask * ridged(wx, wy, s + 7, 7);

    // Glaciers: negative ridges of a second warped field carve U-shaped valleys.
    const gv = ridged(wx * 0.7 + 100, wy * 0.7 - 50, s + 13, 4);
    const valley = Math.pow(Math.max(0, gv - 0.42) / 0.58, 1.6);
    const glacier = p.glacierAmount * valley;
    let h = p.rimHeightM + t * (swell + mountains - p.glacierDepthM * glacier);

    // Terraced ice cliffs on the flanks of ranges.
    const cliffMask = p.cliffAmount * rangeMask * smoothstep(0.1, 0.5, fbm(x / 60000, y / 60000, s + 17, 2) + 0.3);
    if (cliffMask > 0) {
      const step = p.cliffStepM;
      const q = h / step;
      const fl = Math.floor(q);
      const terraced = (fl + smoothstep(0.82, 1, q - fl)) * step;
      h += t * cliffMask * (terraced - h);
    }

    // Snow fills low, sheltered ground and softens it.
    const snowFill = p.snowFill * smoothstep(0.35, 0, rangeMask * ridged(wx, wy, s + 7, 3));
    h -= t * snowFill * 0.15 * mountains * 0.2;

    // Crevasse fields: narrow cellular cracks where glaciers flow.
    let crevasse = 0;
    if (p.crevasseDensity > 0) {
      const flow = smoothstep(0.05, 0.4, glacier + 0.25 * fbm(x / 9000, y / 9000, s + 29, 2));
      if (flow > 0) {
        // Stretch cells along the outward (flow) direction so cracks run across it.
        const ux = r > 0 ? x / r : 1;
        const uy = r > 0 ? y / r : 0;
        const along = (x * ux + y * uy) / 34;
        const across = (-x * uy + y * ux) / 140;
        const { f1, f2 } = worley(along, across, s + 37);
        const edge = f2 - f1;
        crevasse = flow * p.crevasseDensity * smoothstep(0.09, 0.0, edge);
        h -= t * crevasse * p.crevasseDepthM;
      }
    }

    const rock = t * rangeMask * smoothstep(0.55, 0.85, mountains / Math.max(1, p.mountainAmplitudeM));
    const blueIce = t * Math.min(1, cliffMask * 1.4 + glacier * 0.5);
    return {
      height: h,
      rock,
      blueIce,
      crevasse: t * crevasse,
      snow: Math.min(1, snowFill + 0.5),
      transition: t,
    };
  }

  return { params: p, sample };
}

/** sRGB colour of an ice-domain surface sample (0–255 each), with a little deterministic grain. */
export function iceColor(sampleResult, x, y, slope, seed = 1892) {
  const { rock, blueIce, crevasse } = sampleResult;
  const grain = 0.04 * gradientNoise(x / 7.3, y / 7.3, seed + 99) + 0.03 * gradientNoise(x / 61, y / 61, seed + 98);
  // Snow → wind-packed snow → blue ice → rock → crevasse shadow.
  let r = 0.93 + grain;
  let g = 0.95 + grain;
  let b = 0.99 + grain * 0.6;
  const steep = Math.min(1, Math.max(0, (slope - 0.35) / 0.5));
  const ice = Math.min(1, blueIce + steep * 0.6);
  r += (0.62 - r) * ice;
  g += (0.79 - g) * ice;
  b += (0.92 - b) * ice;
  const rk = Math.min(1, rock * (0.4 + steep));
  r += (0.27 - r) * rk;
  g += (0.26 - g) * rk;
  b += (0.27 - b) * rk;
  r += (0.08 - r) * crevasse;
  g += (0.2 - g) * crevasse;
  b += (0.36 - b) * crevasse;
  const to8 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return [to8(r), to8(g), to8(b)];
}
