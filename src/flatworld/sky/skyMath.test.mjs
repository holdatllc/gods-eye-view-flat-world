import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldFrame } from '../projection/domains.js';
import {
  skyState,
  sunHeightKm,
  moonHeightKm,
  solarAltitudeDeg,
  subBodyPoint,
  dayState,
  wrap180,
} from './skyMath.js';
import { Body } from '../vendor/astronomy-engine/astronomy.js';

const frame = createWorldFrame();
const near = (a, b, tol, label) =>
  assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} vs ${b} (tol ${tol})`);

test('coil height: 3828 km at +23.44, 4828 at 0, 5828 at -23.44', () => {
  near(sunHeightKm(23.44, 'coil'), 3828, 1e-9, 'june');
  near(sunHeightKm(0, 'coil'), 4828, 1e-9, 'equinox');
  near(sunHeightKm(-23.44, 'coil'), 5828, 1e-9, 'december');
  assert.equal(sunHeightKm(10, 'constant'), 4828);
  assert.equal(sunHeightKm(10, 'rowbotham'), 1127);
  near(moonHeightKm(0, 'coil'), 4528, 1e-9, 'moon');
});

test('solstice and equinox dates give real declinations and circle radii', () => {
  const rows = {};
  for (const [name, iso] of [
    ['june', '2026-06-21T08:24:00Z'],
    ['equinox', '2026-09-23T00:05:00Z'],
    ['december', '2026-12-21T20:50:00Z'],
  ]) {
    const s = skyState(new Date(iso), frame);
    rows[name] = {
      decDeg: +s.sun.dec.toFixed(3),
      radiusKm: +(s.sun.radiusM / 1000).toFixed(1),
      heightKm: +(s.sun.heightM / 1000).toFixed(1),
    };
  }
  console.log('SUN CIRCLE', JSON.stringify(rows));
  near(rows.june.decDeg, 23.44, 0.05, 'june dec');
  near(rows.december.decDeg, -23.44, 0.05, 'dec dec');
  near(rows.equinox.decDeg, 0, 0.3, 'equinox dec');
  assert.ok(rows.june.radiusKm < rows.equinox.radiusKm);
  assert.ok(rows.equinox.radiusKm < rows.december.radiusKm);
  near(rows.equinox.radiusKm, 10002, 5, 'equinox radius');
});

test('sub-solar point is directly under the sun: altitude 90 there', () => {
  const sub = subBodyPoint(Body.Sun, new Date('2026-03-01T12:00:00Z'));
  near(solarAltitudeDeg(sub.lat, sub.lon, sub), 90, 1e-6, 'zenith');
  near(solarAltitudeDeg(-sub.lat, wrap180(sub.lon + 180), sub), -90, 1e-6, 'antipode');
});

test('Sydney December day: noon sun well above horizon, midnight night', () => {
  const s = skyState(new Date('2026-12-21T02:00:00Z'), frame);
  const alt = solarAltitudeDeg(-33.87, 151.21, s.sun);
  assert.ok(alt > 60, `Sydney noon alt ${alt}`);
  assert.equal(dayState(alt), 'day');
});

test('moon: full moon is far from the sun, new moon is near it', () => {
  const full = skyState(new Date('2026-10-26T04:12:00Z'), frame);
  const sep = (s) => {
    let d = Math.abs(s.sun.lon - s.moon.lon);
    return d > 180 ? 360 - d : d;
  };
  console.log('FULL', full.moon.phaseName, sep(full).toFixed(1), 'deg apart');
  assert.ok(sep(full) > 150);
  const fresh = skyState(new Date('2026-11-09T21:00:00Z'), frame);
  console.log('NEW', fresh.moon.phaseName, sep(fresh).toFixed(1), 'deg apart');
  assert.ok(sep(fresh) < 30);
});
