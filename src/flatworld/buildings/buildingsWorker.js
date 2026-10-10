/**
 * 3D buildings and roads for the flat world: OpenFreeMap (OpenMapTiles schema) z14 vector tiles →
 * extruded building meshes and draped road ribbons in the flat-world display frame.
 *
 * Runs as a module worker (see buildingsLayer.js); the builder functions are exported and have no
 * DOM/worker dependencies, so they are unit-tested in Node (buildingsWorker.test.mjs).
 *
 * Every vertex goes: tile pixel → WGS84 lat/lon (exact inverse Web Mercator) → the verified polar
 * AEQD with the Gleason display rotation (createWorldFrame, the same code as the rest of the flat
 * world) → metres relative to a tile-local origin (the projected tile centre, rounded to 1 m).
 * Positions ship as float32 relative to that origin (≤ ~1.5 km away, so ≈0.1 mm precision); the
 * origin stays float64 on the main thread.
 *
 * Heights are applied on the main thread, which places each building on the rendered terrain and
 * scales heights by the terrain exaggeration. For that each part carries:
 *   - `rel`     per vertex: metres above the building's ground (unexaggerated),
 *   - `foot`    per vertex: 1 for foundation vertices that reach below the lowest ground under the
 *               footprint (so buildings on slopes never float),
 *   - `samples` per building: ground sample point (full-footprint centroid) and footprint bbox,
 *   - `vstart`  per building: its contiguous vertex range.
 * Roads carry one ground sample per centreline point (two ribbon vertices each).
 *
 * Data: © OpenStreetMap contributors (ODbL) via OpenFreeMap / OpenMapTiles.
 */
import { VectorTile, classifyRings } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { ShapeUtils, Vector2 } from 'three';
import { createWorldFrame } from '../projection/domains.js';

export const BUILDING_ZOOM = 14;
export const DEFAULT_BUILDING_HEIGHT_M = 8;
const MAX_BUILDING_HEIGHT_M = 1000;
const EARTH_CIRCUMFERENCE_M = 40075016.68557849;
const DEG = Math.PI / 180;
/** Road centrelines are densified to this spacing so the ribbons can follow the terrain. */
export const ROAD_STEP_M = 24;
/** Per-rank vertical separation of overlapping road classes (metres, before exaggeration). */
const ROAD_RANK_LIFT_M = 0.08;

/**
 * Level-of-detail class of a building: 0 = tall or large (drawn at every distance), 1 = mid-size,
 * 2 = small (near only). Buildings are emitted in class order, so a class prefix of the index
 * buffer is a valid draw range.
 */
export function buildingClass(heightM, areaM2) {
  if (heightM >= 40 || areaM2 >= 3000) return 0;
  if (heightM >= 12 || areaM2 >= 500) return 1;
  return 2;
}

/**
 * OpenMapTiles `transportation` classes drawn as ribbons. Width in display metres; rank orders
 * overlapping classes vertically; lod: 0 = every distance, 1 = mid, 2 = near only.
 * Colours are sRGB.
 */
export const ROAD_STYLES = Object.freeze({
  motorway: { width: 15, rank: 6, lod: 0, color: [0.5, 0.49, 0.47] },
  trunk: { width: 13, rank: 6, lod: 0, color: [0.51, 0.5, 0.48] },
  primary: { width: 11, rank: 5, lod: 0, color: [0.53, 0.52, 0.5] },
  secondary: { width: 10, rank: 4, lod: 0, color: [0.55, 0.54, 0.52] },
  tertiary: { width: 8.5, rank: 3, lod: 1, color: [0.57, 0.56, 0.54] },
  busway: { width: 6, rank: 3, lod: 1, color: [0.58, 0.52, 0.5] },
  raceway: { width: 8, rank: 3, lod: 1, color: [0.54, 0.53, 0.52] },
  minor: { width: 6.5, rank: 2, lod: 1, color: [0.6, 0.59, 0.57] },
  service: { width: 4, rank: 1, lod: 2, color: [0.63, 0.62, 0.6] },
  track: { width: 3, rank: 1, lod: 2, color: [0.66, 0.6, 0.5] },
  path: { width: 1.8, rank: 0, lod: 2, color: [0.74, 0.7, 0.62] },
  rail: { width: 3.2, rank: 7, lod: 0, color: [0.4, 0.37, 0.35] },
  transit: { width: 2.6, rank: 7, lod: 1, color: [0.42, 0.39, 0.37] },
});

