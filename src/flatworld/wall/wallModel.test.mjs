import test from 'node:test';
import assert from 'node:assert/strict';
import { WALL, wallHeightM, inletWeight, wallExaggeration, wallLabel } from './wallModel.js';

const C = 2 * Math.PI * 20003.9e3;
const N = 33000;
const hs = Array.from({ length: N }, (_, i) => wallHeightM(i / N, C));

test('height is deterministic', () => {
  assert.equal(wallHeightM(0.123456, C), wallHeightM(0.123456, C));
});

test('never exceeds the hard cap and is periodic', () => {
  assert.ok(Math.max(...hs) <= WALL.hardCapM);
  assert.ok(Math.abs(wallHeightM(0, C) - wallHeightM(1 - 1e-12, C)) < 0.01);
});

test('away from inlets heights stay within 20..85 m and average near 50 m', () => {
  const open = hs.filter((_, i) => inletWeight(i / N, C) === 0);
  assert.ok(open.length > N * 0.8);
  assert.ok(Math.min(...open) >= WALL.minM - 1e-9);
  assert.ok(Math.max(...open) <= WALL.maxM + 1e-9);
  const mean = open.reduce((a, b) => a + b, 0) / open.length;
  assert.ok(mean > 42 && mean < 58, `mean ${mean}`);
  assert.ok(Math.max(...open) > 70 && Math.min(...open) < 30, 'uses the variation range');
});

test('inlets exist and drop to a few metres', () => {
  const low = hs.filter((h) => h < 10);
  assert.ok(low.length > 50 && low.length < N * 0.1, `${low.length}`);
  assert.ok(Math.min(...hs) >= WALL.inletFloorM - 1e-9);
});

test('exaggeration is 1 when near, grows with distance, and is capped', () => {
  assert.equal(wallExaggeration(500), 1);
  assert.equal(wallExaggeration(2000), 1);
  assert.ok(wallExaggeration(100e3) > wallExaggeration(10e3));
  assert.equal(wallExaggeration(1e12), WALL.maxExaggeration);
});

test('label states exaggeration and the true height', () => {
  assert.match(wallLabel(250), /x250 for visibility; true height about 50 m/);
  assert.match(wallLabel(1), /true height/);
  assert.match(wallLabel(1), /hypothetical/);
});
