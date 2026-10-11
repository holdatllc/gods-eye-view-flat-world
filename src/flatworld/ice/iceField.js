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
  /** Peak relief of mountain ranges above the ice sheet. */
  mountainAmplitudeM: 3600,
  /** Base wavelength of mountain ridges. */
  mountainScaleM: 42000,
  /** Fraction of the ice that lies inside mountain ranges (0–1). */
  rangeCoverage: 0.45,
  swellAmplitudeM: 900,
  /** Depth of glacier valleys carved through the ranges. */
  glacierDepthM: 1500,
  glacierAmount: 0.75,
  /** Ice-cliff escarpments: strength and riser height. */
  cliffAmount: 0.6,
  cliffStepM: 320,
  crevasseDensity: 0.6,
  crevasseDepthM: 30,
  /** How much snow smooths the low ground between ranges. */
  snowFill: 0.5,
});

// ---------------------------------------------------------------------------------------------
// Seeded hashing and gradient noise (unbounded integer lattice; float64 inputs).

function hash2(ix, iy, seed) {
  let h =
    Math.imul(ix | 0, 0x27d4eb2d) ^
    Math.imul(iy | 0, 0x165667b1) ^
    Math.imul(seed | 0, 0x9e3779b9);
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
  return (
    1.4142 *
    ((n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v)
  );
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
    const ms = p.mountainScaleM;

    // Continental structure: broad swells and where the ranges are.
    const swell = p.swellAmplitudeM * fbm(x / 1.6e6, y / 1.6e6, s + 1, 4);
    const coverage = fbm(x / 3.5e5, y / 3.5e5, s + 5, 4);
    const edge = 0.5 - p.rangeCoverage; // fbm is roughly symmetric about 0
    const rangeMask = smoothstep(
      edge * 0.5 - 0.12,
      edge * 0.5 + 0.18,
      coverage,
    );

    // Domain-warped ridged multifractal: sharp arêtes and peaks.
    const wx = x / ms + 1.6 * fbm(x / (ms * 4.3), y / (ms * 4.3), s + 11, 3);
    const wy =
      y / ms + 1.6 * fbm(x / (ms * 3.9) + 40, y / (ms * 3.9) - 13, s + 23, 3);
    const ridges = ridged(wx, wy, s + 7, 8);
    const peaks = Math.pow(Math.min(1, ridges * 1.15), 1.7);
    const mountains = p.mountainAmplitudeM * Math.pow(rangeMask, 0.8) * peaks;

    // Glacier valleys: a coarser ridge network, inverted, carves U-shaped troughs through ranges.
    const gv = ridged(wx * 0.45 + 100, wy * 0.45 - 50, s + 13, 4);
    const valleyShape = smoothstep(0.5, 0.86, gv);
    const glacier = p.glacierAmount * valleyShape * (0.35 + 0.65 * rangeMask);
    const carve = p.glacierDepthM * glacier * (0.4 + 0.6 * peaks);

    // Ice-sheet surface: gentle undulation, plus metre-scale sastrugi.
    const sheet =
      140 * fbm(x / 22000, y / 22000, s + 31, 4) +
      1.6 * gradientNoise(x / 45, y / 120, s + 41);

    let h = p.rimHeightM + t * (swell + mountains - carve + sheet);

    // Escarpments: terraced ice cliffs where ranges meet the sheet.
    const cliffZone =
      p.cliffAmount *
      smoothstep(0.1, 0.5, rangeMask) *
      smoothstep(-0.1, 0.35, fbm(x / 80000, y / 80000, s + 17, 3));
    if (cliffZone > 0) {
      // Riser height and phase wander so escarpments read as broken ice cliffs, not strata.
      const step =
        p.cliffStepM * (1 + 0.45 * fbm(x / 30000, y / 30000, s + 19, 2));
      const offset = 0.5 * step * gradientNoise(x / 9000, y / 9000, s + 21);
      const q = (h - p.rimHeightM + offset) / step;
      const fl = Math.floor(q);
      const sharp = 0.8 + 0.12 * gradientNoise(x / 4000, y / 4000, s + 23);
      const terraced =
        p.rimHeightM - offset + (fl + smoothstep(sharp, 1, q - fl)) * step;
      h += t * cliffZone * (terraced - h);
    }

    // Snow fills sheltered low ground between ranges.
    const lowland = 1 - rangeMask;
    const snow = Math.min(1, p.snowFill * lowland + glacier * 0.3 + 0.4);

    // Crevasse fields where glaciers flow and around cliff edges, oriented across the flow.
    const crevasseZone =
      p.crevasseDensity > 0
        ? Math.max(glacier * 1.3, cliffZone * 0.8) *
          smoothstep(-0.2, 0.3, fbm(x / 15000, y / 15000, s + 29, 3))
        : 0;
    const crevasse = crevasseAt(x, y, crevasseZone);
    h -= t * crevasse * p.crevasseDepthM;

    const relief = Math.max(
      0,
      (mountains - carve) / Math.max(1, p.mountainAmplitudeM),
    );
    const rock =
      t *
      rangeMask *
      smoothstep(0.32, 0.62, relief) *
      smoothstep(0.3, 0.7, peaks);
    const blueIce = t * Math.min(1, glacier * 0.9 + cliffZone * 0.9);
    return {
      height: h,
      rock,
      blueIce,
      crevasse: t * crevasse,
      crevasseZone,
      snow,
      transition: t,
    };
  }

  /** Crevasse intensity (0–1) at a point, given the zone strength from `sample`. */
  function crevasseAt(x, y, zone) {
    if (!(zone > 0.05)) return 0;
    const ang = 2.4 * fbm(x / 60000, y / 60000, s + 33, 2);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const jitter = 0.35 * gradientNoise(x / 90, y / 90, s + 35);
    const u = (x * ca + y * sa) / 38 + jitter;
    const v = (-x * sa + y * ca) / 260;
    const { f1, f2 } = worley(u, v, s + 37);
    return (
      Math.min(1, zone) * p.crevasseDensity * smoothstep(0.11, 0.0, f2 - f1)
    );
  }

  return { params: p, sample, crevasseAt };
}