/** Tile pixel (0..extent, may exceed the tile into its buffer) → [lon, lat] degrees. */
export function tilePixelToLonLat(z, tx, ty, px, py, extent) {
  const n = 2 ** z;
  const lon = ((tx + px / extent) / n) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + py / extent)) / n))) / DEG;
  return [lon, lat];
}

/** [lon, lat] → tile pixel of tile (z, tx, ty). */
export function lonLatToTilePixel(z, tx, ty, lon, lat, extent) {
  const n = 2 ** z;
  const r = lat * DEG;
  const fx = ((lon + 180) / 360) * n;
  const fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return [(fx - tx) * extent, (fy - ty) * extent];
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

const NAMED_COLOURS = {
  beige: [0.96, 0.92, 0.82],
  black: [0.16, 0.16, 0.17],
  white: [0.95, 0.95, 0.94],
  gray: [0.6, 0.6, 0.6],
  grey: [0.6, 0.6, 0.6],
  silver: [0.75, 0.75, 0.76],
  brown: [0.55, 0.38, 0.27],
  red: [0.7, 0.3, 0.26],
  maroon: [0.5, 0.2, 0.18],
  orange: [0.86, 0.55, 0.3],
  yellow: [0.9, 0.82, 0.5],
  tan: [0.82, 0.71, 0.55],
  pink: [0.9, 0.7, 0.7],
  green: [0.45, 0.6, 0.45],
  blue: [0.4, 0.52, 0.66],
  cream: [0.97, 0.94, 0.84],
};

/** OSM `colour` (named or #rgb/#rrggbb) → sRGB triple, or null. */
export function parseColour(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (NAMED_COLOURS[v]) return NAMED_COLOURS[v];
  let m = /^#?([0-9a-f]{6})$/.exec(v);
  if (m) {
    const n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  m = /^#?([0-9a-f]{3})$/.exec(v);
  if (m) return [...m[1]].map((h) => parseInt(h + h, 16) / 255);
  return null;
}

function hash01(id, salt) {
  let h = (Number(id) % 2147483647 | 0) ^ Math.imul(salt, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Neutral building palette: warm stone for low-rise, cooler concrete/glass greys for towers, a
 * little per-building variation, and a light tint toward the mapped OSM colour when there is one.
 * Returns sRGB triples for walls, wall bases (slightly darker) and roofs.
 */
export function buildingColours(heightM, id, colour) {
  const t = Math.min(Math.max(Math.log(Math.max(heightM, 3) / 6) / Math.log(200 / 6), 0), 1);
  const low = [0.87, 0.83, 0.77];
  const high = [0.75, 0.77, 0.8];
  let wall = low.map((c, i) => c + (high[i] - c) * t);
  const j = 0.92 + 0.12 * hash01(id, 1);
  const warm = (hash01(id, 2) - 0.5) * 0.04;
  wall = [wall[0] * j + warm, wall[1] * j, wall[2] * j - warm];
  const osm = parseColour(colour);
  if (osm) {
    const grey = (osm[0] + osm[1] + osm[2]) / 3;
    const soft = osm.map((c) => grey + (c - grey) * 0.5);
    wall = wall.map((c, i) => c + (soft[i] - c) * 0.25);
  }
  wall = wall.map((c) => Math.min(Math.max(c, 0.05), 0.95));
  const roof = wall.map((c) => c * 0.8 + (0.55 - c * 0.8) * 0.45);
  const base = wall.map((c) => c * 0.78);
  return { wall, base, roof };
}

/** Growable typed array. */
class Grow {
  constructor(Type, capacity = 4096) {
    this.Type = Type;
    this.a = new Type(capacity);
    this.n = 0;
  }
  reserve(k) {
    if (this.n + k <= this.a.length) return;
    let cap = this.a.length * 2;
    while (cap < this.n + k) cap *= 2;
    const b = new this.Type(cap);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  push(v) {
    this.reserve(1);
    this.a[this.n++] = v;
  }
  push3(x, y, z) {
    this.reserve(3);
    this.a[this.n++] = x;
    this.a[this.n++] = y;
    this.a[this.n++] = z;
  }
  done() {
    return this.a.slice(0, this.n);
  }
}

/** Convert an MVT ring (array of {x, y}, closed) into an open array of [x, y] without repeats. */
function openRing(ring) {
  const out = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p.x || last[1] !== p.y) out.push([p.x, p.y]);
  }
  if (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) out.pop();
  }
  return out;
}

function ringArea(r) {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return s / 2;
}

/**
 * Sutherland–Hodgman clip of a ring against the square [0, extent]². Returns the clipped ring and
 * whether anything was cut away (edges on the box boundary of a cut ring are seams, not walls).
 */
export function clipRing(ring, extent) {
  let inside = true;
  for (const p of ring) {
    if (p[0] < 0 || p[0] > extent || p[1] < 0 || p[1] > extent) {
      inside = false;
      break;
    }
  }
  if (inside) return { points: ring, clipped: false };
  let out = ring;
  const planes = [
    [0, 0, true],
    [0, extent, false],
    [1, 0, true],
    [1, extent, false],
  ];
  for (const [axis, value, keepGreater] of planes) {
    const input = out;
    out = [];
    if (!input.length) break;
    const isIn = (p) => (keepGreater ? p[axis] >= value : p[axis] <= value);
    let prev = input[input.length - 1];
    let prevIn = isIn(prev);
    for (const cur of input) {
      const curIn = isIn(cur);
      if (curIn !== prevIn) {
        const t = (value - prev[axis]) / (cur[axis] - prev[axis]);
        out.push(
          axis === 0 ? [value, prev[1] + t * (cur[1] - prev[1])] : [prev[0] + t * (cur[0] - prev[0]), value],
        );
      }
      if (curIn) out.push(cur);
      prev = cur;
      prevIn = curIn;
    }
  }
  // Drop repeats the clipping may have introduced.
  const clean = [];
  for (const p of out) {
    const last = clean[clean.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) clean.push(p);
  }
  if (clean.length > 1) {
    const a = clean[0];
    const b = clean[clean.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) clean.pop();
  }
  return { points: clean, clipped: true };
}

/** Clip a polyline to the square [0, extent]² (Liang–Barsky per segment); returns the pieces. */
export function clipLine(points, extent) {
  const pieces = [];
  let cur = null;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    let t0 = 0;
    let t1 = 1;
    let ok = true;
    for (const [p, q] of [
      [-dx, a[0]],
      [dx, extent - a[0]],
      [-dy, a[1]],
      [dy, extent - a[1]],
    ]) {
      if (p === 0) {
        if (q < 0) ok = false;
      } else {
        const r = q / p;
        if (p < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
      }
    }
    if (!ok || t0 > t1) {
      cur = null;
      continue;
    }
    const pa = t0 === 0 ? a : [a[0] + t0 * dx, a[1] + t0 * dy];
    const pb = t1 === 1 ? b : [a[0] + t1 * dx, a[1] + t1 * dy];
    if (cur && t0 === 0) cur.push(pb);
    else {
      cur = [pa, pb];
      pieces.push(cur);
    }
    if (t1 !== 1) cur = null;
  }
  return pieces;
}

function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function makeProjector({ z, x, y, frame, origin }, extent) {
  const n = 2 ** z;
  /** Tile pixel → { lx, ly } (display metres relative to the tile origin) plus lat/lon. */
  return (px, py) => {
    const lon = ((x + px / extent) / n) * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + py / extent)) / n))) / DEG;
    const w = frame.geodeticToWorld(lat, lon, 0);
    return { lx: w.x - origin.x, ly: w.y - origin.y, lat, lon };
  };
}

