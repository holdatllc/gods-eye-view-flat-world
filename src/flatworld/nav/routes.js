/**
 * Two independent route calculations between two points:
 *
 * 1. Real-world geodesic (shortest path on the WGS84 ellipsoid), computed with GeographicLib
 *    (Karney's algorithms, accurate to nanometres). This is the true travel distance.
 * 2. Flat-map straight line: the shortest path across the projected disc (a straight chord in the
 *    display plane), its length in map metres, and — for comparison — the true ground length of
 *    following that map-straight line on the real Earth.
 *
 * Points in the hypothetical ice domain have no geodetic position, so only the flat measurement
 * exists for them and the geodesic is reported as not applicable.
 */
import geographiclib from 'geographiclib-geodesic';
import { DOMAIN_GPS, DOMAIN_ICE } from '../projection/domains.js';

const { Geodesic } = geographiclib;
const WGS84 = Geodesic.WGS84;

/** Geodesic between two geodetic points, sampled for drawing. */
export function geodesicRoute(a, b, { samples = 256 } = {}) {
  const inv = WGS84.Inverse(a.lat, a.lon, b.lat, b.lon);
  const line = WGS84.InverseLine(a.lat, a.lon, b.lat, b.lon);
  const points = [];
  for (let i = 0; i <= samples; i += 1) {
    const p = line.Position((line.s13 * i) / samples);
    points.push({ lat: p.lat2, lon: p.lon2 });
  }
  return {
    distanceM: inv.s12,
    initialAzimuthDeg: inv.azi1,
    finalAzimuthDeg: inv.azi2,
    points,
  };
}

/**
 * Compare a pair of world-frame points (each { x, y } in the display frame).
 * @param {ReturnType<import('../projection/domains.js').createWorldFrame>} frame
 */
export function compareRoutes(frame, p1, p2, { samples = 256 } = {}) {
  const d1 = frame.worldToDomain(p1.x, p1.y);
  const d2 = frame.worldToDomain(p2.x, p2.y);
  const flatM = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const result = {
    from: d1,
    to: d2,
    flat: { distanceM: flatM, points: [p1, p2] },
    geodesic: null,
    flatPathOnEarth: null,
    domains: [d1.domain, d2.domain],
  };
  if (d1.domain !== DOMAIN_GPS || d2.domain !== DOMAIN_GPS) {
    result.note =
      d1.domain === DOMAIN_ICE && d2.domain === DOMAIN_ICE
        ? 'Both points are in the hypothetical ice domain: only the flat (local X/Y) distance exists.'
        : 'One point is in the hypothetical ice domain: no real-world geodesic exists; flat distance only.';
    return result;
  }
  const g = geodesicRoute(d1, d2, { samples });
  g.plane = g.points.map((p) => frame.geodeticToWorld(p.lat, p.lon));
  let geodesicDrawnLengthM = 0;
  for (let i = 1; i < g.plane.length; i += 1) {
    geodesicDrawnLengthM += Math.hypot(g.plane[i].x - g.plane[i - 1].x, g.plane[i].y - g.plane[i - 1].y);
  }
  g.lengthOnMapM = geodesicDrawnLengthM;
  result.geodesic = g;

  // True ground length of the map-straight chord: invert samples along it and add geodesic
  // segment lengths between consecutive real positions.
  let ground = 0;
  let prev = d1;
  const pts = [];
  for (let i = 1; i <= samples; i += 1) {
    const t = i / samples;
    const q = frame.worldToDomain(p1.x + (p2.x - p1.x) * t, p1.y + (p2.y - p1.y) * t);
    pts.push(q);
    ground += WGS84.Inverse(prev.lat, prev.lon, q.lat, q.lon).s12;
    prev = q;
  }
  result.flatPathOnEarth = { groundLengthM: ground, points: pts };
  result.comparison = {
    flatMinusGeodesicM: flatM - g.distanceM,
    flatOverGeodesic: flatM / g.distanceM,
    flatPathGroundOverGeodesic: ground / g.distanceM,
  };
  return result;
}