/** sRGB colour of an ice-domain surface sample (0–255 each), with a little deterministic grain. */
export function iceColor(sampleResult, x, y, slope, seed = 1892) {
  const { rock, blueIce, crevasse, snow } = sampleResult;
  const grain =
    0.035 * gradientNoise(x / 7.3, y / 7.3, seed + 99) +
    0.03 * gradientNoise(x / 61, y / 61, seed + 98);
  const drift = 0.05 * gradientNoise(x / 900, y / 2600, seed + 97); // wind-blown snow streaks
  // Fresh snow → wind-packed firn → polished blue ice → exposed rock → crevasse shadow.
  let r = 0.94 + grain + drift * 0.5;
  let g = 0.955 + grain + drift * 0.5;
  let b = 0.985 + grain * 0.6 + drift * 0.3;
  const firn = Math.max(0, 1 - snow) * 0.5;
  r -= 0.06 * firn;
  g -= 0.04 * firn;
  b -= 0.01 * firn;
  const steep = Math.min(1, Math.max(0, (slope - 0.45) / 0.4));
  const ice = Math.min(1, blueIce * 0.85 + steep * 0.55);
  r += (0.56 - r) * ice;
  g += (0.76 - g) * ice;
  b += (0.92 - b) * ice;
  const rk = Math.min(1, rock * (0.35 + 1.2 * steep));
  const rockTone = 0.2 + 0.08 * gradientNoise(x / 140, y / 140, seed + 96);
  r += (rockTone + 0.03 - r) * rk;
  g += (rockTone + 0.01 - g) * rk;
  b += (rockTone - b) * rk;
  r += (0.05 - r) * crevasse;
  g += (0.16 - g) * crevasse;
  b += (0.33 - b) * crevasse;
  const to8 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return [to8(r), to8(g), to8(b)];
}
