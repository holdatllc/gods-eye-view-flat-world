import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolarAeqd, polarAeqd, wrapLongitude } from './aeqd.js';
import { createWorldFrame, DOMAIN_GPS, DOMAIN_ICE } from './domains.js';

const close = (actual, expected, tol, label) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} vs ${expected} (tol ${tol})`);

test('North Pole maps to the origin for every longitude', () => {
  for (const lon of [-180, -90, 0, 45, 179.999]) {
    const p = polarAeqd.forward(90, lon);
    close(Math.hypot(p.x, p.y), 0, 1e-6, `lon ${lon}`);
  }
});

test('quarter meridian and pole-to-pole radius match WGS84 reference values', () => {
  // GeographicLib: WGS84 quarter meridian = 10001965.729 m.
  close(polarAeqd.quarterMeridian, 10001965.7293, 1e-3, 'quarter meridian');
  close(polarAeqd.southPoleRadius, 20003931.4586, 2e-3, 'south pole radius');
});

test('prime meridian points down (−y) and +90° east points right (+x)', () => {
  const p0 = polarAeqd.forward(0, 0);
  close(p0.x, 0, 1e-6, 'x');
  assert.ok(p0.y < 0);
  const p90 = polarAeqd.forward(0, 90);
  assert.ok(p90.x > 0);
  close(p90.y, 0, 1e-6, 'y');
});

test('forward/inverse round trip is sub-nanodegree across the whole GPS domain', () => {
  let worst = 0;
  for (let lat = -90; lat <= 90; lat += 0.73) {
    for (let lon = -180; lon < 180; lon += 1.37) {
      const p = polarAeqd.forward(lat, lon);
      const g = polarAeqd.inverse(p.x, p.y);
      assert.equal(g.domain, 'gps');
      worst = Math.max(worst, Math.abs(g.lat - lat));
      if (Math.abs(lat) < 89.999999) {
        const dLon = Math.abs(wrapLongitude(g.lon - lon));
        worst = Math.max(worst, dLon);
      }
    }
  }
  assert.ok(worst < 1e-9, `worst ${worst}`);
});

test('antimeridian is continuous on the plane', () => {
  const a = polarAeqd.forward(10, 179.9999999);
  const b = polarAeqd.forward(10, -179.9999999);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 0.1);
  const g = polarAeqd.inverse(0, polarAeqd.forward(10, 180).rho);
  close(Math.abs(g.lon), 180, 1e-9, 'lon at +y');
});

test('beyond the South-Pole circle is the ice domain with no lat/lon', () => {
  const r = polarAeqd.southPoleRadius;
  const ice = polarAeqd.inverse(r + 10, 0);
  assert.equal(ice.domain, 'ice');
  assert.ok(Number.isNaN(ice.lat) && Number.isNaN(ice.lon));
  const rim = polarAeqd.inverse(0, -r);
  assert.equal(rim.domain, 'gps');
  close(rim.lat, -90, 1e-9, 'rim lat');
});

test('radial scale is exact: plane distance along a meridian equals meridian arc', () => {
  const p1 = polarAeqd.forward(40, 12);
  const p2 = polarAeqd.forward(50, 12);
  const arc = polarAeqd.meridianArc((50 * Math.PI) / 180) - polarAeqd.meridianArc((40 * Math.PI) / 180);
  close(Math.hypot(p1.x - p2.x, p1.y - p2.y), arc, 1e-6, 'arc');
});

test('invalid input never produces a position', () => {
  assert.ok(Number.isNaN(polarAeqd.forward(91, 0).x));
  assert.ok(Number.isNaN(polarAeqd.forward(NaN, 0).x));
  assert.equal(polarAeqd.inverse(NaN, 0).domain, 'invalid');
});

test('spherical ellipsoid reduces to rho = R(π/2 − φ)', () => {
  const R = 6371000;
  const sphere = createPolarAeqd({ ellipsoid: { a: R, f: 0 } });
  close(sphere.forward(30, 0).rho, R * (Math.PI / 2 - Math.PI / 6), 1e-6, 'rho');
});

test('world frame keeps GPS and ice domains separate and rotation is rigid', () => {
  const frame = createWorldFrame({ displayRotationDeg: 37 });
  const w = frame.geodeticToWorld(51.4779, -0.0015, 46);
  assert.equal(w.domain, DOMAIN_GPS);
  const back = frame.worldToDomain(w.x, w.y, w.z);
  close(back.lat, 51.4779, 1e-9, 'lat');
  close(back.lon, -0.0015, 1e-9, 'lon');
  assert.equal(back.height, 46);
  const ice = frame.worldToDomain(frame.boundaryRadius * 1.5, 0);
  assert.equal(ice.domain, DOMAIN_ICE);
  assert.equal(ice.lat, undefined);
  const base = createWorldFrame({ displayRotationDeg: 0 }).geodeticToWorld(51.4779, -0.0015);
  close(Math.hypot(w.x, w.y), Math.hypot(base.x, base.y), 1e-6, 'rho preserved');
});

test('audit D1: the real South Pole is GPS at every longitude and rotation', () => {
  for (const rot of [0, 90, 17.25, -123.456]) {
    const frame = createWorldFrame({ displayRotationDeg: rot });
    for (let lon = -180; lon < 180; lon += 0.5) {
      const w = frame.geodeticToWorld(-90, lon);
      const d = frame.worldToDomain(w.x, w.y);
      assert.equal(d.domain, DOMAIN_GPS, `lon ${lon} rot ${rot}`);
      close(d.lat, -90, 1e-9, 'lat');
    }
  }
});

test('audit D3/D4: scale factors at the poles and invalid latitudes', () => {
  assert.equal(polarAeqd.scaleFactors(90).k, 1);
  assert.equal(polarAeqd.scaleFactors(-90).k, Infinity);
  assert.ok(Number.isNaN(polarAeqd.scaleFactors(-100).k));
  assert.ok(Number.isNaN(polarAeqd.scaleFactors(100).k));
  close(polarAeqd.scaleFactors(0).k, Math.PI / 2, 0.01, 'equator k ≈ π/2');
});

test('audit D5/D6: one domain decision; NaN input is invalid', () => {
  const frame = createWorldFrame();
  for (const [x, y] of [
    [-19921603.250629287, -1813007.9221948634],
    [-19150153.61263818, -5781772.255440847],
    [-18797546.77837836, -6841747.504556272],
  ]) {
    const d = frame.worldToDomain(x, y);
    if (d.domain === DOMAIN_GPS) assert.ok(Number.isFinite(d.lat) && Number.isFinite(d.lon));
    assert.equal(frame.domainAt(x, y), d.domain);
  }
  assert.equal(frame.worldToDomain(NaN, 0).domain, 'invalid');
  assert.equal(frame.domainAt(0, NaN), 'invalid');
  assert.equal(frame.geodeticToWorld(10, 540).lon, -180);
});