function finiteOr(value, fallback) {
  const v = Number(value);
  return Number.isFinite(v) ? v : fallback;
}

const toByte = (c) => Math.round(Math.min(Math.max(srgbToLinear(c), 0), 1) * 255);

/** Building layer → extruded geometry. */
function buildBuildings(layer, ctx, probe) {
  const E = layer.extent;
  const project = makeProjector(ctx, E);
  const mPerPx = ctx.metresPerTile / E;
  const probePx = probe ? lonLatToTilePixel(ctx.z, ctx.x, ctx.y, probe.lon, probe.lat, E) : null;
  const probes = [];
  const polys = [];
  let hidden = 0;
  let features = 0;
  for (let i = 0; i < layer.length; i += 1) {
    const f = layer.feature(i);
    if (f.type !== 3) continue;
    const p = f.properties;
    const hide = p.hide_3d === true || p.hide_3d === 'true' || p.hide_3d === 1;
    let top = Math.min(finiteOr(p.render_height, DEFAULT_BUILDING_HEIGHT_M), MAX_BUILDING_HEIGHT_M);
    const bottom = Math.max(finiteOr(p.render_min_height, 0), 0);
    if (!(top > bottom)) top = bottom + 1;
    let emitted = false;
    for (const polygon of classifyRings(f.loadGeometry())) {
      const outer = openRing(polygon[0]);
      if (outer.length < 3) continue;
      const isProbe = Boolean(probePx && pointInRing(probePx, outer));
      const id = f.id ?? i;
      const probeRec = isProbe
        ? { featureId: id, properties: { ...p }, hidden: hide, renderHeight: top, renderMinHeight: bottom }
        : null;
      if (probeRec) {
        // Source footprint in lat/lon (unclipped outer ring) and its lat/lon centroid.
        const ll = outer.map(([px, py]) => tilePixelToLonLat(ctx.z, ctx.x, ctx.y, px, py, E));
        probeRec.outerLatLon = ll.map(([lon, lat]) => [lat, lon]);
        probeRec.centroid = {
          lat: ll.reduce((s, q) => s + q[1], 0) / ll.length,
          lon: ll.reduce((s, q) => s + q[0], 0) / ll.length,
        };
        const w = ctx.frame.geodeticToWorld(probeRec.centroid.lat, probeRec.centroid.lon, 0);
        probeRec.centroidDisplay = { x: w.x, y: w.y };
        probes.push(probeRec);
      }
      if (hide) {
        hidden += 1;
        continue;
      }
      const rings = [];
      for (let r = 0; r < polygon.length; r += 1) {
        const open = r === 0 ? outer : openRing(polygon[r]);
        if (open.length < 3) continue;
        const c = clipRing(open, E);
        if (c.points.length < 3 || Math.abs(ringArea(c.points)) < 1e-6) {
          if (r === 0) break;
          continue;
        }
        rings.push({ ...c, hole: r > 0 });
      }
      if (!rings.length || rings[0].hole) continue;
      let areaPx = Math.abs(ringArea(rings[0].points));
      for (const r of rings.slice(1)) areaPx -= Math.abs(ringArea(r.points));
      const areaM2 = Math.max(areaPx, 0) * mPerPx * mPerPx;
      let cx = 0;
      let cy = 0;
      for (const q of outer) {
        cx += q[0];
        cy += q[1];
      }
      polys.push({
        id,
        colour: p.colour,
        top,
        bottom,
        rings,
        centroidPx: [cx / outer.length, cy / outer.length],
        cls: buildingClass(top, areaM2),
        probe: probeRec,
      });
      emitted = true;
    }
    if (emitted) features += 1;
  }
  polys.sort((a, b) => a.cls - b.cls);

  const position = new Grow(Float32Array, 1 << 16);
  const normal = new Grow(Int8Array, 1 << 16);
  const color = new Grow(Uint8Array, 1 << 16);
  const rel = new Grow(Float32Array, 1 << 14);
  const foot = new Grow(Uint8Array, 1 << 14);
  const index = new Grow(Uint32Array, 1 << 16);
  const samples = new Grow(Float32Array, 1 << 12);
  const vstart = new Grow(Uint32Array, 1 << 10);
  const lod = [0, 0, 0];
  let vertexCount = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const poly of polys) {
    const { wall, base, roof } = buildingColours(poly.top, poly.id, poly.colour);
    const cWall = wall.map(toByte);
    const cBase = base.map(toByte);
    const cRoof = roof.map(toByte);
    const groundLevel = poly.bottom <= 0;
    // Project every ring point once (exact, float64), then store relative to the tile origin.
    const rings = poly.rings.map((r) => {
      const pts = r.points.map(([px, py]) => project(px, py));
      const seam = new Uint8Array(pts.length);
      if (r.clipped) {
        for (let i = 0; i < pts.length; i += 1) {
          const a = r.points[i];
          const b = r.points[(i + 1) % pts.length];
          seam[i] =
            (a[0] === 0 && b[0] === 0) ||
            (a[0] === E && b[0] === E) ||
            (a[1] === 0 && b[1] === 0) ||
            (a[1] === E && b[1] === E)
              ? 1
              : 0;
        }
      }
      return { pts, seam };
    });
    let area2 = 0;
    {
      const o = rings[0].pts;
      for (let i = 0, j = o.length - 1; i < o.length; j = i++) area2 += o[j].lx * o[i].ly - o[i].lx * o[j].ly;
    }
    if (area2 === 0) continue;
    const sgn = area2 > 0 ? 1 : -1;
    const centroid = project(poly.centroidPx[0], poly.centroidPx[1]);
    let bx0 = Infinity;
    let by0 = Infinity;
    let bx1 = -Infinity;
    let by1 = -Infinity;
    for (const q of rings[0].pts) {
      bx0 = Math.min(bx0, q.lx);
      by0 = Math.min(by0, q.ly);
      bx1 = Math.max(bx1, q.lx);
      by1 = Math.max(by1, q.ly);
    }
    minX = Math.min(minX, bx0);
    minY = Math.min(minY, by0);
    maxX = Math.max(maxX, bx1);
    maxY = Math.max(maxY, by1);
    const sampleIndex = vstart.n;
    vstart.push(vertexCount);
    samples.push3(centroid.lx, centroid.ly, bx0);
    samples.push3(by0, bx1, by1);

    // Roof: one vertex per ring point, earcut triangles made counter-clockwise (facing up).
    const roofStart = vertexCount;
    const contour = rings[0].pts.map((q) => new Vector2(q.lx, q.ly));
    const holes = rings.slice(1).map((r) => r.pts.map((q) => new Vector2(q.lx, q.ly)));
    const flat = [];
    for (const r of rings) {
      for (const q of r.pts) {
        position.push3(q.lx, 0, -q.ly);
        normal.push3(0, 127, 0);
        color.push3(cRoof[0], cRoof[1], cRoof[2]);
        rel.push(poly.top);
        foot.push(0);
        flat.push(q);
      }
    }
    vertexCount += flat.length;
    const faces = ShapeUtils.triangulateShape(contour, holes);
    for (const [a, b, c] of faces) {
      const A = flat[a];
      const B = flat[b];
      const C = flat[c];
      const cross = (B.lx - A.lx) * (C.ly - A.ly) - (B.ly - A.ly) * (C.lx - A.lx);
      if (cross === 0) continue;
      if (cross > 0) index.push3(roofStart + a, roofStart + b, roofStart + c);
      else index.push3(roofStart + a, roofStart + c, roofStart + b);
    }
    if (poly.probe) {
      poly.probe.sampleIndex = sampleIndex;
      poly.probe.roofStart = roofStart;
      poly.probe.roofCount = flat.length;
      poly.probe.roofLatLon = flat.map((q) => [q.lat, q.lon]);
    }

    // Walls: four vertices per edge (flat shading), outward normals, seams skipped.
    for (const r of rings) {
      const n = r.pts.length;
      for (let i = 0; i < n; i += 1) {
        if (r.seam[i]) continue;
        const a = r.pts[i];
        const b = r.pts[(i + 1) % n];
        const dx = b.lx - a.lx;
        const dy = b.ly - a.ly;
        const len = Math.hypot(dx, dy);
        if (len < 1e-4) continue;
        const nx = (sgn * dy) / len;
        const ny = (-sgn * dx) / len;
        const v = vertexCount;
        position.push3(a.lx, 0, -a.ly);
        position.push3(b.lx, 0, -b.ly);
        position.push3(b.lx, 0, -b.ly);
        position.push3(a.lx, 0, -a.ly);
        const inx = Math.round(nx * 127);
        const inz = Math.round(-ny * 127);
        for (let k = 0; k < 4; k += 1) normal.push3(inx, 0, inz);
        const cb = groundLevel ? cBase : cWall;
        color.push3(cb[0], cb[1], cb[2]);
        color.push3(cb[0], cb[1], cb[2]);
        color.push3(cWall[0], cWall[1], cWall[2]);
        color.push3(cWall[0], cWall[1], cWall[2]);
        rel.push(poly.bottom);
        rel.push(poly.bottom);
        rel.push(poly.top);
        rel.push(poly.top);
        foot.push(groundLevel ? 1 : 0);
        foot.push(groundLevel ? 1 : 0);
        foot.push(0);
        foot.push(0);
        if (sgn > 0) {
          index.push3(v, v + 1, v + 2);
          index.push3(v, v + 2, v + 3);
        } else {
          index.push3(v, v + 2, v + 1);
          index.push3(v, v + 3, v + 2);
        }
        vertexCount += 4;
      }
    }
    for (let c = poly.cls; c < 3; c += 1) lod[c] = index.n;
  }
  vstart.push(vertexCount);
  if (!vertexCount) return { part: null, probes, hidden, features: 0 };
  return {
    part: {
      count: vstart.n - 1,
      features,
      position: position.done(),
      normal: normal.done(),
      color: color.done(),
      rel: rel.done(),
      foot: foot.done(),
      index: index.done(),
      samples: samples.done(),
      vstart: vstart.done(),
      lod,
      bounds: { minX, minY, maxX, maxY },
    },
    probes,
    hidden,
    features,
  };
}

