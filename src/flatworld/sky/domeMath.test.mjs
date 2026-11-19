import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldFrame } from '../projection/domains.js';
import {
  MI,
  STAR_DOME_MI,
  SUN_HEIGHT_MI,
  bentRay,
  angleBetweenDeg,
  domeHeightM,
  lowestStraightSunDeg,
  straightElevationDeg,
} from './domeMath.js';
import { initialSkyModel, SKY_MODELS } from './skyModels.js';

const frame = createWorldFrame();
const near = (a, b, tol, label) =>
  assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} vs ${b} (tol ${tol})`);
const radiusAt = (lat) => {
  const w = frame.geodeticToWorld(lat, -74, 0);
  return Math.hypot(w.x, w.y);
};

test("the video's distances: New York, the tropics, the rim", () => {
  near(
    radiusAt(40.71) / MI,
    3400,
    20,
    'New York from the pole (video: about 3,400 mi)',
  );
  near(radiusAt(23.44) / MI, 4600, 20, 'June circle (video: about 4,600 mi)');
  near(
    radiusAt(-23.44) / MI,
    7800,
    50,
    'December circle (video: nearly 7,800 mi)',
  );
  near(
    frame.boundaryRadius / MI,
    12430,
    20,
    'pole to rim (video: roughly 12,000 mi)',
  );
});

test('straight lines from a 3,000-mile sun never set from New York (video: 15° to 20°)', () => {
  const ny = radiusAt(40.71);
  const june = lowestStraightSunDeg(ny, radiusAt(23.44));
  const dec = lowestStraightSunDeg(ny, radiusAt(-23.44));
  near(june, 20.5, 0.5, 'June lowest');
  near(dec, 15, 0.5, 'December lowest');
  // Polaris straight overhead the pole on a 3,100-mile dome (video: about 41° from New York).
  near(straightElevationDeg(STAR_DOME_MI * MI, ny), 42.3, 0.3, 'Polaris');
});

test('dome: flat at 3,100 mi over the sun and moon circles, meets the rim at 0', () => {
  const rim = frame.boundaryRadius;
  assert.equal(domeHeightM(0, rim), STAR_DOME_MI * MI);
  assert.equal(domeHeightM(radiusAt(-28.7), rim), STAR_DOME_MI * MI);
  assert.ok(domeHeightM(radiusAt(-28.7), rim) > SUN_HEIGHT_MI * MI);
  assert.equal(domeHeightM(rim, rim), 0);
  const mid = domeHeightM((rim + 8400 * MI) / 2, rim);
  assert.ok(mid > 0 && mid < STAR_DOME_MI * MI);
});

test('bent ray starts at the sun and arrives along the real direction', () => {
  const p0 = [1e6, 4.8e6, 0];
  const p3 = [0, 0, 0];
  const arrive = [Math.cos(0.1), Math.sin(0.1), 0];
  const pts = bentRay(p0, p3, arrive, 512);
  assert.deepEqual(pts[0], p0);
  assert.deepEqual(pts.at(-1), p3);
  const last = pts.at(-2);
  near(angleBetweenDeg(last, arrive), 0, 1, 'arrival direction');
  assert.ok(
    pts.every((p) => p[1] >= -1),
    'never below the ground',
  );
});

test('sky model choice: URL first, then default original', () => {
  assert.equal(initialSkyModel('?sky=dome'), 'dome');
  assert.equal(initialSkyModel('?sky=spec'), 'spec');
  assert.equal(initialSkyModel('?sky=nope'), 'original');
  assert.deepEqual(
    SKY_MODELS.map((m) => m.id),
    ['original', 'spec', 'dome'],
  );
});
