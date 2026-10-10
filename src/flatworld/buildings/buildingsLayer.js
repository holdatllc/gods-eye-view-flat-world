/**
 * 3D buildings and roads at close zoom (real GPS domain only).
 *
 * Streams OpenFreeMap (OpenStreetMap, OpenMapTiles schema) z14 vector tiles around the camera's
 * ground focus when the camera is low, builds the geometry in workers (buildingsWorker.js) through
 * the same verified projection as everything else, and keeps a bounded LRU of tile meshes.
 *
 * Precision (floating origin): every tile's vertices are float32 metres relative to its own
 * tile-local origin (≤ ~1.5 km), and each tile mesh is placed at that origin. three.js composes
 * modelView = camera⁻¹ · model on the CPU in float64, so the GPU only ever sees camera-relative
 * transforms, the same trick the live overlay uses for its instance matrices.
 *
 * Ground: each building stands on the rendered terrain (view.chunks.heightAt at the footprint
 * centroid, which includes the relief exaggeration); building heights are scaled by the same
 * exaggeration so they stay proportional, and walls reach below the lowest ground under the
 * footprint. Roads are draped per centreline sample. When finer terrain loads under a tile, or the
 * exaggeration changes, the tile is re-based within a per-frame time budget.
 *
 * Data: © OpenStreetMap contributors (ODbL) via OpenFreeMap / OpenMapTiles.
 */
import * as THREE from 'three';
import { VECTOR_SOURCES } from '../sources/catalog.js';
import { DOMAIN_GPS } from '../projection/domains.js';

export const BUILDINGS_ZOOM = 14;
const DEG = Math.PI / 180;
const MERCATOR_MAX_LAT = 85.0511287798066;
/** Foundations reach this far (metres, before exaggeration) below the lowest sampled ground. */
const FOUNDATION_M = 2;

/** Web-Mercator tile containing lon/lat. */
export function lonLatToTile(lon, lat, z = BUILDINGS_ZOOM) {
  const n = 2 ** z;
  const r = Math.min(Math.max(lat, -MERCATOR_MAX_LAT), MERCATOR_MAX_LAT) * DEG;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return { x: ((x % n) + n) % n, y: Math.min(Math.max(y, 0), n - 1) };
}

/** Lon/lat of a fractional tile coordinate. */
export function tileToLonLat(z, fx, fy) {
  const n = 2 ** z;
  return {
    lon: (fx / n) * 360 - 180,
    lat: Math.atan(Math.sinh(Math.PI * (1 - (2 * fy) / n))) / DEG,
  };
}

const key = (z, x, y) => `${z}/${x}/${y}`;

/**
 * Height sampler equivalent to `chunks.heightAt` for points near bbox `b`: the same choice of the
 * finest loaded terrain chunk and the same bilinear interpolation of its rendered (exaggerated)
 * vertex heights, but the candidate chunks are found once per tile instead of per call. Points no
 * candidate covers (and unexpected chunk layouts) fall back to `chunks.heightAt` itself.
 */
