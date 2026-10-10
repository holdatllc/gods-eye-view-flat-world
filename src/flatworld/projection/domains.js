/**
 * The two geographic domains of the flat world, and the display frame.
 *
 * - `gps`: points inside the South-Pole circle. They come from real geodetic coordinates
 *   (WGS84 lat/lon, height) through the verified polar AEQD projection, and invert back to them.
 * - `ice`: points outside the South-Pole circle. They are hypothetical, procedurally generated
 *   terrain with their own stable local XY (metres in the display frame). They never carry
 *   latitude/longitude and are never presented as observations.
 *
 * Display frame: projection metres rotated by `displayRotationDeg` (counter-clockwise) so the
 * layout matches the Gleason 1892 reference. Rotation is a pure 2D rigid motion, so distances
 * and the domain boundary are unchanged.
 */
import { polarAeqd, wrapLongitude } from './aeqd.js';

export const DOMAIN_GPS = 'gps';
export const DOMAIN_ICE = 'ice';

/**
 * Rotation that maps the standard north-polar AEQD (prime meridian pointing down, east to the
 * right) onto the Gleason layout. Measured from the full-resolution scan; see
 * program/evidence/gleason.md (fitted 89.7° ± 0.5° from the 24 printed meridians; Greenwich
 * points right, 90°E up, no mirroring).
 */
export const GLEASON_DISPLAY_ROTATION_DEG = 90;

export function createWorldFrame({
  projection = polarAeqd,
  displayRotationDeg = GLEASON_DISPLAY_ROTATION_DEG,
} = {}) {
  let rotation = (displayRotationDeg * Math.PI) / 180;
  let cos = Math.cos(rotation);
  let sin = Math.sin(rotation);
  const boundary = projection.southPoleRadius;

  function setDisplayRotation(degrees) {
    rotation = (degrees * Math.PI) / 180;
    cos = Math.cos(rotation);
    sin = Math.sin(rotation);
  }

  function toDisplay(px, py) {
    return { x: px * cos - py * sin, y: px * sin + py * cos };
  }

  function fromDisplay(dx, dy) {
    return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
  }

  /** Real geodetic position → display-frame position (height passes through unchanged). */
  function geodeticToWorld(lat, lon, height = 0) {
    const p = projection.forward(lat, lon);
    if (!Number.isFinite(p.x)) return null;
    const d = toDisplay(p.x, p.y);
    return { domain: DOMAIN_GPS, x: d.x, y: d.y, z: height, lat, lon: wrapLongitude(lon), height };
  }

  /**
   * Display-frame position → the domain it belongs to. GPS points get their exact geodetic
   * inverse; ice points get only their local XY.
   */
  function worldToDomain(x, y, z = 0) {
    // Decide once, in projection coordinates, with the same radius `inverse` uses (audit D5).
    const p = fromDisplay(x, y);
    const g = projection.inverse(p.x, p.y);
    if (g.domain === 'invalid') return { domain: 'invalid' };
    if (g.domain === DOMAIN_ICE) {
      return { domain: DOMAIN_ICE, iceX: x, iceY: y, z, distanceBeyondPole: g.rho - boundary };
    }
    return { domain: DOMAIN_GPS, lat: g.lat, lon: g.lon, height: z, x, y };
  }

  function domainAt(x, y) {
    const p = fromDisplay(x, y);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return 'invalid';
    return projection.isBeyondSouthPole(Math.hypot(p.x, p.y)) ? DOMAIN_ICE : DOMAIN_GPS;
  }

  return {
    projection,
    boundaryRadius: boundary,
    get displayRotationDeg() {
      return (rotation * 180) / Math.PI;
    },
    setDisplayRotation,
    toDisplay,
    fromDisplay,
    geodeticToWorld,
    worldToDomain,
    domainAt,
  };
}