/** Transportation layer → draped ribbons. */
function buildRoads(layer, ctx) {
  const E = layer.extent;
  const project = makeProjector(ctx, E);
  const pxPerM = E / ctx.metresPerTile;
  const lines = [];
  for (let i = 0; i < layer.length; i += 1) {
    const f = layer.feature(i);
    if (f.type !== 2) continue;
    const p = f.properties;
    const style = ROAD_STYLES[p.class];
    if (!style) continue;
    if (p.brunnel === 'tunnel' || p.indoor === 1 || p.indoor === true) continue;
    const width = style.width * (p.ramp === 1 || p.ramp === true ? 0.75 : 1);
    for (const part of f.loadGeometry()) {
      const pts = part.map((q) => [q.x, q.y]);
      for (const piece of clipLine(pts, E)) lines.push({ pts: piece, style, width });
    }
  }
  lines.sort((a, b) => a.style.lod - b.style.lod);

  const position = new Grow(Float32Array, 1 << 15);
  const normal = new Grow(Int8Array, 1 << 15);
  const color = new Grow(Uint8Array, 1 << 15);
  const index = new Grow(Uint32Array, 1 << 15);
  const samples = new Grow(Float32Array, 1 << 14);
  const lod = [0, 0, 0];
  let vertexCount = 0;
  let segments = 0;
  const stepPx = ROAD_STEP_M * pxPerM;
  for (const line of lines) {
    // Densify in tile pixels, then project every point exactly.
    const dense = [];
    for (let i = 0; i < line.pts.length; i += 1) {
      const a = line.pts[i];
      if (i > 0) {
        const b = line.pts[i - 1];
        const steps = Math.ceil(Math.hypot(a[0] - b[0], a[1] - b[1]) / stepPx);
        for (let s = 1; s < steps; s += 1) {
          const t = s / steps;
          dense.push([b[0] + (a[0] - b[0]) * t, b[1] + (a[1] - b[1]) * t]);
        }
      }
      dense.push(a);
    }
    const pts = [];
    for (const [px, py] of dense) {
      const q = project(px, py);
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(q.lx - last.lx, q.ly - last.ly) > 0.05) pts.push(q);
    }
    if (pts.length < 2) continue;
    const hw = line.width / 2;
    const cr = toByte(line.style.color[0]);
    const cg = toByte(line.style.color[1]);
    const cbl = toByte(line.style.color[2]);
    const lift = line.style.rank * ROAD_RANK_LIFT_M;
    const first = vertexCount;
    for (let i = 0; i < pts.length; i += 1) {
      const q = pts[i];
      let tx = 0;
      let ty = 0;
      let px = 0;
      let py = 0;
      if (i > 0) {
        const d = Math.hypot(q.lx - pts[i - 1].lx, q.ly - pts[i - 1].ly);
        px = (q.lx - pts[i - 1].lx) / d;
        py = (q.ly - pts[i - 1].ly) / d;
        tx += px;
        ty += py;
      }
      if (i + 1 < pts.length) {
        const d = Math.hypot(pts[i + 1].lx - q.lx, pts[i + 1].ly - q.ly);
        tx += (pts[i + 1].lx - q.lx) / d;
        ty += (pts[i + 1].ly - q.ly) / d;
        if (i === 0) {
          px = tx;
          py = ty;
        }
      }
      let tl = Math.hypot(tx, ty);
      if (tl < 1e-6) {
        tx = px;
        ty = py;
        tl = Math.hypot(tx, ty) || 1;
      }
      tx /= tl;
      ty /= tl;
      // Miter: offset along the averaged normal, lengthened by 1/cos(half-angle), capped.
      const nx = -ty;
      const ny = tx;
      const cosHalf = Math.max(nx * -py + ny * px, 0.35);
      const off = hw / cosHalf;
      position.push3(q.lx + nx * off, 0, -(q.ly + ny * off));
      position.push3(q.lx - nx * off, 0, -(q.ly - ny * off));
      normal.push3(0, 127, 0);
      normal.push3(0, 127, 0);
      color.push3(cr, cg, cbl);
      color.push3(cr, cg, cbl);
      samples.push3(q.lx, q.ly, lift);
      vertexCount += 2;
    }
    for (let i = 0; i + 1 < pts.length; i += 1) {
      const l0 = first + i * 2;
      const r0 = l0 + 1;
      const l1 = l0 + 2;
      const r1 = l0 + 3;
      // Right side → forward → left: counter-clockwise seen from above (front face up).
      index.push3(r0, r1, l1);
      index.push3(r0, l1, l0);
      segments += 1;
    }
    for (let c = line.style.lod; c < 3; c += 1) lod[c] = index.n;
  }
  if (!vertexCount) return null;
  return {
    count: samples.n / 3,
    segments,
    position: position.done(),
    normal: normal.done(),
    color: color.done(),
    index: index.done(),
    samples: samples.done(),
    lod,
  };
}

