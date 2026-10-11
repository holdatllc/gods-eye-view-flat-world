import test from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter } from 'pbf';
import {
  FOUNDATION_M,
  buildTile,
  buildingColours,
  clipLine,
  clipRing,
  lonLatToTilePixel,
  parseColour,
  tilePixelToLonLat,
  transferables,
} from './buildingsWorker.js';
import {
  lonLatToTile,
  makeHeightSampler,
  tileToLonLat,
} from './buildingsLayer.js';
import { createWorldFrame } from '../projection/domains.js';
import { ChunkManager } from '../terrain/chunkManager.js';

const Z = 14;
const TX = 4824; // Midtown Manhattan
const TY = 6157;
const E = 4096;

// ---- Minimal MVT encoder (OpenMapTiles-like layers) -------------------------------------------

const zigzag = (v) => (v << 1) ^ (v >> 31);

function geometry(parts, closed) {
  const out = [];
  let cx = 0;
  let cy = 0;
  for (const part of parts) {
    const [x0, y0] = part[0];
    out.push(9, zigzag(x0 - cx), zigzag(y0 - cy));
    cx = x0;
    cy = y0;
    out.push(((part.length - 1) << 3) | 2);
    for (const [x, y] of part.slice(1)) {
      out.push(zigzag(x - cx), zigzag(y - cy));
      cx = x;
      cy = y;
    }
    if (closed) out.push(15); // ClosePath, count 1
  }
  return out;
}

function encodeTile(layers) {
  const pbf = new PbfWriter();
  for (const [name, features] of Object.entries(layers)) {
    const keys = new Map();
    const values = [];
    const encoded = features.map((f) => {
      const tags = [];
      for (const [k, v] of Object.entries(f.properties)) {
        if (!keys.has(k)) keys.set(k, keys.size);
        tags.push(keys.get(k), values.length);
        values.push(v);
      }
      return { ...f, tags };
    });
    pbf.writeMessage(
      3,
      (_, out) => {
        out.writeVarintField(15, 2);
        out.writeStringField(1, name);
        for (const f of encoded) {
          out.writeMessage(
            2,
            (ff, o) => {
              if (Number.isInteger(ff.id)) o.writeVarintField(1, ff.id);
              o.writePackedVarint(2, ff.tags);
              o.writeVarintField(3, ff.type);
              o.writePackedVarint(4, geometry(ff.rings, ff.type === 3));
            },
            f,
          );
        }
        for (const k of keys.keys()) out.writeStringField(3, k);
        for (const v of values) {
          out.writeMessage(
            4,
            (vv, o) => {
              if (typeof vv === 'boolean') o.writeBooleanField(7, vv);
              else if (typeof vv === 'number') o.writeVarintField(5, vv);
              else o.writeStringField(1, String(vv));
            },
            v,
          );
        }
        out.writeVarintField(5, E);
      },
      null,
    );
  }
  return pbf.finish();
}

// Clockwise in tile pixels (y down) = MVT exterior ring; holes counter-clockwise.
const square = (x0, y0, x1, y1) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
const reversed = (r) => [...r].reverse();

const FEATURES = {
  building: [
    {
      id: 10,
      type: 3,
      rings: [square(1000, 1000, 1100, 1100)],
      properties: {
        render_height: 30,
        render_min_height: 0,
        colour: '#ff0000',
      },
    },
    {
      id: 20,
      type: 3,
      rings: [
        square(2000, 2000, 2400, 2400),
        reversed(square(2100, 2100, 2300, 2300)),
      ],
      properties: { render_height: 12, render_min_height: 0 },
    },
    {
      id: 30,
      type: 3,
      rings: [square(1000, 1000, 1100, 1100)],
      properties: { render_height: 444, render_min_height: 0, hide_3d: true },
    },
    {
      id: 40,
      type: 3,
      rings: [square(4000, 500, 4150, 600)],
      properties: { render_height: 20, render_min_height: 0 },
    },
    {
      id: 50,
      type: 3,
      rings: [square(3000, 3000, 3040, 3040)],
      properties: { render_height: 80, render_min_height: 50 },
    },
  ],
  transportation: [
    {
      id: 1,
      type: 2,
      rings: [
        [
          [-100, 2048],
          [4200, 2048],
        ],
      ],
      properties: { class: 'primary' },
    },
    {
      id: 2,
      type: 2,
      rings: [
        [
          [100, 100],
          [900, 900],
        ],
      ],
      properties: { class: 'primary', brunnel: 'tunnel' },
    },
    {
      id: 3,
      type: 2,
      rings: [
        [
          [100, 300],
          [900, 300],
        ],
      ],
      properties: { class: 'ferry' },
    },
  ],
};

