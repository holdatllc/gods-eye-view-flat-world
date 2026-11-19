/**
 * The "dome" sky model, with the numbers stated in the TikTok video the owner supplied
 * (research/tiktok-sky/video.eng-US.vtt on the drive):
 *
 * - sun and moon about 3,000 miles above the plane, each about 32 miles across (Rowbotham /
 *   Flat Earth Society figures as the video quotes them);
 * - stars fixed to the dome about 3,100 miles up; the dome turns about Polaris, directly over the
 *   North Pole, once per sidereal day (about four minutes short of 24 hours);
 * - the sun circles the pole once a day over its real sub-solar point, so its circle is about
 *   4,600 miles from the pole in June (Tropic of Cancer) and about 7,800 miles in December
 *   (Tropic of Capricorn); the moon does the same over its real sub-lunar point;
 * - what an observer sees uses real astronomy; the light path from the dome sun to them has to
 *   curve, because a straight line from a 3,000-mile-high sun never drops below about 15° to 20°.
 *
 * Positions come from the real ephemeris; heights and sizes are the model's. Pure functions only,
 * so they can be tested without a renderer.
 */
export const MI = 1609.344;
export const SUN_HEIGHT_MI = 3000;
export const MOON_HEIGHT_MI = 3000;
export const STAR_DOME_MI = 3100;
export const BODY_DIAMETER_MI = 32;
/**
 * BUILD choice (the video gives only the 3,100-mile height): the dome stays at that height out to
 * this radius, past the moon's widest circle (about 8,200 miles), then curves down to meet the
 * ice wall at the rim, so the sun and moon are always inside it.
 */
export const DOME_FLAT_RADIUS_MI = 8400;
export const SIDEREAL_DAY_S = 86164.0905;

const DEG = Math.PI / 180;

/** Dome height (metres) above a point `rM` metres from the pole; 0 at and beyond the rim. */
export function domeHeightM(rM, rimM) {
  const h = STAR_DOME_MI * MI;
  const r0 = DOME_FLAT_RADIUS_MI * MI;
  if (rM <= r0) return h;
  if (rM >= rimM) return 0;
  const t = (rM - r0) / (rimM - r0);
  return h * Math.sqrt(Math.max(0, 1 - t * t));
}

/**
 * Elevation (degrees) of a point `heightM` up and `groundM` away along the plane, seen in a
 * straight line from an observer at `observerM` height.
 */
export function straightElevationDeg(heightM, groundM, observerM = 0) {
  return Math.atan2(heightM - observerM, Math.max(groundM, 1e-6)) / DEG;
}

/** Ground distance (metres) between two display-frame points. */
export function groundDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Lowest straight-line sun elevation for an observer `rObsM` from the pole, sun circle `rSunM`. */
export function lowestStraightSunDeg(
  rObsM,
  rSunM,
  sunHeightM = SUN_HEIGHT_MI * MI,
) {
  return straightElevationDeg(sunHeightM, rObsM + rSunM);
}

/**
 * The bent light path of the video: leaves the dome sun at `p0` and arrives at the observer `p3`
 * travelling along `-arrive` (unit vector from the observer toward where they really see the sun).
 * A cubic Bézier: the start heads straight for the observer, the end matches the real direction.
 * Points are [x, y, z] in three.js axes (y up). Returns `n + 1` points.
 */
export function bentRay(p0, p3, arrive, n = 48) {
  const d = Math.hypot(p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]);
  const k = d * 0.45;
  const p2 = [
    p3[0] + arrive[0] * k,
    p3[1] + arrive[1] * k,
    p3[2] + arrive[2] * k,
  ];
  const p1 = [
    p0[0] + (p2[0] - p0[0]) * 0.35,
    p0[1] + (p2[1] - p0[1]) * 0.35,
    p0[2] + (p2[2] - p0[2]) * 0.35,
  ];
  const out = [];
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    const a = (1 - t) ** 3;
    const b = 3 * (1 - t) ** 2 * t;
    const c = 3 * (1 - t) * t * t;
    const e = t ** 3;
    out.push([
      a * p0[0] + b * p1[0] + c * p2[0] + e * p3[0],
      a * p0[1] + b * p1[1] + c * p2[1] + e * p3[1],
      a * p0[2] + b * p1[2] + c * p2[2] + e * p3[2],
    ]);
  }
  return out;
}

/** Angle (degrees) between two direction vectors. */
export function angleBetweenDeg(a, b) {
  const la = Math.hypot(...a) || 1;
  const lb = Math.hypot(...b) || 1;
  const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
  return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
}
