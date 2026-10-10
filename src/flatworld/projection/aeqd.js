/**
 * North-polar azimuthal equidistant projection on the WGS84 ellipsoid.
 *
 * Equivalent to PROJ `+proj=aeqd +lat_0=90 +lon_0=0 +datum=WGS84 +units=m`.
 * In the polar aspect the ellipsoidal projection is exact and closed-form:
 *
 *   rho = M(90°) − M(φ)          (meridian arc length from the North Pole)
 *   x   =  rho · sin(λ − λ0)
 *   y   = −rho · cos(λ − λ0)
 *
 * M(φ) is evaluated with the rectifying-latitude series in the third flattening n
 * to O(n⁶); for WGS84 the truncation error is below 1e-9 m.
 *
 * This is projection geometry: it maps real geodetic coordinates onto a plane.
 * It does not change the measured shape of the Earth (see `nav/` for geodesics).
 */

export const WGS84 = Object.freeze({
  a: 6378137.0,
  f: 1 / 298.257223563,
});

const DEG = Math.PI / 180;

/**
 * One boundary rule for the whole flat world: a plane point belongs to the ice domain only when it
 * lies more than this distance beyond the South-Pole circle. Points within it are the South Pole
 * itself (floating-point rounding of rho = M(90°) − M(−90°) after sin/cos can exceed the exact
 * radius by an ulp; see program/evidence/B-aeqd-audit.md, defects D1/D2).
 */
export const BOUNDARY_TOLERANCE_M = 1e-6;

function ellipsoidConstants({ a, f }) {
  const n = f / (2 - f);
  const n2 = n * n;
  const n3 = n2 * n;
  const n4 = n3 * n;
  const n5 = n4 * n;
  const n6 = n5 * n;
  // Rectifying radius A, so that M(φ) = A · μ(φ).
  const A = (a / (1 + n)) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
  // μ(φ) = φ + Σ c_k sin(2kφ)
  const c = [
    0,
    (-3 / 2) * n + (9 / 16) * n3 - (3 / 32) * n5,
    (15 / 16) * n2 - (15 / 32) * n4 + (135 / 2048) * n6,
    (-35 / 48) * n3 + (105 / 256) * n5,
    (315 / 512) * n4 - (189 / 512) * n6,
    (-693 / 1280) * n5,
    (1001 / 2048) * n6,
  ];
  // φ(μ) = μ + Σ d_k sin(2kμ)
  const d = [
    0,
    (3 / 2) * n - (27 / 32) * n3 + (269 / 512) * n5,
    (21 / 16) * n2 - (55 / 32) * n4 + (6759 / 4096) * n6,
    (151 / 96) * n3 - (417 / 128) * n5,
    (1097 / 512) * n4 - (15543 / 2560) * n6,
    (8011 / 2560) * n5,
    (293393 / 61440) * n6,
  ];
  const quarterMeridian = A * (Math.PI / 2);
  return { A, c, d, quarterMeridian };
}

function trigSeries(angle, coefficients) {
  let sum = angle;
  for (let k = 1; k < coefficients.length; k += 1) {
    sum += coefficients[k] * Math.sin(2 * k * angle);
  }
  return sum;
}

/** Wrap a longitude in degrees into [-180, 180). */
export function wrapLongitude(lon) {
  if (!Number.isFinite(lon)) return NaN;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return wrapped;
}

/**
 * Create a projection instance.
 * @param {{ ellipsoid?: {a:number,f:number}, lon0?: number }} [options]
 */
export function createPolarAeqd({ ellipsoid = WGS84, lon0 = 0 } = {}) {
  const { A, c, d, quarterMeridian } = ellipsoidConstants(ellipsoid);
  /** Distance along the plane from the North Pole to the South Pole (the GPS-domain radius). */
  const southPoleRadius = 2 * quarterMeridian;
  const lam0 = lon0 * DEG;

  /** Meridian arc length from the equator to latitude φ (radians), metres. */
  function meridianArc(phi) {
    return A * trigSeries(phi, c);
  }

  /** Latitude (radians) whose meridian arc from the equator is m metres. */
  function inverseMeridianArc(m) {
    return trigSeries(m / A, d);
  }

  /**
   * Geodetic → plane. lat/lon in degrees; returns metres.
   * The North Pole maps to (0,0); every longitude at the South Pole maps onto the rim circle.
   */
  function forward(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90) {
      return { x: NaN, y: NaN, rho: NaN };
    }
    const rho = quarterMeridian - meridianArc(lat * DEG);
    const lam = lon * DEG - lam0;
    // At the North Pole rho is 0, so longitude does not matter (no singularity).
    return { x: rho * Math.sin(lam), y: -rho * Math.cos(lam), rho };
  }

  /**
   * Plane → geodetic. Returns degrees, or `domain: 'ice'` (and NaN lat/lon) beyond the
   * South-Pole circle, which belongs to the hypothetical ice domain and has no GPS position.
   * At the North Pole the longitude is defined as lon0 (any longitude is valid there).
   */
  function isBeyondSouthPole(rho) {
    return rho > southPoleRadius + BOUNDARY_TOLERANCE_M;
  }

  function inverse(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { lat: NaN, lon: NaN, domain: 'invalid' };
    }
    const rho = Math.hypot(x, y);
    if (isBeyondSouthPole(rho)) {
      return { lat: NaN, lon: NaN, domain: 'ice', rho };
    }
    const r = Math.min(rho, southPoleRadius);
    const phi = inverseMeridianArc(quarterMeridian - r);
    const lam = rho === 0 ? 0 : Math.atan2(x, -y);
    const lat = Math.max(-90, Math.min(90, phi / DEG));
    return { lat, lon: wrapLongitude(lam / DEG + lon0), domain: 'gps', rho };
  }

  /**
   * Scale factors at latitude φ (degrees). Radial (along meridians) is exactly 1.
   * Tangential (along parallels) is rho / (N cos φ); it is infinite at the South Pole.
   */
  function scaleFactors(lat) {
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { h: NaN, k: NaN, arealDistortion: NaN };
    // The projection is true to scale at its centre; near it rho is a difference of two nearly
    // equal arcs, so use the limit there.
    if (lat >= 90 - 1e-7) return { h: 1, k: 1, arealDistortion: 1 };
    if (lat <= -90) return { h: 1, k: Infinity, arealDistortion: Infinity };
    const phi = lat * DEG;
    const { a, f } = ellipsoid;
    const e2 = f * (2 - f);
    const sin = Math.sin(phi);
    const N = a / Math.sqrt(1 - e2 * sin * sin);
    const parallelRadius = N * Math.cos(phi);
    const rho = quarterMeridian - meridianArc(phi);
    const k = rho / parallelRadius;
    return { h: 1, k, arealDistortion: k };
  }

  return Object.freeze({
    ellipsoid,
    lon0,
    rectifyingRadius: A,
    quarterMeridian,
    southPoleRadius,
    meridianArc,
    inverseMeridianArc,
    isBeyondSouthPole,
    forward,
    inverse,
    scaleFactors,
    proj4: `+proj=aeqd +lat_0=90 +lon_0=${lon0} +datum=WGS84 +units=m +no_defs`,
  });
}

/** Shared default instance (WGS84, lon0 = 0). */
export const polarAeqd = createPolarAeqd();