/**
 * Decode one OpenMapTiles vector tile and build its building and road geometry.
 * @param {Uint8Array} bytes raw (already decompressed) MVT bytes
 * @param {{ z:number, x:number, y:number, frame?:object, probe?:{lat:number, lon:number} }} options
 */
export function buildTile(bytes, { z, x, y, frame = createWorldFrame(), probe = null }) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const vt = new VectorTile(new PbfReader(bytes));
  const [clon, clat] = tilePixelToLonLat(z, x, y, 0.5, 0.5, 1);
  const o = frame.geodeticToWorld(clat, clon, 0);
  const origin = { x: Math.round(o.x), y: Math.round(o.y) };
  const ctx = {
    z,
    x,
    y,
    frame,
    origin,
    metresPerTile: (EARTH_CIRCUMFERENCE_M * Math.cos(clat * DEG)) / 2 ** z,
  };
  const b = vt.layers.building ? buildBuildings(vt.layers.building, ctx, probe) : null;
  const roads = vt.layers.transportation ? buildRoads(vt.layers.transportation, ctx) : null;
  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return {
    z,
    x,
    y,
    origin,
    rotationDeg: frame.displayRotationDeg,
    buildings: b?.part ?? null,
    roads,
    probes: b?.probes ?? [],
    stats: {
      ms,
      bytes: bytes.byteLength,
      buildingFeatures: b?.features ?? 0,
      hidden3d: b?.hidden ?? 0,
      buildings: b?.part?.count ?? 0,
      roadSegments: roads?.segments ?? 0,
    },
  };
}

