/**
 * Chunk LOD selection, worker scheduling and a bounded GPU cache for the flat-world terrain.
 *
 * Selection: an unbounded quadtree (level-0 tiles on an infinite grid) refined by screen-space
 * texel size. A node is refined only when all four children are ready, so the surface never
 * shows holes; missing children are requested in priority order (coarse and near first).
 */
import * as THREE from 'three';
import { chunkIndices, tileBounds, ROOT_TILE_SIZE } from './chunkBuilder.js';
import { createTerrainMaterial } from '../render/terrainMaterial.js';

const GRID = 64;
const TEX = 256;
export const MAX_LEVEL = 19;

export class ChunkManager {
  constructor({ scene, workerCount, maxChunks = 720, onChunkReady = () => {} }) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'flatworld-terrain';
    scene.add(this.group);
    this.maxChunks = maxChunks;
    this.onChunkReady = onChunkReady;
    this.chunks = new Map(); // key -> { mesh, data, lastUsed, level, tx, ty }
    this.pending = new Map(); // key -> { level, tx, ty, priority, sent }
    this.index = new THREE.BufferAttribute(chunkIndices(GRID), 1);
    this.exaggeration = 1;
    this.drain = 0;
    this.frame = 0;
    this.pixelTolerance = 1.25;
    this.stats = { built: 0, failed: 0, evicted: 0, buildMs: 0, visible: 0 };
    this.workers = [];
    const n = Math.max(2, Math.min(workerCount ?? (navigator.hardwareConcurrency || 8) - 2, 8));
    for (let i = 0; i < n; i += 1) {
      const worker = new Worker(new URL('./chunkWorker.js', import.meta.url), { type: 'module' });
      worker.busy = 0;
      worker.onmessage = (e) => this._onMessage(e.data);
      this.workers.push(worker);
    }
    this.jobs = new Map();
    this.nextId = 1;
    this.maxInflightPerWorker = 3;
    this.material = createTerrainMaterial();
  }

  configure({ iceParams, rotationDeg }) {
    for (const w of this.workers) w.postMessage({ type: 'config', iceParams, rotationDeg });
    if (Number.isFinite(rotationDeg)) {
      this.clear();
      return;
    }
    // New ice parameters only invalidate chunks that contain hypothetical ice.
    for (const [key, c] of this.chunks) {
      if (c.data.domainMix !== 'gps') {
        this._dispose(c);
        this.chunks.delete(key);
      }
    }
    this.pending.clear();
  }

  clear() {
    for (const c of this.chunks.values()) this._dispose(c);
    this.chunks.clear();
    this.pending.clear();
  }

  key(level, tx, ty) {
    return `${level}/${tx}/${ty}`;
  }

  _workerFor(level, tx, ty) {
    // Route by the ancestor at (level − 4) so neighbours share a worker's tile cache.
    const shift = Math.max(0, level - 4);
    const ax = tx >> shift;
    const ay = ty >> shift;
    const h = (Math.imul(ax, 73856093) ^ Math.imul(ay, 19349663) ^ level) >>> 0;
    const preferred = this.workers[h % this.workers.length];
    if (preferred.busy < this.maxInflightPerWorker) return preferred;
    return this.workers.find((w) => w.busy < this.maxInflightPerWorker) || null;
  }

  request(level, tx, ty, priority) {
    const key = this.key(level, tx, ty);
    if (this.chunks.has(key)) return;
    const p = this.pending.get(key);
    if (p) {
      p.priority = Math.min(p.priority, priority);
      p.frame = this.frame;
      return;
    }
    this.pending.set(key, { key, level, tx, ty, priority, frame: this.frame, sent: false });
  }

  _pump() {
    const queue = [...this.pending.values()].filter((p) => !p.sent);
    // Drop requests nobody asked for in the last few frames.
    for (const p of queue) if (this.frame - p.frame > 30) this.pending.delete(p.key);
    queue.sort((a, b) => a.priority - b.priority);
    for (const p of queue) {
      if (this.frame - p.frame > 30) continue;
      const worker = this._workerFor(p.level, p.tx, p.ty);
      if (!worker) break;
      const id = this.nextId++;
      p.sent = true;
      worker.busy += 1;
      this.jobs.set(id, { key: p.key, worker, level: p.level, tx: p.tx, ty: p.ty });
      worker.postMessage({ type: 'build', id, req: { level: p.level, tx: p.tx, ty: p.ty, grid: GRID, texSize: TEX } });
    }
  }

  /** Ask every worker for its fetch/cache state (diagnostics). */
  workerStatus() {
    return Promise.all(
      this.workers.map(
        (w) =>
          new Promise((resolve) => {
            const id = this.nextId++;
            this.jobs.set(id, { status: resolve, worker: w });
            w.postMessage({ type: 'status', id });
          }),
      ),
    );
  }

  _onMessage(msg) {
    if (msg.type === 'status') {
      const j = this.jobs.get(msg.id);
      this.jobs.delete(msg.id);
      j?.status?.(msg);
      return;
    }
    const job = this.jobs.get(msg.id);
    if (!job) return;
    this.jobs.delete(msg.id);
    job.worker.busy -= 1;
    this.pending.delete(job.key);
    if (msg.type === 'failed') {
      this.stats.failed += 1;
      console.warn('[FlatWorld] chunk failed', job.key, msg.error);
      return;
    }
    this.stats.built += 1;
    this.stats.buildMs += msg.ms;
    this.stats.cache = msg.cache;
    this.stats.fetch = msg.fetchStats;
    this.stats.fetchQueue = msg.queued;
    const t = msg.result.timing;
    if (t) {
      this.stats.tiles = (this.stats.tiles || 0) + t.tilesRequested;
      this.stats.resolveMs = (this.stats.resolveMs || 0) + t.resolveMs;
    }
    const chunk = this._createChunk(msg.result);
    this.chunks.set(job.key, chunk);
    this.onChunkReady(chunk);
  }

  _createChunk(data) {
    const geometry = new THREE.BufferGeometry();
    const raw = data.position; // y = surface height in metres (unexaggerated)
    const surface = new Float32Array(raw.length / 3);
    for (let i = 0; i < surface.length; i += 1) surface[i] = raw[i * 3 + 1];
    const position = new THREE.BufferAttribute(new Float32Array(raw), 3);
    geometry.setAttribute('position', position);
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(data.normal), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(data.uv, 2));
    geometry.setAttribute('aUp', new THREE.BufferAttribute(data.up, 3));
    geometry.setAttribute('aDomain', new THREE.BufferAttribute(data.domain, 1));
    geometry.setAttribute('aWater', new THREE.BufferAttribute(data.water, 1));
    geometry.setIndex(this.index);
    const texture = new THREE.DataTexture(data.rgba, data.texSize, data.texSize, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = 8;
    texture.flipY = false;
    texture.needsUpdate = true;
    const material = this.material.forTexture(texture);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(data.x0, 0, -data.y0);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.frustumCulled = true;
    mesh.receiveShadow = data.level >= 12;
    mesh.castShadow = data.level >= 12;
    mesh.visible = false;
    mesh.userData.chunkKey = this.key(data.level, data.tx, data.ty);
    const chunk = {
      mesh,
      data: { ...data, surface, normalRaw: data.normal, position: null, rgba: null },
      level: data.level,
      tx: data.tx,
      ty: data.ty,
      size: data.size,
      x0: data.x0,
      y0: data.y0,
      minH: data.minH,
      maxH: data.maxH,
      lastUsed: this.frame,
      texture,
    };
    this._applyHeights(chunk);
    this.group.add(mesh);
    return chunk;
  }

  /** Write exaggerated (and optionally drained-ocean) heights and normals into a chunk's mesh. */
  _applyHeights(chunk) {
    const e = this.exaggeration;
    const drain = this.drain;
    const { surface, bed, skirt, normalRaw, size, grid } = chunk.data;
    const pos = chunk.mesh.geometry.attributes.position;
    const nor = chunk.mesh.geometry.attributes.normal;
    const skirtDepth = (size / grid) * 1.5 + 50;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < surface.length; i += 1) {
      const h = drain ? bed[i] : surface[i];
      const y = h * e - (skirt[i] ? skirtDepth * Math.max(1, e) : 0);
      pos.array[i * 3 + 1] = y;
      if (!skirt[i]) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      const nx = normalRaw[i * 3] * e;
      const ny = normalRaw[i * 3 + 1];
      const nz = normalRaw[i * 3 + 2] * e;
      const len = Math.hypot(nx, ny, nz) || 1;
      nor.array[i * 3] = nx / len;
      nor.array[i * 3 + 1] = ny / len;
      nor.array[i * 3 + 2] = nz / len;
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
    chunk.minY = minY;
    chunk.maxY = maxY;
    const half = size / 2;
    const midY = (minY + maxY) / 2;
    chunk.mesh.geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(half, midY, -half),
      Math.hypot(half, half, (maxY - minY) / 2 + skirtDepth),
    );
    chunk.mesh.geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(0, minY - skirtDepth, -size),
      new THREE.Vector3(size, maxY, 0),
    );
  }

  setExaggeration(e, drain = this.drain) {
    this.exaggeration = e;
    this.drain = drain;
    for (const c of this.chunks.values()) this._applyHeights(c);
  }

  _dispose(chunk) {
    this.group.remove(chunk.mesh);
    chunk.mesh.geometry.dispose();
    chunk.texture.dispose();
    chunk.mesh.material.dispose();
  }

  /**
   * Select and show the chunks for this camera.
   * @param {THREE.PerspectiveCamera} camera
   * @param {number} viewportHeight CSS pixels
   */
  update(camera, viewportHeight) {
    this.frame += 1;
    const cam = camera.position;
    const cx = cam.x;
    const cy = -cam.z;
    const k = viewportHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
    const threshold = (this.pixelTolerance * TEX) / k; // refine when size/dist exceeds this
    const visible = [];
    const e = this.exaggeration;

    const dist = (level, tx, ty) => {
      const b = tileBounds(level, tx, ty);
      const c = this.chunks.get(this.key(level, tx, ty));
      const lo = c ? c.minY : 0;
      const hi = c ? c.maxY : 0;
      const dx = Math.max(b.x0 - cx, 0, cx - b.x1);
      const dy = Math.max(b.y0 - cy, 0, cy - b.y1);
      const dz = Math.max(lo - cam.y, 0, cam.y - hi);
      return Math.hypot(dx, dy, dz);
    };

    // Frustum test per tile (unloaded tiles assume the full Earth relief range).
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    const box = new THREE.Box3();
    const inView = (level, tx, ty) => {
      const b = tileBounds(level, tx, ty);
      const c = this.chunks.get(this.key(level, tx, ty));
      const lo = c ? c.minY - 100 : -11000 * e;
      const hi = c ? c.maxY + 100 : 9000 * e;
      box.min.set(b.x0, lo, -b.y1);
      box.max.set(b.x1, hi, -b.y0);
      return frustum.intersectsBox(box);
    };

    const prefetch = (level, bx, by) => {
      for (let j = 0; j < 2; j += 1) {
        for (let i = 0; i < 2; i += 1) {
          const tx = bx + i;
          const ty = by + j;
          const size = ROOT_TILE_SIZE / 2 ** level;
          // Siblings outside the view still load (a parent refines only with all four), but
          // their own descendants are not prefetched.
          const visibleTile = inView(level, tx, ty);
          const d = Math.max(dist(level, tx, ty), 1);
          const existing = this.chunks.get(this.key(level, tx, ty));
          if (existing) existing.lastUsed = this.frame;
          else this.request(level, tx, ty, (d / size) * (visibleTile ? 1 : 4));
          if (visibleTile && size / d > threshold && level < MAX_LEVEL) prefetch(level + 1, tx * 2, ty * 2);
        }
      }
    };

    const visit = (level, tx, ty) => {
      const key = this.key(level, tx, ty);
      const chunk = this.chunks.get(key);
      const size = ROOT_TILE_SIZE / 2 ** level;
      const d = Math.max(dist(level, tx, ty), 1);
      // Tiles outside the frustum stay at their current level (no refinement work for them).
      const wantsRefine = level < MAX_LEVEL && size / d > threshold && inView(level, tx, ty);
      if (!chunk) {
        this.request(level, tx, ty, d / size);
        // Request the descendants this view will need right away, so every level of the path
        // to the ideal resolution loads in parallel instead of one level per round trip.
        if (wantsRefine && level < MAX_LEVEL) prefetch(level + 1, tx * 2, ty * 2);
        return false;
      }
      chunk.lastUsed = this.frame;
      if (wantsRefine) {
        const kids = [
          [level + 1, tx * 2, ty * 2],
          [level + 1, tx * 2 + 1, ty * 2],
          [level + 1, tx * 2, ty * 2 + 1],
          [level + 1, tx * 2 + 1, ty * 2 + 1],
        ];
        const ready = kids.every(([l, x, y]) => this.chunks.has(this.key(l, x, y)));
        if (ready) {
          for (const [l, x, y] of kids) visit(l, x, y);
          return true;
        }
        prefetch(level + 1, tx * 2, ty * 2);
      }
      visible.push(chunk);
      return true;
    };

    // Roots: the level-0 tiles within the view radius of the camera's ground point.
    const radius = Math.min(Math.max((cam.y * 400) / Math.max(e, 1), 2e6), 1.4e8);
    const r0 = Math.floor((cx - radius + ROOT_TILE_SIZE / 2) / ROOT_TILE_SIZE);
    const r1 = Math.floor((cx + radius + ROOT_TILE_SIZE / 2) / ROOT_TILE_SIZE);
    const s0 = Math.floor((cy - radius + ROOT_TILE_SIZE / 2) / ROOT_TILE_SIZE);
    const s1 = Math.floor((cy + radius + ROOT_TILE_SIZE / 2) / ROOT_TILE_SIZE);
    for (let ty = s0; ty <= s1; ty += 1) for (let tx = r0; tx <= r1; tx += 1) visit(0, tx, ty);

    for (const c of this.chunks.values()) c.mesh.visible = false;
    for (const c of visible) c.mesh.visible = true;
    this.visible = visible;
    this.stats.visible = visible.length;
    this._evict(new Set(visible));
    this._pump();
  }

  _evict(keep) {
    if (this.chunks.size <= this.maxChunks) return;
    // Visible chunks and all their ancestors form the refinement chain and are never evicted.
    const protectedKeys = new Set();
    for (const c of keep) {
      let { level, tx, ty } = c;
      while (level >= 0) {
        const key = this.key(level, tx, ty);
        if (protectedKeys.has(key)) break;
        protectedKeys.add(key);
        level -= 1;
        tx = Math.floor(tx / 2);
        ty = Math.floor(ty / 2);
      }
    }
    const hardCap = Math.round(this.maxChunks * 1.5);
    const candidates = [...this.chunks.entries()]
      .filter(([key, c]) => !protectedKeys.has(key) && c.level > 0)
      .filter(([, c]) => this.chunks.size > hardCap || c.lastUsed < this.frame)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed || b[1].level - a[1].level);
    let excess = this.chunks.size - this.maxChunks;
    for (const [key, c] of candidates) {
      if (excess <= 0) break;
      this._dispose(c);
      this.chunks.delete(key);
      this.stats.evicted += 1;
      excess -= 1;
    }
  }

  /**
   * Rendered terrain height (exaggerated, metres) at display-frame (x, y) from the finest loaded
   * chunk, or null when nothing covering the point is loaded.
   */
  heightAt(x, y) {
    let best = null;
    for (let level = MAX_LEVEL; level >= 0 && !best; level -= 1) {
      const size = ROOT_TILE_SIZE / 2 ** level;
      const tx = Math.floor((x + ROOT_TILE_SIZE / 2) / size);
      const ty = Math.floor((y + ROOT_TILE_SIZE / 2) / size);
      const c = this.chunks.get(this.key(level, tx, ty));
      if (c) best = c;
    }
    if (!best) return null;
    const { grid, size } = best.data;
    const step = size / grid;
    const fx = Math.min(Math.max((x - best.x0) / step, 0), grid);
    const fy = Math.min(Math.max((y - best.y0) / step, 0), grid);
    const i0 = Math.min(Math.floor(fx), grid - 1);
    const j0 = Math.min(Math.floor(fy), grid - 1);
    const u = fx - i0;
    const v = fy - j0;
    const pos = best.mesh.geometry.attributes.position.array;
    const h = (i, j) => pos[(j * (grid + 1) + i) * 3 + 1];
    return (
      (h(i0, j0) * (1 - u) + h(i0 + 1, j0) * u) * (1 - v) +
      (h(i0, j0 + 1) * (1 - u) + h(i0 + 1, j0 + 1) * u) * v
    );
  }

  /** Finest loaded chunk level at a point (diagnostics). */
  levelAt(x, y) {
    for (let level = MAX_LEVEL; level >= 0; level -= 1) {
      const size = ROOT_TILE_SIZE / 2 ** level;
      const tx = Math.floor((x + ROOT_TILE_SIZE / 2) / size);
      const ty = Math.floor((y + ROOT_TILE_SIZE / 2) / size);
      if (this.chunks.has(this.key(level, tx, ty))) return level;
    }
    return -1;
  }

  memoryEstimate() {
    let bytes = 0;
    for (const c of this.chunks.values()) {
      bytes += c.data.texSize * c.data.texSize * 4 * 1.34;
      for (const a of Object.values(c.mesh.geometry.attributes)) bytes += a.array.byteLength;
    }
    return bytes;
  }

  destroy() {
    this.clear();
    for (const w of this.workers) w.terminate();
    this.scene.remove(this.group);
  }
}