export function makeHeightSampler(chunks, b) {
  const fallback = (x, y) => chunks.heightAt(x, y);
  if (!(chunks.chunks instanceof Map)) return fallback;
  const list = [];
  for (const c of chunks.chunks.values()) {
    const size = c.data?.size;
    if (!(size > 0) || !(c.data.grid > 0) || !c.mesh || !Number.isFinite(c.x0)) return fallback;
    if (c.x0 > b.maxX || c.x0 + size <= b.minX || c.y0 > b.maxY || c.y0 + size <= b.minY) continue;
    list.push(c);
  }
  list.sort((p, q) => q.level - p.level);
  return (x, y) => {
    for (const c of list) {
      const { grid, size } = c.data;
      if (x < c.x0 || y < c.y0 || x >= c.x0 + size || y >= c.y0 + size) continue;
      const step = size / grid;
      const fx = Math.min(Math.max((x - c.x0) / step, 0), grid);
      const fy = Math.min(Math.max((y - c.y0) / step, 0), grid);
      const i0 = Math.min(Math.floor(fx), grid - 1);
      const j0 = Math.min(Math.floor(fy), grid - 1);
      const u = fx - i0;
      const v = fy - j0;
      const pos = c.mesh.geometry.attributes.position.array;
      const row = grid + 1;
      const h00 = pos[(j0 * row + i0) * 3 + 1];
      const h10 = pos[(j0 * row + i0 + 1) * 3 + 1];
      const h01 = pos[((j0 + 1) * row + i0) * 3 + 1];
      const h11 = pos[((j0 + 1) * row + i0 + 1) * 3 + 1];
      return (h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v;
    }
    return chunks.heightAt(x, y);
  };
}

export class BuildingsLayer {
  /**
   * @param {object} options
   * @param {object} options.frame the shared world frame (createWorldFrame())
   * @param {number} [options.maxTiles=120] LRU cache bound (tiles with geometry or known empty)
   * @param {number} [options.maxActiveTiles=64] tiles wanted at once around the focus
   * @param {number} [options.maxAltitude=25000] display metres above ground; higher → hidden
   * @param {number} [options.maxCacheMB=420] GPU memory bound for the cache (estimate)
   */
  constructor({
    frame,
    source = VECTOR_SOURCES.openfreemap,
    maxTiles = 120,
    maxActiveTiles = 64,
    maxAltitude = 25000,
    maxCacheMB = 420,
    workerCount = 2,
  } = {}) {
    this.frame = frame;
    this.source = source;
    this.maxTiles = maxTiles;
    this.maxActiveTiles = maxActiveTiles;
    this.maxAltitude = maxAltitude;
    this.maxCacheBytes = maxCacheMB * 1048576;
    this.workerCount = workerCount;
    this.maxInflightPerWorker = 3;
    /** Distances (camera → tile, display metres) where smaller building / road classes drop out. */
    this.lod = { buildings: [3500, 7500], roads: [2500, 6000] };
    this.rebaseBudgetMs = 4;
    this.group = new THREE.Group();
    this.group.name = 'flatworld-buildings';
    this.buildingMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
    this.roadMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    this.tiles = new Map(); // key → tile record
    this.boundsCache = new Map(); // key → display bbox of the tile
    this.workers = [];
    this.jobs = new Map();
    this.nextId = 1;
    this.arrivals = [];
    this.frameNo = 0;
    this.active = false;
    this._enabled = true;
    this._rotation = frame.displayRotationDeg;
    this._sigCursor = 0;
    this.totals = { requested: 0, built: 0, failed: 0, evicted: 0, bytes: 0, decodeMs: 0, rebases: 0, rebaseMs: 0 };
  }

  get enabled() {
    return this._enabled;
  }

  set enabled(value) {
    this._enabled = Boolean(value);
    if (!this._enabled) {
      this.group.visible = false;
      this._dropQueued(new Set());
    }
  }

  attach(view) {
    this.view = view;
    view.scene.add(this.group);
  }

  _ensureWorkers() {
    if (this.workers.length) return;
    for (let i = 0; i < this.workerCount; i += 1) {
      const worker = new Worker(new URL('./buildingsWorker.js', import.meta.url), { type: 'module' });
      worker.busy = 0;
      worker.onmessage = (e) => this._onMessage(worker, e.data);
      worker.onerror = (e) => console.warn('[FlatWorld] buildings worker error', e.message);
      this.workers.push(worker);
    }
  }

  _onMessage(worker, msg) {
    const job = this.jobs.get(msg.id);
    if (!job) return;
    this.jobs.delete(msg.id);
    worker.busy -= 1;
    if (job.resolve) {
      if (msg.type === 'failed') job.reject(new Error(msg.error));
      else job.resolve(msg);
      return;
    }
    const rec = this.tiles.get(job.key);
    if (!rec || rec.state !== 'loading') return;
    if (msg.type === 'failed') {
      this.totals.failed += 1;
      rec.state = 'failed';
      rec.retryAt = performance.now() + 15000;
      console.warn('[FlatWorld] buildings tile failed', job.key, msg.error);
      return;
    }
    if (Math.abs(msg.result.rotationDeg - this.frame.displayRotationDeg) > 1e-9) {
      this.tiles.delete(job.key); // built for an old display rotation
      return;
    }
    this.arrivals.push({ rec, result: msg.result });
  }

  _post(worker, msg) {
    const id = this.nextId++;
    worker.busy += 1;
    worker.postMessage({
      ...msg,
      id,
      tileJson: this.source.tileJson,
      rotationDeg: this.frame.displayRotationDeg,
    });
    return id;
  }

  /** Display-frame bbox of a z14 tile (corners, edge midpoints and centre; AEQD bends edges). */
  _tileBounds(z, x, y) {
    const k = key(z, x, y);
    let b = this.boundsCache.get(k);
    if (b) return b;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const fy of [0, 0.5, 1]) {
      for (const fx of [0, 0.5, 1]) {
        const ll = tileToLonLat(z, x + fx, y + fy);
        const w = this.frame.geodeticToWorld(ll.lat, ll.lon, 0);
        if (!w) continue;
        minX = Math.min(minX, w.x);
        minY = Math.min(minY, w.y);
        maxX = Math.max(maxX, w.x);
        maxY = Math.max(maxY, w.y);
      }
    }
    const m = 20 + (maxX - minX) * 0.01;
    b = { minX: minX - m, minY: minY - m, maxX: maxX + m, maxY: maxY + m };
    if (this.boundsCache.size > 4000) this.boundsCache.clear();
    this.boundsCache.set(k, b);
    return b;
  }

  /** Tiles to show around the focus, nearest first. */
  _select(view) {
    const f = view.focus;
    const e = view.chunks.exaggeration;
    const cam = view.camera.position;
    const alt = Math.max(f.altitude, 1);
    const radius = Math.min(Math.max(alt * 4 + 1500, 2500), 9000);
    const lat = f.domain.lat;
    const lon = f.domain.lon;
    const z = BUILDINGS_ZOOM;
    const n = 2 ** z;
    const center = lonLatToTile(lon, lat, z);
    const tileM = (40075016.686 * Math.cos(Math.min(Math.abs(lat), MERCATOR_MAX_LAT) * DEG)) / n;
    const span = Math.min(Math.ceil(radius / Math.max(tileM, 1)) + 1, 12);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(view.camera.projectionMatrix, view.camera.matrixWorldInverse),
    );
    const box = new THREE.Box3();
    const picked = [];
    for (let dy = -span; dy <= span; dy += 1) {
      const ty = center.y + dy;
      if (ty < 0 || ty >= n) continue;
      for (let dx = -span; dx <= span; dx += 1) {
        const tx = (((center.x + dx) % n) + n) % n;
        const b = this._tileBounds(z, tx, ty);
        const gx = Math.max(b.minX - f.x, 0, f.x - b.maxX);
        const gy = Math.max(b.minY - f.y, 0, f.y - b.maxY);
        const focusDist = Math.hypot(gx, gy);
        if (focusDist > radius) continue;
        const rec = this.tiles.get(key(z, tx, ty));
        const lo = rec?.minY ?? f.ground - 200 * e;
        const hi = rec?.maxY ?? f.ground + 600 * e;
        const cx = Math.max(b.minX - cam.x, 0, cam.x - b.maxX);
        const cy = Math.max(b.minY + cam.z, 0, -cam.z - b.maxY);
        const cz = Math.max(lo - cam.y, 0, cam.y - hi);
        const dist = Math.hypot(cx, cy, cz);
        if (focusDist > 1200 && dist > 1500) {
          box.min.set(b.minX, lo, -b.maxY);
          box.max.set(b.maxX, hi, -b.minY);
          if (!frustum.intersectsBox(box)) continue;
        }
        picked.push({ z, x: tx, y: ty, dist });
      }
    }
    picked.sort((a, b) => a.dist - b.dist);
    return picked.slice(0, this.maxActiveTiles);
  }

  _dropQueued(wanted) {
    for (const [k, rec] of this.tiles) {
      if (rec.state === 'queued' && !wanted.has(k)) this.tiles.delete(k);
    }
  }

  _dispatch() {
    const queued = [...this.tiles.values()].filter((r) => r.state === 'queued').sort((a, b) => a.dist - b.dist);
    for (const rec of queued) {
      const worker = this.workers.reduce((best, w) => (!best || w.busy < best.busy ? w : best), null);
      if (!worker || worker.busy >= this.maxInflightPerWorker) break;
      const id = this._post(worker, { type: 'tile', z: rec.z, x: rec.x, y: rec.y });
      this.jobs.set(id, { key: rec.key });
      rec.state = 'loading';
      this.totals.requested += 1;
    }
  }

  _createPart(part, material, origin, { cast }) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(part.position, 3));
    const normal = new THREE.BufferAttribute(part.normal, 3, true);
    const color = new THREE.BufferAttribute(part.color, 3, true);
    const index = new THREE.BufferAttribute(part.index, 1);
    // Normals, colours and indices are never touched again: free their CPU copies once uploaded.
    for (const attr of [normal, color, index]) {
      attr.onUpload(function release() {
        this.array = null;
      });
    }
    g.setAttribute('normal', normal);
    g.setAttribute('color', color);
    g.setIndex(index);
    const mesh = new THREE.Mesh(g, material);
    mesh.position.set(origin.x, 0, -origin.y);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.visible = false;
    const gpuBytes = part.position.byteLength + part.normal.byteLength + part.color.byteLength + part.index.byteLength;
    return { mesh, gpuBytes, indexCount: part.index.length };
  }

  _install({ rec, result }) {
    this.totals.built += 1;
    this.totals.bytes += result.stats.bytes;
    this.totals.decodeMs += result.stats.ms;
    rec.stats = result.stats;
    rec.origin = result.origin;
    rec.state = 'ready';
    rec.gpuBytes = 0;
    rec.cpuBytes = 0;
    const b = result.buildings;
    const r = result.roads;
    if (b) {
      const p = this._createPart(b, this.buildingMaterial, rec.origin, { cast: true });
      rec.b = { ...p, rel: b.rel, foot: b.foot, samples: b.samples, vstart: b.vstart, lod: b.lod, count: b.count, bounds: b.bounds };
      rec.gpuBytes += p.gpuBytes;
      rec.cpuBytes += b.position.byteLength + b.rel.byteLength + b.foot.byteLength + b.samples.byteLength + b.vstart.byteLength;
      this.group.add(p.mesh);
    }
    if (r) {
      const p = this._createPart(r, this.roadMaterial, rec.origin, { cast: false });
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < r.samples.length; i += 3) {
        minX = Math.min(minX, r.samples[i]);
        maxX = Math.max(maxX, r.samples[i]);
        minY = Math.min(minY, r.samples[i + 1]);
        maxY = Math.max(maxY, r.samples[i + 1]);
      }
      rec.r = { ...p, samples: r.samples, lod: r.lod, segments: r.segments, bounds: { minX: minX - 10, minY: minY - 10, maxX: maxX + 10, maxY: maxY + 10 } };
      rec.gpuBytes += p.gpuBytes;
      rec.cpuBytes += r.position.byteLength + r.samples.byteLength;
      this.group.add(p.mesh);
    }
    if (!b && !r) rec.state = 'empty';
    rec.based = false;
    rec.signature = null;
  }

  /** Terrain signature under a tile: the finest loaded terrain level at a 3×3 grid + relief. */
  _signature(rec, chunks) {
    const b = this._tileBounds(rec.z, rec.x, rec.y);
    let s = `${chunks.exaggeration}|${chunks.drain}`;
    for (const fy of [0.1, 0.5, 0.9]) {
      for (const fx of [0.1, 0.5, 0.9]) {
        s += `|${chunks.levelAt(b.minX + (b.maxX - b.minX) * fx, b.minY + (b.maxY - b.minY) * fy)}`;
      }
    }
    return s;
  }

  /** Place a tile's buildings and roads on the currently rendered terrain. */
  _rebase(rec, view) {
    const t0 = performance.now();
    const chunks = view.chunks;
    const e = chunks.exaggeration;
    const fallback = view.focus?.ground ?? 0;
    const ox = rec.origin.x;
    const oy = rec.origin.y;
    const heightAt = makeHeightSampler(chunks, this._tileBounds(rec.z, rec.x, rec.y));
    let minY = Infinity;
    let maxY = -Infinity;
    if (rec.b) {
      const { samples, vstart, rel, foot } = rec.b;
      const attr = rec.b.mesh.geometry.attributes.position;
      const pos = attr.array;
      const n = vstart.length - 1;
      for (let s = 0; s < n; s += 1) {
        const o6 = s * 6;
        const base = heightAt(ox + samples[o6], oy + samples[o6 + 1]) ?? fallback;
        let low = base;
        const x0 = samples[o6 + 2];
        const y0 = samples[o6 + 3];
        const x1 = samples[o6 + 4];
        const y1 = samples[o6 + 5];
        // Larger footprints also sample their bbox corners so foundations reach the lowest ground.
        if (x1 - x0 + (y1 - y0) > 24) {
          for (const [cx, cy] of [
            [x0, y0],
            [x1, y0],
            [x0, y1],
            [x1, y1],
          ]) {
            const h = heightAt(ox + cx, oy + cy);
            if (h !== null && h < low) low = h;
          }
        }
        const footY = low - FOUNDATION_M * e;
        for (let v = vstart[s], end = vstart[s + 1]; v < end; v += 1) {
          const y = foot[v] ? footY : base + rel[v] * e;
          pos[v * 3 + 1] = y;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      attr.needsUpdate = true;
      this._setBounds(rec.b.mesh.geometry, rec.b.bounds, minY, maxY);
    }
    if (rec.r) {
      const { samples } = rec.r;
      const attr = rec.r.mesh.geometry.attributes.position;
      const pos = attr.array;
      let rMin = Infinity;
      let rMax = -Infinity;
      for (let s = 0, n = samples.length / 3; s < n; s += 1) {
        const base = heightAt(ox + samples[s * 3], oy + samples[s * 3 + 1]) ?? fallback;
        const y = base + samples[s * 3 + 2] * e;
        pos[s * 6 + 1] = y;
        pos[s * 6 + 4] = y;
        if (y < rMin) rMin = y;
        if (y > rMax) rMax = y;
      }
      attr.needsUpdate = true;
      this._setBounds(rec.r.mesh.geometry, rec.r.bounds, rMin, rMax + 10 * Math.max(e, 1));
      minY = Math.min(minY, rMin);
      maxY = Math.max(maxY, rMax);
    }
    rec.minY = Number.isFinite(minY) ? minY : undefined;
    rec.maxY = Number.isFinite(maxY) ? maxY : undefined;
    rec.based = true;
    rec.basedAt = performance.now();
    this.totals.rebases += 1;
    this.totals.rebaseMs += performance.now() - t0;
  }

  _setBounds(geometry, b, minY, maxY) {
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(b.minX, minY, -b.maxY), new THREE.Vector3(b.maxX, maxY, -b.minY));
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
  }

  _disposeTile(rec) {
    for (const part of [rec.b, rec.r]) {
      if (!part) continue;
      this.group.remove(part.mesh);
      part.mesh.geometry.dispose();
    }
    rec.b = null;
    rec.r = null;
  }

  _evict(wanted) {
    let bytes = 0;
    for (const rec of this.tiles.values()) bytes += rec.gpuBytes || 0;
    const settled = [...this.tiles.values()]
      .filter((r) => (r.state === 'ready' || r.state === 'empty' || r.state === 'failed') && !wanted.has(r.key))
      .sort((a, b) => a.lastWanted - b.lastWanted);
    let count = [...this.tiles.values()].filter((r) => r.state !== 'queued').length;
    for (const rec of settled) {
      if (count <= this.maxTiles && bytes <= this.maxCacheBytes) break;
      bytes -= rec.gpuBytes || 0;
      this._disposeTile(rec);
      this.tiles.delete(rec.key);
      this.totals.evicted += 1;
      count -= 1;
    }
  }

  clear() {
    for (const rec of this.tiles.values()) this._disposeTile(rec);
    this.tiles.clear();
    this.arrivals.length = 0;
    this.boundsCache.clear();
  }

  update(dt, view) {
    this.frameNo += 1;
    if (Math.abs(this.frame.displayRotationDeg - this._rotation) > 1e-9) {
      this._rotation = this.frame.displayRotationDeg;
      this.clear();
    }
    const f = view.focus;
    this.active = Boolean(
      this._enabled && f && f.domain?.domain === DOMAIN_GPS && f.altitude < this.maxAltitude,
    );
    this.group.visible = this.active;
    if (!this.active) {
      this._dropQueued(new Set());
      return;
    }
    this._ensureWorkers();

    // 1. Selection and requests.
    const picked = this._select(view);
    const wanted = new Map();
    const now = performance.now();
    for (const t of picked) {
      const k = key(t.z, t.x, t.y);
      let rec = this.tiles.get(k);
      if (!rec) {
        rec = { key: k, z: t.z, x: t.x, y: t.y, state: 'queued' };
        this.tiles.set(k, rec);
      } else if (rec.state === 'failed' && now > rec.retryAt) rec.state = 'queued';
      rec.lastWanted = this.frameNo;
      rec.dist = t.dist;
      wanted.set(k, rec);
    }
    this._dropQueued(wanted);
    this._dispatch();

    // 2. Install arrived tiles (bounded per frame) and place them on the terrain.
    const t0 = performance.now();
    while (this.arrivals.length && performance.now() - t0 < 6) {
      const a = this.arrivals.shift();
      if (this.tiles.get(a.rec.key) !== a.rec) continue;
      this._install(a);
    }
    const chunks = view.chunks;
    const ready = picked.map((t) => this.tiles.get(key(t.z, t.x, t.y))).filter((r) => r?.state === 'ready');
    // Re-check terrain signatures round-robin (a few tiles per frame).
    for (let i = 0; i < Math.min(8, ready.length); i += 1) {
      const rec = ready[(this._sigCursor + i) % ready.length];
      const sig = this._signature(rec, chunks);
      if (sig !== rec.signature) {
        rec.signature = sig;
        rec.dirty = true;
        rec.sigAt = now;
      }
    }
    this._sigCursor = (this._sigCursor + 8) % Math.max(ready.length, 1);
    // Terrain refines in bursts: re-base once the signature has been stable for a moment (or at
    // least every few seconds while it keeps changing).
    const todo = ready
      .filter((r) => !r.based || (r.dirty && (now - r.sigAt > 700 || now - r.basedAt > 4000)))
      .sort((a, b) => a.based - b.based || a.dist - b.dist);
    const t1 = performance.now();
    for (const rec of todo) {
      if (performance.now() - t1 > this.rebaseBudgetMs && rec !== todo[0]) break;
      if (!rec.signature) rec.signature = this._signature(rec, chunks);
      this._rebase(rec, view);
      rec.dirty = false;
    }

    // 3. Visibility and level of detail.
    const e = chunks.exaggeration;
    for (const rec of this.tiles.values()) {
      const show = wanted.has(rec.key) && rec.based;
      if (rec.b) {
        rec.b.mesh.visible = show;
        if (show) {
          const [near, mid] = this.lod.buildings;
          const lod = rec.dist < near ? 2 : rec.dist < mid ? 1 : 0;
          rec.b.mesh.geometry.setDrawRange(0, rec.b.lod[lod]);
          rec.b.mesh.visible = rec.b.lod[lod] > 0;
        }
      }
      if (rec.r) {
        rec.r.mesh.visible = show;
        if (show) {
          const [near, mid] = this.lod.roads;
          const lod = rec.dist < near ? 2 : rec.dist < mid ? 1 : 0;
          rec.r.mesh.geometry.setDrawRange(0, rec.r.lod[lod]);
          rec.r.mesh.visible = rec.r.lod[lod] > 0;
          // Lift ribbons a little more with distance so coarser far terrain never covers them.
          rec.r.mesh.position.y = (0.35 + rec.dist * 3e-4) * Math.max(1, e);
          rec.r.mesh.updateMatrix();
        }
      }
    }
    this._evict(wanted);
    this._wanted = wanted;
  }

  /** Counts and memory for diagnostics. */
  stats() {
    let loaded = 0;
    let empty = 0;
    let pending = 0;
    let failed = 0;
    let visible = 0;
    let buildings = 0;
    let buildingsLoaded = 0;
    let triangles = 0;
    let trianglesLoaded = 0;
    let roadSegments = 0;
    let gpu = 0;
    let cpu = 0;
    for (const rec of this.tiles.values()) {
      if (rec.state === 'ready') loaded += 1;
      else if (rec.state === 'empty') empty += 1;
      else if (rec.state === 'failed') failed += 1;
      else pending += 1;
      gpu += rec.gpuBytes || 0;
      cpu += rec.cpuBytes || 0;
      const shown = rec.b?.mesh.visible || rec.r?.mesh.visible;
      if (rec.b) {
        buildingsLoaded += rec.b.count;
        trianglesLoaded += rec.b.indexCount / 3;
      }
      if (rec.r) trianglesLoaded += rec.r.indexCount / 3;
      if (shown) {
        visible += 1;
        if (rec.b?.mesh.visible) {
          triangles += rec.b.mesh.geometry.drawRange.count / 3;
          buildings += rec.b.count;
        }
        if (rec.r?.mesh.visible) {
          triangles += rec.r.mesh.geometry.drawRange.count / 3;
          roadSegments += rec.r.segments;
        }
      }
    }
    const t = this.totals;
    return {
      enabled: this._enabled,
      active: this.active,
      tilesLoaded: loaded,
      tilesEmpty: empty,
      tilesPending: pending,
      tilesFailed: failed,
      tilesVisible: visible,
      cacheLimit: this.maxTiles,
      buildingsVisibleTiles: buildings,
      buildingsLoaded,
      roadSegmentsVisible: roadSegments,
      trianglesDrawn: Math.round(triangles),
      trianglesLoaded: Math.round(trianglesLoaded),
      gpuMemoryMB: gpu / 1048576,
      cpuMemoryMB: cpu / 1048576,
      memoryMB: (gpu + cpu) / 1048576,
      downloadedMB: t.bytes / 1048576,
      tilesBuilt: t.built,
      tilesEvicted: t.evicted,
      decodeMsAvg: t.built ? t.decodeMs / t.built : null,
      rebases: t.rebases,
      rebaseMsAvg: t.rebases ? t.rebaseMs / t.rebases : null,
    };
  }

  /**
   * Prove a landmark sits where its source coordinates say: decode the footprint(s) containing
   * (lat, lon) from the z14 tile, round-trip the footprint centroid through the projection and
   * frame.worldToDomain, and check every rendered roof vertex in the GPU buffer (float32, tile
   * local + float64 origin) inverts back to its source lat/lon.
   */
  async verifyLandmark({ lat, lon, name = 'landmark' }) {
    this._ensureWorkers();
    const t = lonLatToTile(lon, lat);
    const k = key(BUILDINGS_ZOOM, t.x, t.y);
    const worker = this.workers[0];
    const msg = await new Promise((resolve, reject) => {
      const id = this._post(worker, { type: 'probe', z: BUILDINGS_ZOOM, x: t.x, y: t.y, lat, lon });
      this.jobs.set(id, { resolve, reject });
    });
    const rec = this.tiles.get(k);
    const e = this.view?.chunks.exaggeration ?? 1;
    const out = { name, tile: k, reference: { lat, lon }, tileLoaded: rec?.state === 'ready', footprints: [] };
    for (const p of msg.probes) {
      const w = this.frame.geodeticToWorld(p.centroid.lat, p.centroid.lon, 0);
      const back = this.frame.worldToDomain(w.x, w.y, 0);
      const mLat = 111132.954 - 559.822 * Math.cos(2 * lat * DEG);
      const mLon = 111412.84 * Math.cos(lat * DEG);
      const r = {
        featureId: p.featureId,
        osmWayId: Math.floor(Number(p.featureId) / 10),
        hide3d: p.hidden,
        renderMinHeight: p.renderMinHeight,
        renderHeight: p.renderHeight,
        centroid: p.centroid,
        centroidDisplay: { x: w.x, y: w.y },
        workerVsMainDisplayM: Math.hypot(w.x - p.centroidDisplay.x, w.y - p.centroidDisplay.y),
        roundTrip: {
          domain: back.domain,
          lat: back.lat,
          lon: back.lon,
          dLatDeg: Math.abs(back.lat - p.centroid.lat),
          dLonDeg: Math.abs(back.lon - p.centroid.lon),
        },
        centroidToReferenceM: Math.hypot((p.centroid.lat - lat) * mLat, (p.centroid.lon - lon) * mLon),
      };
      if (!p.hidden && rec?.b && Number.isInteger(p.roofStart)) {
        const pos = rec.b.mesh.geometry.attributes.position.array;
        let maxLat = 0;
        let maxLon = 0;
        let sx = 0;
        let sy = 0;
        let roofY = 0;
        for (let i = 0; i < p.roofCount; i += 1) {
          const v = p.roofStart + i;
          const x = rec.origin.x + pos[v * 3];
          const y = rec.origin.y - pos[v * 3 + 2];
          sx += x;
          sy += y;
          roofY += pos[v * 3 + 1];
          const d = this.frame.worldToDomain(x, y, 0);
          maxLat = Math.max(maxLat, Math.abs(d.lat - p.roofLatLon[i][0]));
          maxLon = Math.max(maxLon, Math.abs(d.lon - p.roofLatLon[i][1]));
        }
        const s = rec.b.samples;
        const base = this.view?.chunks.heightAt(rec.origin.x + s[p.sampleIndex * 6], rec.origin.y + s[p.sampleIndex * 6 + 1]);
        r.gpuBuffer = {
          roofVertices: p.roofCount,
          maxVertexLatErrDeg: maxLat,
          maxVertexLonErrDeg: maxLon,
          roofCentroidDisplay: { x: sx / p.roofCount, y: sy / p.roofCount },
          roofCentroidToProjectedCentroidM: Math.hypot(sx / p.roofCount - w.x, sy / p.roofCount - w.y),
          roofAboveGroundM: base == null ? null : (roofY / p.roofCount - base) / e,
        };
      }
      out.footprints.push(r);
    }
    return out;
  }

  destroy() {
    this.clear();
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.group.removeFromParent();
    this.buildingMaterial.dispose();
    this.roadMaterial.dispose();
  }
}
