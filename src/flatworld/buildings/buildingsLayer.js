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
 * footprint. Roads are draped per centreline sample. The vertex shader draws
 * y = aGround + y · exaggeration, so the CPU keeps only the per-vertex ground (`aGround`, 4 bytes)
 * and frees every other vertex array once it is on the GPU. When finer terrain loads under a tile,
 * or the exaggeration changes, the tile's ground is re-sampled within a per-frame time budget.
 *
 * Data: © OpenStreetMap contributors (ODbL) via OpenFreeMap / OpenMapTiles.
 */
import * as THREE from 'three';
import { VECTOR_SOURCES } from '../sources/catalog.js';
import { DOMAIN_GPS } from '../projection/domains.js';

export const BUILDINGS_ZOOM = 14;
const DEG = Math.PI / 180;
const MERCATOR_MAX_LAT = 85.0511287798066;

/**
 * Make a material draw y = aGround + y · uExaggeration (shared uniform). Applied to the colour
 * materials and to the shadow depth material so shadows match the drawn geometry.
 */
function grounded(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uExaggeration = uniforms.uExaggeration;
    shader.vertexShader = `attribute float aGround;\nuniform float uExaggeration;\n${shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  transformed.y = aGround + transformed.y * uExaggeration;',
    )}`;
  };
  material.customProgramCacheKey = () => 'flatworld-grounded';
  return material;
}

function releaseArray() {
  this.array = null;
}

/** Web-Mercator tile containing lon/lat. */
export function lonLatToTile(lon, lat, z = BUILDINGS_ZOOM) {
  const n = 2 ** z;
  const r = Math.min(Math.max(lat, -MERCATOR_MAX_LAT), MERCATOR_MAX_LAT) * DEG;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n,
  );
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

