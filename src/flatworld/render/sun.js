/**
 * Real sun direction (low-precision solar ephemeris, ~0.01°; Astronomical Almanac formulae) and
 * its local east/north/up components at a geodetic point.
 */
const DEG = Math.PI / 180;

/** Subsolar point (degrees) for a JS Date. */
export function subsolarPoint(date = new Date()) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * DEG;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  // Greenwich mean sidereal time (degrees).
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  let lon = ra / DEG - gmst;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { lat: decl / DEG, lon };
}

/** Unit vector to the sun in Earth-fixed (ECEF) axes. */
export function sunEcef(date = new Date()) {
  const s = subsolarPoint(date);
  const la = s.lat * DEG;
  const lo = s.lon * DEG;
  return [
    Math.cos(la) * Math.cos(lo),
    Math.cos(la) * Math.sin(lo),
    Math.sin(la),
  ];
}

/** Sun direction in local east/north/up at (lat, lon), plus elevation/azimuth in degrees. */
export function sunLocal(lat, lon, date = new Date()) {
  const [sx, sy, sz] = sunEcef(date);
  const la = lat * DEG;
  const lo = lon * DEG;
  const e = -Math.sin(lo) * sx + Math.cos(lo) * sy;
  const n =
    -Math.sin(la) * Math.cos(lo) * sx -
    Math.sin(la) * Math.sin(lo) * sy +
    Math.cos(la) * sz;
  const u =
    Math.cos(la) * Math.cos(lo) * sx +
    Math.cos(la) * Math.sin(lo) * sy +
    Math.sin(la) * sz;
  return {
    east: e,
    north: n,
    up: u,
    elevationDeg: Math.asin(Math.max(-1, Math.min(1, u))) / DEG,
    azimuthDeg: (Math.atan2(e, n) / DEG + 360) % 360,
  };
}