/** Typed arrays of a built tile, for postMessage transfer. */
export function transferables(result) {
  const out = [];
  for (const part of [result.buildings, result.roads]) {
    if (!part) continue;
    for (const v of Object.values(part)) if (ArrayBuffer.isView(v)) out.push(v.buffer);
  }
  return out;
}

// ---- Worker runtime --------------------------------------------------------------------------

const workerFrame = createWorldFrame();
let template = null; // { tileJson, promise }
const recentTiles = new Map(); // key → bytes (for landmark probes)
const FETCH_TIMEOUT_MS = 20000;

async function tileUrlTemplate(tileJson) {
  if (!template || template.tileJson !== tileJson) {
    const promise = fetch(tileJson, { mode: 'cors' })
      .then((r) => {
        if (!r.ok) throw new Error(`TileJSON HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        const url = j?.tiles?.[0];
        if (!url) throw new Error('TileJSON has no tile URL');
        return url;
      });
    template = { tileJson, promise };
    promise.catch(() => {
      if (template?.promise === promise) template = null;
    });
  }
  return template.promise;
}

async function loadTile(tileJson, z, x, y) {
  const key = `${z}/${x}/${y}`;
  const cached = recentTiles.get(key);
  if (cached) return cached;
  const url = (await tileUrlTemplate(tileJson)).replace('{z}', z).replace('{x}', x).replace('{y}', y);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { mode: 'cors', signal: controller.signal });
    // 204/404: no tile there (empty sea, outside coverage) — a definitive empty result.
    if (response.status === 204 || response.status === 404) return new Uint8Array(0);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    recentTiles.set(key, bytes);
    while (recentTiles.size > 4) recentTiles.delete(recentTiles.keys().next().value);
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

function frameFor(rotationDeg) {
  if (Number.isFinite(rotationDeg) && Math.abs(workerFrame.displayRotationDeg - rotationDeg) > 1e-12) {
    workerFrame.setDisplayRotation(rotationDeg);
  }
  return workerFrame;
}

function emptyResult(z, x, y, frame) {
  return { z, x, y, origin: { x: 0, y: 0 }, rotationDeg: frame.displayRotationDeg, buildings: null, roads: null, probes: [], stats: { ms: 0, bytes: 0, buildingFeatures: 0, hidden3d: 0, buildings: 0, roadSegments: 0 } };
}

if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  globalThis.onmessage = async (event) => {
    const msg = event.data;
    const { id, z, x, y } = msg;
    try {
      const frame = frameFor(msg.rotationDeg);
      const bytes = await loadTile(msg.tileJson, z, x, y);
      if (msg.type === 'probe') {
        const result = bytes.byteLength
          ? buildTile(bytes, { z, x, y, frame, probe: { lat: msg.lat, lon: msg.lon } })
          : emptyResult(z, x, y, frame);
        globalThis.postMessage({ type: 'probe', id, probes: result.probes, origin: result.origin, stats: result.stats });
        return;
      }
      const result = bytes.byteLength ? buildTile(bytes, { z, x, y, frame }) : emptyResult(z, x, y, frame);
      result.probes = [];
      globalThis.postMessage({ type: 'tile', id, result }, transferables(result));
    } catch (error) {
      globalThis.postMessage({ type: 'failed', id, error: String(error?.message || error) });
    }
  };
}