/** Tile key; far-detail builds of a tile ('f') are cached separately from the full build. */
const key = (z, x, y, v = 'n') =>
  v === 'f' ? `${z}/${x}/${y}/f` : `${z}/${x}/${y}`;

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
    if (!(size > 0) || !(c.data.grid > 0) || !c.mesh || !Number.isFinite(c.x0))
      return fallback;
    if (
      c.x0 > b.maxX ||
      c.x0 + size <= b.minX ||
      c.y0 > b.maxY ||
      c.y0 + size <= b.minY
    )
      continue;
    list.push(c);
  }
  list.sort((p, q) => q.level - p.level);
  return (x, y) => {
    for (const c of list) {
      const { grid, size } = c.data;
      if (x < c.x0 || y < c.y0 || x >= c.x0 + size || y >= c.y0 + size)
        continue;
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
      return (
        (h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v
      );
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
   * @param {number} [options.maxCacheMB=320] GPU memory bound for the cache (estimate)
   * @param {boolean} [options.far=true] far detail: tall and very large buildings only, from the
   *   edge of the full-detail area out to `farRadius`, and up to `farMaxAltitude`
   * @param {number} [options.farRadius=32000] display metres from the focus
   * @param {number} [options.farMaxAltitude=80000] display metres above ground
   * @param {number} [options.maxFarTiles=180] far-detail tiles wanted at once
   */
  constructor({
    frame,
    source = VECTOR_SOURCES.openfreemap,
    maxTiles = 320,
    maxActiveTiles = 64,
    maxAltitude = 25000,
    maxCacheMB = 320,
    workerCount = 2,
    far = true,
    farRadius = 32000,
    farMaxAltitude = 80000,
    maxFarTiles = 180,
  } = {}) {
    this.frame = frame;
    this.source = source;
    this.maxTiles = maxTiles;
    this.maxActiveTiles = maxActiveTiles;
    this.maxAltitude = maxAltitude;
    this._far = Boolean(far);
    this.farRadius = farRadius;
    this.farMaxAltitude = farMaxAltitude;
    this.maxFarTiles = maxFarTiles;
    this.maxCacheBytes = maxCacheMB * 1048576;
    this.workerCount = workerCount;
    this.maxInflightPerWorker = 3;
    /** Distances (camera → tile, display metres) where smaller building / road classes drop out. */
    this.lod = { buildings: [3500, 7500], roads: [2500, 6000] };
    this.rebaseBudgetMs = 4;
    this.group = new THREE.Group();
    this.group.name = 'flatworld-buildings';
    this.uniforms = { uExaggeration: { value: 1 } };
    this.buildingMaterial = grounded(
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.82,
        metalness: 0,
      }),
      this.uniforms,
    );
    this.roadMaterial = grounded(
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.95,
        metalness: 0,
      }),
      this.uniforms,
    );
    this.depthMaterial = grounded(new THREE.MeshDepthMaterial(), this.uniforms);
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
    this._chunkIds = new WeakMap(); // terrain chunk → small id (signatures)
    this._nextChunkId = 1;
    this.totals = {
      requested: 0,
      built: 0,
      failed: 0,
      evicted: 0,
      bytes: 0,
      decodeMs: 0,
      rebases: 0,
      rebaseMs: 0,
    };
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

  /** Far detail on/off (tall and very large buildings out to the horizon). */
  get far() {
    return this._far;
  }

  set far(value) {
    this._far = Boolean(value);
    if (!this._far) this._dropQueued(this._wanted ?? new Map());
  }

  attach(view) {
    this.view = view;
    view.scene.add(this.group);
  }

  _ensureWorkers() {
    if (this.workers.length) return;
    for (let i = 0; i < this.workerCount; i += 1) {
      const worker = new Worker(
        new URL('./buildingsWorker.js', import.meta.url),
        { type: 'module' },
      );
      worker.busy = 0;
      worker.onmessage = (e) => this._onMessage(worker, e.data);
      worker.onerror = (e) =>
        console.warn('[FlatWorld] buildings worker error', e.message);
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
      rec.retryAt = performance.now() + 6000;
      console.warn('[FlatWorld] buildings tile failed', job.key, msg.error);
      return;
    }
    if (
      Math.abs(msg.result.rotationDeg - this.frame.displayRotationDeg) > 1e-9
    ) {
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

  /**
   * Tiles to show around the focus, nearest first, each with its detail: 'n' (every building and
   * road) inside the near radius, 'f' (tall and very large buildings only) out to the far radius.
   */
  _select(view) {
    const f = view.focus;
    const e = view.chunks.exaggeration;
    const cam = view.camera.position;
    const alt = Math.max(f.altitude, 1);
    const nearRadius =
      alt < this.maxAltitude
        ? Math.min(Math.max(alt * 4 + 1500, 2500), 9000)
        : 0;
    const farRadius =
      this._far && alt < this.farMaxAltitude
        ? Math.min(
            Math.max(alt * 2.5 + 12000, nearRadius + 3000),
            this.farRadius,
          )
        : 0;
    const radius = Math.max(nearRadius, farRadius);
    const lat = f.domain.lat;
    const lon = f.domain.lon;
    const z = BUILDINGS_ZOOM;
    const n = 2 ** z;
    const center = lonLatToTile(lon, lat, z);
    const tileM =
      (40075016.686 *
        Math.cos(Math.min(Math.abs(lat), MERCATOR_MAX_LAT) * DEG)) /
      n;
    const span = Math.min(Math.ceil(radius / Math.max(tileM, 1)) + 1, 24);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(
        view.camera.projectionMatrix,
        view.camera.matrixWorldInverse,
      ),
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
        const v = focusDist <= nearRadius ? 'n' : 'f';
        const rec =
          this.tiles.get(key(z, tx, ty, v)) ??
          this.tiles.get(key(z, tx, ty, v === 'n' ? 'f' : 'n'));
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
        picked.push({ z, x: tx, y: ty, v, dist });
      }
    }
    picked.sort((a, b) => a.dist - b.dist);
    // Near tiles past the full-detail budget fall back to far detail; far detail has its own budget.
    const out = [];
    let nNear = 0;
    let nFar = 0;
    for (const t of picked) {
      if (t.v === 'n' && nNear >= this.maxActiveTiles) {
        if (!this._far) continue;
        t.v = 'f';
      }
      if (t.v === 'n') nNear += 1;
      else if (nFar < this.maxFarTiles) nFar += 1;
      else continue;
      out.push(t);
    }
    return out;
  }

  _dropQueued(wanted) {
    for (const [k, rec] of this.tiles) {
      if (rec.state === 'queued' && !wanted.has(k)) this.tiles.delete(k);
    }
  }

  _dispatch() {
    // Full detail first (it is what the camera is close to), then far detail, nearest first.
    const queued = [...this.tiles.values()]
      .filter((r) => r.state === 'queued')
      .sort((a, b) => (a.v === 'f') - (b.v === 'f') || a.dist - b.dist);
    for (const rec of queued) {
      const worker = this.workers.reduce(
        (best, w) => (!best || w.busy < best.busy ? w : best),
        null,
      );
      if (!worker || worker.busy >= this.maxInflightPerWorker) break;
      const id = this._post(worker, {
        type: 'tile',
        z: rec.z,
        x: rec.x,
        y: rec.y,
        far: rec.v === 'f',
      });
      this.jobs.set(id, { key: rec.key });
      rec.state = 'loading';
      this.totals.requested += 1;
    }
  }

  _createPart(part, material, origin, { cast }) {
    const g = new THREE.BufferGeometry();
    const vertexCount = part.position.length / 3;
    const groundY = new THREE.BufferAttribute(new Float32Array(vertexCount), 1);
    groundY.setUsage(THREE.DynamicDrawUsage);
    const attrs = {
      position: new THREE.BufferAttribute(part.position, 3),
      normal: new THREE.BufferAttribute(part.normal, 3, true),
      color: new THREE.BufferAttribute(part.color, 3, true),
    };
    const index = new THREE.BufferAttribute(part.index, 1);
    // Only aGround changes after upload: free the CPU copies of everything else once on the GPU.
    for (const attr of [...Object.values(attrs), index])
      attr.onUpload(releaseArray);
    for (const [name, attr] of Object.entries(attrs))
      g.setAttribute(name, attr);
    g.setAttribute('aGround', groundY);
    g.setIndex(index);
    const mesh = new THREE.Mesh(g, material);
    mesh.position.set(origin.x, 0, -origin.y);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    if (cast) mesh.customDepthMaterial = this.depthMaterial;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.visible = false;
    const gpuBytes =
      part.position.byteLength +
      part.normal.byteLength +
      part.color.byteLength +
      part.index.byteLength +
      vertexCount * 4;
    return { mesh, ground: groundY, gpuBytes, indexCount: part.index.length };
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
      // Far-detail tiles do not cast shadows: they are kilometres away, and it halves their cost.
      const p = this._createPart(b, this.buildingMaterial, rec.origin, {
        cast: rec.v !== 'f',
      });
      rec.b = {
        ...p,
        samples: b.samples,
        vstart: b.vstart,
        wallStart: b.wallStart,
        groundLevel: b.ground,
        lod: b.lod,
        count: b.count,
        bounds: b.bounds,
      };
      rec.gpuBytes += p.gpuBytes;
      rec.cpuBytes +=
        p.ground.array.byteLength +
        b.samples.byteLength +
        b.vstart.byteLength +
        b.wallStart.byteLength +
        b.ground.byteLength;
      this.group.add(p.mesh);
    }
    if (r) {
      const p = this._createPart(r, this.roadMaterial, rec.origin, {
        cast: false,
      });
      rec.r = {
        ...p,
        samples: r.samples,
        lod: r.lod,
        segments: r.segments,
        bounds: r.bounds,
      };
      rec.gpuBytes += p.gpuBytes;
      rec.cpuBytes += p.ground.array.byteLength + r.samples.byteLength;
      this.group.add(p.mesh);
    }
    if (!b && !r) rec.state = 'empty';
    rec.sampleBounds = this._sampleBounds(rec);
    rec.based = false;
    rec.signature = null;
  }

  /** Display bbox of every ground sample of a tile (building centroids can lie past its edge). */
  _sampleBounds(rec) {
    const t = this._tileBounds(rec.z, rec.x, rec.y);
    const out = { ...t };
    const grow = (x, y) => {
      if (x < out.minX) out.minX = x;
      if (x > out.maxX) out.maxX = x;
      if (y < out.minY) out.minY = y;
      if (y > out.maxY) out.maxY = y;
    };
    const { x: ox, y: oy } = rec.origin;
    if (rec.b) {
      const sm = rec.b.samples;
      for (let i = 0; i < sm.length; i += 6) {
        grow(ox + sm[i], oy + sm[i + 1]);
        grow(ox + sm[i + 2], oy + sm[i + 3]);
        grow(ox + sm[i + 4], oy + sm[i + 5]);
      }
    }
    return out;
  }

  /**
   * Terrain signature under a tile: the identities of every loaded terrain chunk overlapping it,
   * plus relief exaggeration and ocean drain. Any chunk that loads, is evicted or is rebuilt changes
   * it, which triggers a re-base.
   */
  _signature(rec, chunks) {
    const b = rec.sampleBounds ?? this._tileBounds(rec.z, rec.x, rec.y);
    let s = `${chunks.exaggeration}|${chunks.drain}`;
    if (!(chunks.chunks instanceof Map)) {
      for (const fy of [0.1, 0.5, 0.9]) {
        for (const fx of [0.1, 0.5, 0.9]) {
          s += `|${chunks.levelAt(b.minX + (b.maxX - b.minX) * fx, b.minY + (b.maxY - b.minY) * fy)}`;
        }
      }
      return s;
    }
    let n = 0;
    let h = 0;
    for (const c of chunks.chunks.values()) {
      const size = c.data?.size;
      if (
        !(size > 0) ||
        c.x0 > b.maxX ||
        c.x0 + size <= b.minX ||
        c.y0 > b.maxY ||
        c.y0 + size <= b.minY
      )
        continue;
      let id = this._chunkIds.get(c);
      if (!id) {
        id = this._nextChunkId++;
        this._chunkIds.set(c, id);
      }
      n += 1;
      h = (Math.imul(h, 31) + id) | 0;
    }
    return `${s}|${n}|${h}`;
  }

  /** Place a tile's buildings and roads on the currently rendered terrain (fills aGround). */
  _rebase(rec, view) {
    const t0 = performance.now();
    const chunks = view.chunks;
    const fallback = view.focus?.ground ?? 0;
    const ox = rec.origin.x;
    const oy = rec.origin.y;
    const heightAt = makeHeightSampler(
      chunks,
      rec.sampleBounds ?? this._tileBounds(rec.z, rec.x, rec.y),
    );
    if (rec.b) {
      const { samples, vstart, wallStart, groundLevel } = rec.b;
      const g = rec.b.ground.array;
      let gMin = Infinity;
      let gMax = -Infinity;
      for (let s = 0, n = vstart.length - 1; s < n; s += 1) {
        const o6 = s * 6;
        const base =
          heightAt(ox + samples[o6], oy + samples[o6 + 1]) ?? fallback;
        let low = base;
        const x0 = samples[o6 + 2];
        const y0 = samples[o6 + 3];
        const x1 = samples[o6 + 4];
        const y1 = samples[o6 + 5];
        // Larger footprints also sample their bbox corners so foundations reach the lowest ground.
        if (groundLevel[s] && x1 - x0 + (y1 - y0) > 24) {
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
        const w0 = wallStart[s];
        const end = vstart[s + 1];
        g.fill(base, vstart[s], end);
        // Ground-level walls: the two bottom vertices of every quad stand on the lowest ground.
        if (groundLevel[s] && low < base)
          for (let v = w0; v < end; v += 4) g[v] = g[v + 1] = low;
        if (low < gMin) gMin = low;
        if (base > gMax) gMax = base;
      }
      rec.b.ground.needsUpdate = true;
      rec.b.gMin = gMin;
      rec.b.gMax = gMax;
    }
    if (rec.r) {
      const { samples } = rec.r;
      const g = rec.r.ground.array;
      let gMin = Infinity;
      let gMax = -Infinity;
      for (let s = 0, n = samples.length / 2; s < n; s += 1) {
        const base =
          heightAt(ox + samples[s * 2], oy + samples[s * 2 + 1]) ?? fallback;
        g[s * 2] = base;
        g[s * 2 + 1] = base;
        if (base < gMin) gMin = base;
        if (base > gMax) gMax = base;
      }
      rec.r.ground.needsUpdate = true;
      rec.r.gMin = gMin;
      rec.r.gMax = gMax;
    }
    this._updateBounds(rec, chunks.exaggeration);
    rec.based = true;
    rec.basedAt = performance.now();
    this.totals.rebases += 1;
    this.totals.rebaseMs += performance.now() - t0;
  }

  /** Bounding volumes for culling: ground range plus the exaggerated height range. */
  _updateBounds(rec, e) {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const part of [rec.b, rec.r]) {
      if (!part || !Number.isFinite(part.gMin)) continue;
      const b = part.bounds;
      const lo = part.gMin + Math.min(b.relMin, 0) * e;
      const hi =
        part.gMax + b.relMax * e + (part === rec.r ? 10 * Math.max(e, 1) : 0);
      const geometry = part.mesh.geometry;
      geometry.boundingBox = new THREE.Box3(
        new THREE.Vector3(b.minX, lo, -b.maxY),
        new THREE.Vector3(b.maxX, hi, -b.minY),
      );
      geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(
        new THREE.Sphere(),
      );
      minY = Math.min(minY, lo);
      maxY = Math.max(maxY, hi);
    }
    rec.boundsE = e;
    rec.minY = Number.isFinite(minY) ? minY : undefined;
    rec.maxY = Number.isFinite(maxY) ? maxY : undefined;
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
      .filter(
        (r) =>
          (r.state === 'ready' ||
            r.state === 'empty' ||
            r.state === 'failed') &&
          !wanted.has(r.key),
      )
      .sort((a, b) => a.lastWanted - b.lastWanted);
    let count = [...this.tiles.values()].filter(
      (r) => r.state !== 'queued',
    ).length;
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
      this._enabled &&
      f &&
      f.domain?.domain === DOMAIN_GPS &&
      f.altitude <
        (this._far
          ? Math.max(this.maxAltitude, this.farMaxAltitude)
          : this.maxAltitude),
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
      const k = key(t.z, t.x, t.y, t.v);
      let rec = this.tiles.get(k);
      if (!rec) {
        rec = { key: k, z: t.z, x: t.x, y: t.y, v: t.v, state: 'queued' };
        this.tiles.set(k, rec);
      } else if (rec.state === 'failed' && now > rec.retryAt)
        rec.state = 'queued';
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
    // Each wanted tile shows its wanted detail once that is built and placed; until then it keeps
    // showing the other detail if that is still cached, so moving the camera never opens holes.
    const ready = [];
    const shown = new Set();
    for (const t of picked) {
      const pref = this.tiles.get(key(t.z, t.x, t.y, t.v));
      if (pref?.state === 'ready') ready.push(pref);
      if ((pref?.state === 'ready' && pref.based) || pref?.state === 'empty') {
        shown.add(pref.key);
        continue;
      }
      const other = this.tiles.get(key(t.z, t.x, t.y, t.v === 'f' ? 'n' : 'f'));
      if (other?.state === 'ready' && other.based) {
        other.dist = t.dist;
        other.lastWanted = this.frameNo;
        wanted.set(other.key, other);
        ready.push(other);
        shown.add(other.key);
      }
    }
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
    // least every 1.5 s while it keeps changing).
    const todo = ready
      .filter(
        (r) =>
          !r.based ||
          (r.dirty && (now - r.sigAt > 300 || now - r.basedAt > 1500)),
      )
      .sort((a, b) => a.based - b.based || a.dist - b.dist);
    const t1 = performance.now();
    for (const rec of todo) {
      if (performance.now() - t1 > this.rebaseBudgetMs && rec !== todo[0])
        break;
      if (!rec.signature) rec.signature = this._signature(rec, chunks);
      this._rebase(rec, view);
      rec.dirty = false;
    }

    // 3. Visibility and level of detail.
    const e = chunks.exaggeration;
    this.uniforms.uExaggeration.value = e;
    for (const rec of this.tiles.values()) {
      const show = shown.has(rec.key) && rec.based;
      if (show && rec.boundsE !== e) this._updateBounds(rec, e);
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
    let farVisible = 0;
    for (const rec of this.tiles.values()) {
      if (rec.state === 'ready') loaded += 1;
      else if (rec.state === 'empty') empty += 1;
      else if (rec.state === 'failed') failed += 1;
      else pending += 1;
      gpu += rec.gpuBytes || 0;
      cpu += rec.cpuBytes || 0;
      // Vertex arrays are released on first upload; count the ones still waiting to be drawn.
      for (const part of [rec.b, rec.r]) {
        if (!part) continue;
        const g = part.mesh.geometry;
        for (const name of ['position', 'normal', 'color'])
          cpu += g.attributes[name].array?.byteLength ?? 0;
        cpu += g.index.array?.byteLength ?? 0;
      }
      const shown = rec.b?.mesh.visible || rec.r?.mesh.visible;
      if (rec.b) {
        buildingsLoaded += rec.b.count;
        trianglesLoaded += rec.b.indexCount / 3;
      }
      if (rec.r) trianglesLoaded += rec.r.indexCount / 3;
      if (shown) {
        visible += 1;
        if (rec.v === 'f') farVisible += 1;
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
      far: this._far,
      farTilesVisible: farVisible,
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
   * Check that every visible building and road stands on the terrain: compare each sample's ground
   * value (what the shader draws from) with view.chunks.heightAt at the same point. Tiles waiting
   * for a debounced re-base (their terrain changed within the last ~1.5 s) are counted separately.
   */
  verifyGround() {
    const chunks = this.view.chunks;
    const out = {
      tiles: 0,
      staleTiles: 0,
      buildingSamples: 0,
      roadSamples: 0,
      maxBuildingErrM: 0,
      maxRoadErrM: 0,
    };
    for (const rec of this.tiles.values()) {
      if (
        rec.state !== 'ready' ||
        !rec.based ||
        !(rec.b?.mesh.visible || rec.r?.mesh.visible)
      )
        continue;
      if (rec.dirty || this._signature(rec, chunks) !== rec.signature) {
        out.staleTiles += 1; // terrain under it changed; a re-base is scheduled
        continue;
      }
      out.tiles += 1;
      const { x: ox, y: oy } = rec.origin;
      if (rec.b) {
        const { samples, vstart } = rec.b;
        const g = rec.b.ground.array;
        for (let s = 0; s < vstart.length - 1; s += 1) {
          const h = chunks.heightAt(
            ox + samples[s * 6],
            oy + samples[s * 6 + 1],
          );
          if (h === null) continue;
          out.buildingSamples += 1;
          out.maxBuildingErrM = Math.max(
            out.maxBuildingErrM,
            Math.abs(g[vstart[s]] - h),
          );
        }
      }
      if (rec.r) {
        const { samples } = rec.r;
        const g = rec.r.ground.array;
        for (let s = 0; s < samples.length / 2; s += 1) {
          const h = chunks.heightAt(
            ox + samples[s * 2],
            oy + samples[s * 2 + 1],
          );
          if (h === null) continue;
          out.roadSamples += 1;
          out.maxRoadErrM = Math.max(out.maxRoadErrM, Math.abs(g[s * 2] - h));
        }
      }
    }
    return out;
  }

  /**
   * Prove a landmark sits where its source coordinates say: decode the footprint(s) containing
   * (lat, lon) from the z14 tile, round-trip the footprint centroid through the projection and
   * frame.worldToDomain, and check every roof vertex as uploaded (float32 tile-local coordinates
   * from the same deterministic build, plus the float64 tile origin) inverts back to its source
   * lat/lon. For the loaded tile it also reports the live ground under the footprint and the drawn
   * roof height above the terrain.
   */
  async verifyLandmark({ lat, lon, name = 'landmark' }) {
    this._ensureWorkers();
    const t = lonLatToTile(lon, lat);
    const k = key(BUILDINGS_ZOOM, t.x, t.y);
    const worker = this.workers[0];
    const msg = await new Promise((resolve, reject) => {
      const id = this._post(worker, {
        type: 'probe',
        z: BUILDINGS_ZOOM,
        x: t.x,
        y: t.y,
        lat,
        lon,
      });
      this.jobs.set(id, { resolve, reject });
    });
    const rec = this.tiles.get(k);
    const e = this.view?.chunks.exaggeration ?? 1;
    const out = {
      name,
      tile: k,
      reference: { lat, lon },
      tileLoaded: rec?.state === 'ready',
      footprints: [],
    };
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
        workerVsMainDisplayM: Math.hypot(
          w.x - p.centroidDisplay.x,
          w.y - p.centroidDisplay.y,
        ),
        roundTrip: {
          domain: back.domain,
          lat: back.lat,
          lon: back.lon,
          dLatDeg: Math.abs(back.lat - p.centroid.lat),
          dLonDeg: Math.abs(back.lon - p.centroid.lon),
        },
        centroidToReferenceM: Math.hypot(
          (p.centroid.lat - lat) * mLat,
          (p.centroid.lon - lon) * mLon,
        ),
      };
      if (!p.hidden && Number.isInteger(p.roofStart)) {
        // The float32 tile-local roof coordinates exactly as uploaded (the build is deterministic;
        // the live tile's origin must match), plus the float64 tile origin.
        let maxLat = 0;
        let maxLon = 0;
        for (let i = 0; i < p.roofCount; i += 1) {
          const x = msg.origin.x + p.roofLocal[i * 3];
          const y = msg.origin.y - p.roofLocal[i * 3 + 2];
          const d = this.frame.worldToDomain(x, y, 0);
          maxLat = Math.max(maxLat, Math.abs(d.lat - p.roofLatLon[i][0]));
          maxLon = Math.max(maxLon, Math.abs(d.lon - p.roofLatLon[i][1]));
        }
        r.vertexBuffer = {
          roofVertices: p.roofCount,
          maxVertexLatErrDeg: maxLat,
          maxVertexLonErrDeg: maxLon,
        };
        if (
          rec?.b &&
          rec.origin.x === msg.origin.x &&
          rec.origin.y === msg.origin.y
        ) {
          // Live placement: the roof's ground equals the terrain under the footprint centroid, and
          // the drawn roof is render_height (× exaggeration) above it.
          const s = rec.b.samples;
          const terrain = this.view?.chunks.heightAt(
            rec.origin.x + s[p.sampleIndex * 6],
            rec.origin.y + s[p.sampleIndex * 6 + 1],
          );
          const groundY = rec.b.ground.array[p.roofStart];
          r.livePlacement = {
            groundY,
            terrainAtCentroid: terrain,
            groundErrM: terrain == null ? null : Math.abs(groundY - terrain),
            drawnRoofY: groundY + p.roofLocal[1] * e,
            roofAboveTerrainM:
              terrain == null
                ? null
                : (groundY + p.roofLocal[1] * e - terrain) / e,
            exaggeration: e,
          };
        }
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
    this.depthMaterial.dispose();
  }
}
