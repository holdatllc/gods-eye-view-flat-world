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
 * The geodesic's image on the flat map, adaptively subdivided so every drawn chord is short in
 * map space (near the South-Pole circle a few kilometres on the ground can span thousands of
 * kilometres of map). A geodesic through (or within metres of) the South Pole is split there:
 * the pole is the whole rim, so its image is two separate pieces and has no single length.
 */
export function geodesicImage(
  frame,
  a,
  b,
  { baseSamples = 256, flatM = 0, maxPoints = 40000 } = {},
) {
  const line = WGS84.InverseLine(a.lat, a.lon, b.lat, b.lon);
  const total = line.s13;
  const maxSeg = Math.max(2000, Math.min(50000, flatM / 300));
  const at = (sDist) => {
    const p = line.Position(sDist);
    const w = frame.geodeticToWorld(p.lat2, p.lon2);
    return { x: w.x, y: w.y, lat: p.lat2, s: sDist };
  };
  const segments = [[]];
  let crossesSouthPole = false;
  let count = 0;
  const emit = (p) => {
    segments[segments.length - 1].push(p);
    count += 1;
  };
  const refine = (p0, p1, depth) => {
    const gap = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    if (gap <= maxSeg || count > maxPoints) {
      emit(p1);
      return;
    }
    if (depth >= 40 || p1.s - p0.s < 0.01) {
      // Unresolvable jump: only possible across the South Pole, which maps to the whole rim.
      crossesSouthPole = true;
      segments.push([p1]);
      count += 1;
      return;
    }
    const mid = at((p0.s + p1.s) / 2);
    refine(p0, mid, depth + 1);
    refine(mid, p1, depth + 1);
  };
  let prev = at(0);
  emit(prev);
  for (let i = 1; i <= baseSamples; i += 1) {
    const next = at((total * i) / baseSamples);
    refine(prev, next, 0);
    prev = next;
  }
  let lengthM = 0;
  for (const seg of segments)
    for (let i = 1; i < seg.length; i += 1)
      lengthM += Math.hypot(seg[i].x - seg[i - 1].x, seg[i].y - seg[i - 1].y);
  return {
    points: segments.flat(),
    segments: segments.filter((seg) => seg.length > 1),
    lengthM,
    crossesSouthPole,
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
  const image = geodesicImage(frame, d1, d2, { baseSamples: samples, flatM });
  g.plane = image.points;
  g.segments = image.segments;
  g.crossesSouthPole = image.crossesSouthPole;
  g.lengthOnMapM = image.crossesSouthPole ? NaN : image.lengthM;
  result.geodesic = g;

  // True ground length of the map-straight chord: invert samples along it and add geodesic
  // segment lengths between consecutive real positions.
  let ground = 0;
  let prev = d1;
  const pts = [];
  for (let i = 1; i <= samples; i += 1) {
    const t = i / samples;
    const q = frame.worldToDomain(
      p1.x + (p2.x - p1.x) * t,
      p1.y + (p2.y - p1.y) * t,
    );
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
