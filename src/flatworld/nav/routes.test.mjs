import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { compareRoutes, geodesicRoute } from './routes.js';
import { createWorldFrame, DOMAIN_ICE } from '../projection/domains.js';

// Produced independently by the Coordinate Auditor (PROJ 9.8.1 + GeographicLib); see program/evidence.
const REF = new URL('./fixtures/reference-routes.json', import.meta.url);

test(
  'geodesic and flat distances match the independent auditor reference (PROJ + GeographicLib)',
  { skip: !existsSync(REF) },
  () => {
    const ref = JSON.parse(readFileSync(REF, 'utf8'));
    const routes = Array.isArray(ref) ? ref : ref.routes;
    const frame = createWorldFrame({ displayRotationDeg: 90 });
    for (const r of routes) {
      const a = frame.geodeticToWorld(r.from.lat, r.from.lon);
      const b = frame.geodeticToWorld(r.to.lat, r.to.lon);
      const c = compareRoutes(frame, a, b, { samples: 64 });
      assert.ok(
        Math.abs(c.geodesic.distanceM - r.geodesic_m) < 1e-3,
        `${r.from.name} geodesic`,
      );
      assert.ok(
        Math.abs(c.flat.distanceM - r.plane_straight_line_m) < 1e-3,
        `${r.from.name} flat`,
      );
    }
  },
);

test('London–New York: the map-straight line is longer than the geodesic', () => {
  const frame = createWorldFrame();
  const a = frame.geodeticToWorld(51.5074, -0.1278);
  const b = frame.geodeticToWorld(40.7128, -74.006);
  const c = compareRoutes(frame, a, b);
  assert.ok(c.geodesic.distanceM > 5.58e6 && c.geodesic.distanceM < 5.59e6);
  assert.ok(c.flat.distanceM > c.geodesic.distanceM);
  assert.ok(c.flatPathOnEarth.groundLengthM >= c.geodesic.distanceM);
});

test('meridian routes: flat distance equals geodesic (radial scale is exact)', () => {
  const frame = createWorldFrame();
  const a = frame.geodeticToWorld(10, 25);
  const b = frame.geodeticToWorld(70, 25);
  const c = compareRoutes(frame, a, b);
  assert.ok(Math.abs(c.flat.distanceM - c.geodesic.distanceM) < 1e-3);
});

test('ice points have no geodesic', () => {
  const frame = createWorldFrame();
  const a = { x: frame.boundaryRadius + 1e5, y: 0 };
  const b = frame.geodeticToWorld(-60, 0);
  const c = compareRoutes(frame, a, b);
  assert.equal(c.geodesic, null);
  assert.equal(c.domains[0], DOMAIN_ICE);
  assert.ok(c.flat.distanceM > 0);
});

test('geodesicRoute samples start and end at the endpoints', () => {
  const g = geodesicRoute(
    { lat: 0, lon: 0 },
    { lat: 0, lon: 90 },
    { samples: 10 },
  );
  assert.equal(g.points.length, 11);
  assert.ok(Math.abs(g.points[10].lon - 90) < 1e-9);
});
