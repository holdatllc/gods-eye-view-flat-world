import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceAlong,
  digitrafficRows,
  spawnVehicles,
  splitMilitary,
} from './liveExtrasCore.js';

const NOW = Date.parse('2026-10-11T18:42:46Z');
const feature = (mmsi, lon, lat, props = {}) => ({
  mmsi,
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: {
    mmsi,
    sog: 12,
    cog: 90,
    heading: 88,
    timestampExternal: NOW - 5000,
    ...props,
  },
});

test('Digitraffic rows keep the feed position, name, course and speed', () => {
  const gj = {
    features: [
      feature(230987000, 24.95, 60.16),
      feature(273127410, 28.43, 59.77, { sog: 0.1, cog: 0, heading: 14 }),
    ],
  };
  const meta = new Map([
    [230987000, { name: 'FINNLADY ', destination: 'DE TRAVEMUNDE' }],
  ]);
  const rows = digitrafficRows(gj, meta, { now: NOW });
  assert.equal(rows.length, 2);
  assert.deepEqual(
    {
      id: rows[0].id,
      label: rows[0].label,
      lat: rows[0].lat,
      lon: rows[0].lon,
    },
    { id: '230987000', label: 'FINNLADY', lat: 60.16, lon: 24.95 },
  );
  assert.equal(rows[0].heading, 90); // underway: course over ground
  assert.ok(Math.abs(rows[0].speedMps - 12 * 0.514444) < 1e-9);
  assert.equal(rows[1].heading, 14); // moored: true heading
  assert.equal(rows[1].label, 'MMSI 273127410');
});

test('Digitraffic rows drop stale fixes, bad coordinates, unavailable values and AISStream duplicates', () => {
  const gj = {
    features: [
      feature(1, 24, 60, { timestampExternal: NOW - 2 * 3600e3 }),
      feature(2, 200, 60),
      feature(3, 24, 60, { sog: 102.3, cog: 360, heading: 511 }),
      feature(4, 24, 60),
    ],
  };
  const rows = digitrafficRows(gj, new Map(), {
    now: NOW,
    skipMmsi: new Set(['4']),
  });
  assert.deepEqual(
    rows.map((r) => r.id),
    ['3'],
  );
  assert.equal(rows[0].heading, null);
  assert.equal(rows[0].speedMps, null);
});

test('flights flagged military move to the military kind and are never drawn twice', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const { civil, militaryExtra } = splitMilitary(
    rows,
    new Set(['b', 'c']),
    new Set(['c']),
  );
  assert.deepEqual(
    civil.map((r) => r.id),
    ['a'],
  );
  assert.deepEqual(
    militaryExtra.map((r) => r.id),
    ['b'],
  );
});

test('vehicles advance by metres along their road and stop at its end', () => {
  // ~1113 m per 0.01° of latitude.
  const road = [
    [10, 50],
    [10, 50.01],
    [10, 50.02],
  ];
  const s0 = advanceAlong(road, { segIdx: 0, t: 0, direction: 1 }, 0);
  assert.equal(s0.lat, 50);
  assert.ok(Math.abs(s0.heading - 0) < 1e-9);
  const s1 = advanceAlong(road, s0, 1500);
  assert.equal(s1.segIdx, 1);
  assert.ok(Math.abs(s1.lat - (50 + 1500 / 111195)) < 1e-4);
  assert.equal(advanceAlong(road, s1, 5000).done, true);
  const back = advanceAlong(road, { segIdx: 1, t: 1, direction: -1 }, 100);
  assert.ok(Math.abs(back.heading - 180) < 1e-9);
});

test('vehicles are spread along real roads, faster on bigger roads, capped in number', () => {
  const roads = [
    {
      coordinates: [
        [10, 50],
        [10, 50.02],
      ],
      roadClass: 'motorway',
      oneway: 1,
    },
    {
      coordinates: [
        [10.01, 50],
        [10.01, 50.02],
      ],
      roadClass: 'minor',
      oneway: 0,
    },
    { coordinates: [[10, 50]], roadClass: 'minor' },
  ];
  const cars = spawnVehicles(roads, { seed: 7 });
  const mw = cars.filter((c) => c.roadClass === 'motorway');
  const mn = cars.filter((c) => c.roadClass === 'minor');
  assert.ok(mw.length >= 23 && mw.length <= 26); // 2224 m / 90 m
  assert.ok(mn.length >= 13 && mn.length <= 15); // 2224 m / 160 m
  assert.ok(
    mw.every(
      (c) => c.direction === 1 && c.lon === 10 && c.lat >= 50 && c.lat <= 50.02,
    ),
  );
  assert.ok(
    Math.min(...mw.map((c) => c.mps)) > Math.max(...mn.map((c) => c.mps)),
  );
  assert.deepEqual(
    spawnVehicles(roads, { seed: 7 }).map((c) => c.lat),
    cars.map((c) => c.lat),
  );
  assert.equal(spawnVehicles(roads, { seed: 7, max: 10 }).length, 10);
});