const frame = createWorldFrame();
const bytes = encodeTile(FEATURES);
const result = buildTile(bytes, {
  z: Z,
  x: TX,
  y: TY,
  frame,
  probe: (() => {
    const [lon, lat] = tilePixelToLonLat(Z, TX, TY, 1050, 1050, E);
    return { lat, lon };
  })(),
});
const B = result.buildings;
const R = result.roads;

/** Drawn positions on flat ground at 0 m with exaggeration 1 (y = aGround + y · e). */
const placed = (part) => Float64Array.from(part.position);

function cross(p, a, b, c) {
  const ux = p[b * 3] - p[a * 3];
  const uy = p[b * 3 + 1] - p[a * 3 + 1];
  const uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3];
  const vy = p[c * 3 + 1] - p[a * 3 + 1];
  const vz = p[c * 3 + 2] - p[a * 3 + 2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

test('tile pixel ↔ lon/lat round trip and tile lookup', () => {
  const [lon, lat] = tilePixelToLonLat(Z, TX, TY, 1234.5, 777.25, E);
  const [px, py] = lonLatToTilePixel(Z, TX, TY, lon, lat, E);
  assert.ok(Math.abs(px - 1234.5) < 1e-6 && Math.abs(py - 777.25) < 1e-6);
  assert.deepEqual(lonLatToTile(lon, lat, Z), { x: TX, y: TY });
  const nw = tileToLonLat(0, 0, 0);
  assert.equal(nw.lon, -180);
  assert.ok(Math.abs(nw.lat - 85.0511287798066) < 1e-9);
  assert.deepEqual(lonLatToTile(-73.9857, 40.7484, 14), { x: 4824, y: 6157 });
});

test('ring and line clipping to the tile square', () => {
  const inside = square(10, 10, 20, 20);
  assert.equal(clipRing(inside, E).clipped, false);
  const c = clipRing(square(4000, 500, 4150, 600), E);
  assert.equal(c.clipped, true);
  assert.ok(c.points.every(([x, y]) => x >= 0 && x <= E && y >= 0 && y <= E));
  assert.equal(c.points.filter(([x]) => x === E).length, 2);
  const pieces = clipLine(
    [
      [-100, 10],
      [5000, 10],
    ],
    E,
  );
  assert.deepEqual(pieces, [
    [
      [0, 10],
      [E, 10],
    ],
  ]);
  assert.deepEqual(
    clipLine(
      [
        [-100, -10],
        [-5, -50],
      ],
      E,
    ),
    [],
  );
  // A line leaving and re-entering the tile becomes two pieces.
  assert.equal(
    clipLine(
      [
        [10, 10],
        [10, -50],
        [20, -50],
        [20, 10],
      ],
      E,
    ).length,
    2,
  );
});

test('buildings: counts, hide_3d, foundations and float32 tile-local positions', () => {
  assert.equal(result.stats.hidden3d, 1);
  assert.equal(B.count, 4);
  assert.equal(B.vstart.length, B.count + 1);
  assert.equal(B.wallStart.length, B.count);
  assert.equal(B.vstart[B.count], B.position.length / 3);
  assert.equal(B.lod[2], B.index.length);
  assert.ok(B.index instanceof Uint16Array, 'small tiles use 16-bit indices');
  assert.ok(B.lod[0] <= B.lod[1] && B.lod[1] <= B.lod[2]);
  for (const v of B.position) assert.ok(Number.isFinite(v));
  for (let i = 0; i < B.position.length; i += 3) {
    assert.ok(
      Math.abs(B.position[i]) < 2500 && Math.abs(B.position[i + 2]) < 2500,
      'tile-local coordinates stay small',
    );
  }
  const y = (v) => B.position[v * 3 + 1];
  for (let s = 0; s < B.count; s += 1) {
    const top = y(B.vstart[s]);
    // Roof vertices first (all at the top), then wall quads: two bottom vertices, two top.
    for (let v = B.vstart[s]; v < B.wallStart[s]; v += 1)
      assert.equal(y(v), top);
    for (let v = B.wallStart[s]; v < B.vstart[s + 1]; v += 4) {
      const bottom = B.ground[s] ? -FOUNDATION_M : 50;
      assert.deepEqual(
        [y(v), y(v + 1), y(v + 2), y(v + 3)],
        [bottom, bottom, top, top],
      );
    }
  }
  // The raised part (50–80 m) starts above ground; the others are ground-level with foundations.
  const raised = [...Array(B.count).keys()].find((s) => y(B.vstart[s]) === 80);
  assert.equal(B.ground[raised], 0);
  assert.equal([...B.ground].filter(Boolean).length, 3);
  assert.equal(B.bounds.relMin, -FOUNDATION_M);
  assert.equal(B.bounds.relMax, 80);
  assert.ok(transferables(result).length >= 12);
});

test('buildings: every triangle faces along its normal; walls point away from the building', () => {
  const p = placed(B);
  for (let i = 0; i < B.index.length; i += 3) {
    const [a, b, c] = [B.index[i], B.index[i + 1], B.index[i + 2]];
    const n = cross(p, a, b, c);
    const dot =
      n[0] * B.normal[a * 3] +
      n[1] * B.normal[a * 3 + 1] +
      n[2] * B.normal[a * 3 + 2];
    assert.ok(dot > 0, `triangle ${i / 3} winds against its normal`);
  }
  // Inside/outside test against each building's own roof triangles.
  for (let s = 0; s < B.count; s += 1) {
    const v0 = B.vstart[s];
    const v1 = B.vstart[s + 1];
    const tris = [];
    for (let i = 0; i < B.index.length; i += 3) {
      const a = B.index[i];
      if (a >= v0 && a < v1 && B.normal[a * 3 + 1] === 127)
        tris.push([a, B.index[i + 1], B.index[i + 2]]);
    }
    const inside = (x, z) =>
      tris.some(([a, b, c]) => {
        const s1 =
          (p[b * 3] - p[a * 3]) * (z - p[a * 3 + 2]) -
          (p[b * 3 + 2] - p[a * 3 + 2]) * (x - p[a * 3]);
        const s2 =
          (p[c * 3] - p[b * 3]) * (z - p[b * 3 + 2]) -
          (p[c * 3 + 2] - p[b * 3 + 2]) * (x - p[b * 3]);
        const s3 =
          (p[a * 3] - p[c * 3]) * (z - p[c * 3 + 2]) -
          (p[a * 3 + 2] - p[c * 3 + 2]) * (x - p[c * 3]);
        return (
          (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)
        );
      });
    let walls = 0;
    for (let v = B.wallStart[s]; v < v1; v += 4) {
      assert.equal(B.normal[v * 3 + 1], 0, 'wall quads are vertical');
      walls += 1;
      const mx = (p[v * 3] + p[(v + 1) * 3]) / 2;
      const mz = (p[v * 3 + 2] + p[(v + 1) * 3 + 2]) / 2;
      const nx = B.normal[v * 3] / 127;
      const nz = B.normal[v * 3 + 2] / 127;
      assert.ok(
        inside(mx - nx * 0.3, mz - nz * 0.3),
        `building ${s}: wall ${walls} inner side is inside`,
      );
      assert.ok(
        !inside(mx + nx * 0.3, mz + nz * 0.3),
        `building ${s}: wall ${walls} outer side is outside`,
      );
    }
    assert.ok(walls >= 3);
  }
});

test('courtyard hole and tile-edge seam: roof area and wall counts', () => {
  const p = placed(B);
  const roofArea = (s) => {
    let area = 0;
    for (let i = 0; i < B.index.length; i += 3) {
      const [a, b, c] = [B.index[i], B.index[i + 1], B.index[i + 2]];
      if (
        a < B.vstart[s] ||
        a >= B.vstart[s + 1] ||
        B.normal[a * 3 + 1] !== 127
      )
        continue;
      area += Math.hypot(...cross(p, a, b, c)) / 2;
    }
    return area;
  };
  const wallCount = (s) => {
    let n = 0;
    for (let v = B.vstart[s]; v < B.vstart[s + 1]; v += 1)
      if (B.normal[v * 3 + 1] === 0) n += 1;
    return n / 4;
  };
  const roofVerts = (s) => {
    let n = 0;
    for (let v = B.vstart[s]; v < B.vstart[s + 1]; v += 1)
      if (B.normal[v * 3 + 1] === 127) n += 1;
    return n;
  };
  const courtyard = [...Array(B.count).keys()].find((s) => roofVerts(s) === 8);
  assert.equal(wallCount(courtyard), 8, 'outer + inner walls');
  const scale = (px) =>
    px * ((40075016.686 * Math.cos(40.75 * (Math.PI / 180))) / 2 ** Z / E);
  const k = frame.projection.scaleFactors(40.75).k; // AEQD stretches east-west by k
  const expected = (scale(400) ** 2 - scale(200) ** 2) * k;
  assert.ok(
    Math.abs(roofArea(courtyard) / expected - 1) < 0.01,
    `courtyard roof ${roofArea(courtyard)} vs ${expected}`,
  );
  // The building cut by the tile edge keeps 3 walls; the seam on the tile edge gets none.
  const cut = [...Array(B.count).keys()].find(
    (s) => roofVerts(s) === 4 && wallCount(s) === 3,
  );
  assert.ok(Number.isInteger(cut), 'clipped building has exactly three walls');
});

test('every rendered roof vertex inverts to its source lat/lon within 1e-9°', () => {
  const probe = result.probes.find((q) => !q.hidden);
  const hidden = result.probes.find((q) => q.hidden);
  assert.ok(
    probe && hidden,
    'probe finds the visible footprint and the hide_3d outline',
  );
  assert.equal(probe.roofCount, 4);
  assert.deepEqual(
    probe.roofLocal,
    Array.from(
      B.position.subarray(probe.roofStart * 3, (probe.roofStart + 4) * 3),
    ),
  );
  let worst = 0;
  for (let i = 0; i < probe.roofCount; i += 1) {
    const v = probe.roofStart + i;
    const x = result.origin.x + B.position[v * 3];
    const y = result.origin.y - B.position[v * 3 + 2];
    const d = frame.worldToDomain(x, y, 0);
    assert.equal(d.domain, 'gps');
    worst = Math.max(
      worst,
      Math.abs(d.lat - probe.roofLatLon[i][0]),
      Math.abs(d.lon - probe.roofLatLon[i][1]),
    );
  }
  assert.ok(worst < 1e-9, `worst vertex error ${worst}°`);
  const w = frame.geodeticToWorld(probe.centroid.lat, probe.centroid.lon, 0);
  const back = frame.worldToDomain(w.x, w.y, 0);
  assert.ok(
    Math.abs(back.lat - probe.centroid.lat) < 1e-12 &&
      Math.abs(back.lon - probe.centroid.lon) < 1e-12,
  );
  // The centroid is the mean of the source footprint's vertex lat/lons.
  const corners = square(1000, 1000, 1100, 1100).map(([px, py]) =>
    tilePixelToLonLat(Z, TX, TY, px, py, E),
  );
  const clat = corners.reduce((s, c) => s + c[1], 0) / 4;
  const clon = corners.reduce((s, c) => s + c[0], 0) / 4;
  assert.ok(
    Math.abs(probe.centroid.lat - clat) < 1e-12 &&
      Math.abs(probe.centroid.lon - clon) < 1e-12,
  );
});

test('roads: tunnels and ferries skipped, ribbon clipped to the tile, faces up, true width', () => {
  assert.ok(R && R.segments > 0);
  const p = placed(R);
  for (let i = 0; i < R.index.length; i += 3) {
    const n = cross(p, R.index[i], R.index[i + 1], R.index[i + 2]);
    assert.ok(n[1] > 0, 'road triangle faces up');
  }
  // One straight primary road across the whole tile, densified to ≤ 24 m.
  const metres = (40075016.686 * Math.cos(40.75 * (Math.PI / 180))) / 2 ** Z;
  assert.ok(
    R.count >= Math.floor(metres / 24) && R.count <= Math.ceil(metres / 24) + 2,
    `samples ${R.count}`,
  );
  for (let s = 0; s < R.count; s += 1) {
    const w = Math.hypot(
      R.position[s * 6] - R.position[s * 6 + 3],
      R.position[s * 6 + 2] - R.position[s * 6 + 5],
    );
    assert.ok(Math.abs(w - 11) < 0.05, `width ${w}`);
  }
});

test('colours: OSM colours parse; palette stays neutral and in range', () => {
  assert.deepEqual(parseColour('#ff0000'), [1, 0, 0]);
  assert.deepEqual(parseColour('#fff'), [1, 1, 1]);
  assert.ok(parseColour('beige'));
  assert.equal(parseColour('not a colour'), null);
  for (const h of [3, 8, 30, 120, 400]) {
    const c = buildingColours(h, 12345, h > 100 ? '#5a81a0' : undefined);
    for (const v of [...c.wall, ...c.roof, ...c.base])
      assert.ok(v > 0 && v < 1);
    const spread = Math.max(...c.wall) - Math.min(...c.wall);
    assert.ok(spread < 0.2, 'neutral (low saturation)');
  }
});

test('fast terrain sampler equals ChunkManager.heightAt (finest loaded chunk, bilinear)', () => {
  const grid = 4;
  const fake = { chunks: new Map(), key: ChunkManager.prototype.key };
  fake.heightAt = ChunkManager.prototype.heightAt.bind(fake);
  const ROOT = 2 ** 26;
  const add = (level, tx, ty, fn) => {
    const size = ROOT / 2 ** level;
    const x0 = tx * size - ROOT / 2;
    const y0 = ty * size - ROOT / 2;
    const pos = new Float32Array((grid + 1) ** 2 * 3);
    for (let j = 0; j <= grid; j += 1)
      for (let i = 0; i <= grid; i += 1)
        pos[(j * (grid + 1) + i) * 3 + 1] = fn(
          x0 + (i * size) / grid,
          y0 + (j * size) / grid,
        );
    fake.chunks.set(fake.key(level, tx, ty), {
      level,
      x0,
      y0,
      size,
      data: { grid, size },
      mesh: { geometry: { attributes: { position: { array: pos } } } },
    });
  };
  const L = 14;
  const size = ROOT / 2 ** L;
  const tx = Math.floor((1514000 + ROOT / 2) / size);
  const ty = Math.floor((-5276000 + ROOT / 2) / size);
  add(L, tx, ty, (x, y) => 10 + 1e-3 * (x - 1514000) + 2e-3 * (y + 5276000));
  add(
    L + 1,
    tx * 2 + 1,
    ty * 2,
    (x, y) => 12 + Math.sin(x / 300) * 3 + Math.cos(y / 200) * 2,
  );
  const x0 = tx * size - ROOT / 2;
  const y0 = ty * size - ROOT / 2;
  const b = { minX: x0, minY: y0, maxX: x0 + size, maxY: y0 + size };
  const h = makeHeightSampler(fake, b);
  let seed = 3;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 2000; i += 1) {
    const x = x0 - 50 + rnd() * (size + 100);
    const y = y0 - 50 + rnd() * (size + 100);
    assert.equal(h(x, y), fake.heightAt(x, y));
  }
});
