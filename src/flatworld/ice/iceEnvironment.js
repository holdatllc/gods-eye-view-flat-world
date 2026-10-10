/**
 * Polar weather and ice caves for the hypothetical ice domain.
 *
 * Weather: wind-driven snow particles around the camera, drifting ground haze and whiteout fog,
 * with intensity and wind configurable. Caves: deterministic ice-cave mouths placed in steep
 * cliff zones on a fixed 1.5 km lattice (seeded), so the same cave is always in the same place.
 * Everything here is fiction and exists only beyond the South-Pole circle.
 */
import * as THREE from 'three';
import { createIceField } from './iceField.js';
import { DOMAIN_ICE } from '../projection/domains.js';

const CAVE_CELL = 1500;
const CAVE_RADIUS_CELLS = 4;

function hashUnit(ix, iy, seed) {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function caveGeometry() {
  // An arched mouth (half torus) with a tapering tunnel running into the cliff along −Z.
  const group = new THREE.Group();
  const iceMat = new THREE.MeshStandardMaterial({ color: 0x9fd2ee, roughness: 0.25, metalness: 0.0, emissive: 0x0b3550, emissiveIntensity: 0.6, side: THREE.DoubleSide });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x0a1c2b, roughness: 0.9, side: THREE.BackSide, emissive: 0x06243a, emissiveIntensity: 0.8 });
  const arch = new THREE.Mesh(new THREE.TorusGeometry(1, 0.22, 12, 32, Math.PI), iceMat);
  group.add(arch);
  const tunnelGeo = new THREE.CylinderGeometry(0.92, 0.55, 6, 24, 6, true, 0, Math.PI);
  tunnelGeo.rotateX(Math.PI / 2);
  tunnelGeo.rotateZ(Math.PI / 2);
  tunnelGeo.rotateZ(-Math.PI / 2);
  tunnelGeo.translate(0, 0, -3);
  const tunnel = new THREE.Mesh(tunnelGeo, darkMat);
  group.add(tunnel);
  // Icicles along the lintel.
  const icicleGeo = new THREE.ConeGeometry(0.035, 0.32, 6);
  icicleGeo.rotateX(Math.PI);
  for (let i = 0; i < 14; i += 1) {
    const a = (i / 13) * Math.PI;
    const ic = new THREE.Mesh(icicleGeo, iceMat);
    ic.position.set(Math.cos(a) * 1.0, Math.sin(a) * 1.0 - 0.2, 0.05);
    ic.scale.y = 0.6 + 0.8 * hashUnit(i, 7, 3);
    group.add(ic);
  }
  group.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return group;
}

export class IceEnvironment {
  constructor({ frame, iceParams = {} }) {
    this.frame = frame;
    this.field = createIceField(iceParams, frame);
    this.group = new THREE.Group();
    this.group.name = 'flatworld-ice-environment';
    this.weather = { enabled: true, intensity: 0.6, windSpeed: 14, windDirDeg: 210, whiteout: 0.2 };
    this.cavesEnabled = true;
    this.caves = new Map();
    this.caveTemplate = caveGeometry();

    const n = 9000;
    const pos = new Float32Array(n * 3);
    this.seeds = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i += 1) this.seeds[i] = hashUnit(i, 11, 5);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.snow = new THREE.Points(
      g,
      new THREE.PointsMaterial({ color: 0xffffff, size: 0.09, sizeAttenuation: true, transparent: true, opacity: 0.85, depthWrite: false, fog: false }),
    );
    this.snow.frustumCulled = false;
    this.group.add(this.snow);
    this.time = 0;
  }

  setIceParams(params) {
    this.field = createIceField(params, this.frame);
    for (const cave of this.caves.values()) cave.removeFromParent();
    this.caves.clear();
  }

  attach(view) {
    this.view = view;
    view.scene.add(this.group);
    view.weather = this; // flatWorldView asks weather for extra fog
  }

  inIce(focus) {
    return focus?.domain?.domain === DOMAIN_ICE;
  }

  /** Extra fog density contributed by the weather at this focus (whiteout). */
  fogDensity(focus) {
    if (!this.weather.enabled || !this.inIce(focus)) return 0;
    const t = Math.min(1, Math.max(0, (focus.distanceBeyond ?? focus.domain.distanceBeyondPole ?? 0) / 150000));
    const lowness = Math.max(0, 1 - focus.altitude / 4000);
    return t * lowness * (this.weather.whiteout * 2.5e-4 + this.weather.intensity * 3e-5);
  }

  update(dt, view) {
    this.time += dt;
    const focus = view.focus;
    const cam = view.camera.position;
    const inIce = this.inIce(focus) || view.frame.domainAt(cam.x, -cam.z) === DOMAIN_ICE;
    const low = focus && focus.altitude < 3000;
    this._updateSnow(dt, view, inIce && low && this.weather.enabled);
    this._updateCaves(view, inIce && focus && focus.altitude < 12000 && this.cavesEnabled);
  }

  _updateSnow(dt, view, active) {
    this.snow.visible = active && this.weather.intensity > 0.01;
    if (!this.snow.visible) return;
    const cam = view.camera.position;
    const box = 60;
    const pos = this.snow.geometry.attributes.position.array;
    const n = Math.floor((pos.length / 3) * Math.min(1, this.weather.intensity));
    const wa = (this.weather.windDirDeg * Math.PI) / 180;
    const wx = Math.sin(wa) * this.weather.windSpeed;
    const wz = -Math.cos(wa) * this.weather.windSpeed;
    const t = this.time;
    // Particles live in a camera-centred box; positions are a pure function of time + seed.
    this.snow.position.set(Math.round(cam.x), Math.round(cam.y), Math.round(cam.z));
    const ox = cam.x - this.snow.position.x;
    const oy = cam.y - this.snow.position.y;
    const oz = cam.z - this.snow.position.z;
    const mod = (v) => ((((v + box) % (2 * box)) + 2 * box) % (2 * box)) - box;
    for (let i = 0; i < n; i += 1) {
      const sx = this.seeds[i * 3] * 2 * box;
      const sy = this.seeds[i * 3 + 1] * 2 * box;
      const sz = this.seeds[i * 3 + 2] * 2 * box;
      const flutter = Math.sin(t * 1.7 + i) * 0.6;
      pos[i * 3] = mod(sx + wx * t + flutter - (cam.x % (2 * box))) + ox;
      pos[i * 3 + 1] = mod(sy - (1.2 + this.seeds[i * 3] * 0.8) * t - (cam.y % (2 * box))) + oy;
      pos[i * 3 + 2] = mod(sz + wz * t + flutter - (cam.z % (2 * box))) + oz;
    }
    this.snow.geometry.setDrawRange(0, n);
    this.snow.geometry.attributes.position.needsUpdate = true;
  }

  _updateCaves(view, active) {
    if (!active) {
      for (const c of this.caves.values()) c.visible = false;
      return;
    }
    const f = view.focus;
    const cx = Math.floor(f.x / CAVE_CELL);
    const cy = Math.floor(f.y / CAVE_CELL);
    const wanted = new Set();
    const seed = this.field.params.seed;
    for (let j = -CAVE_RADIUS_CELLS; j <= CAVE_RADIUS_CELLS; j += 1) {
      for (let i = -CAVE_RADIUS_CELLS; i <= CAVE_RADIUS_CELLS; i += 1) {
        const ix = cx + i;
        const iy = cy + j;
        const key = `${ix},${iy}`;
        if (hashUnit(ix, iy, seed + 71) > 0.45) continue;
        // Candidate point inside the cell; keep it only where the ground is a steep ice face.
        const x = (ix + 0.2 + 0.6 * hashUnit(ix, iy, seed + 72)) * CAVE_CELL;
        const y = (iy + 0.2 + 0.6 * hashUnit(ix, iy, seed + 73)) * CAVE_CELL;
        if (view.frame.domainAt(x, y) !== DOMAIN_ICE) continue;
        const h0 = this.field.sample(x, y);
        if (h0.transition < 0.5) continue;
        const d = 25;
        const hx = this.field.sample(x + d, y).height - this.field.sample(x - d, y).height;
        const hy = this.field.sample(x, y + d).height - this.field.sample(x, y - d).height;
        const slope = Math.hypot(hx, hy) / (2 * d);
        if (slope < 0.55) continue;
        wanted.add(key);
        let cave = this.caves.get(key);
        if (!cave) {
          cave = this.caveTemplate.clone();
          const size = 9 + 14 * hashUnit(ix, iy, seed + 74);
          cave.scale.setScalar(size);
          // Face downhill: the mouth opens toward the lower ground.
          cave.rotation.y = Math.atan2(hx, hy);
          cave.userData = { x, y, height: h0.height, size };
          this.caves.set(key, cave);
          this.group.add(cave);
        }
        cave.visible = true;
      }
    }
    const e = view.chunks.exaggeration;
    for (const [key, cave] of this.caves) {
      if (!wanted.has(key)) {
        cave.removeFromParent();
        this.caves.delete(key);
        continue;
      }
      const { x, y, height, size } = cave.userData;
      const g = view.chunks.heightAt(x, y);
      const base = g ?? height * e;
      cave.position.set(x, base + size * 0.15, -y);
    }
  }

  /**
   * Find the most dramatic nearby ice terrain (largest local relief) around (x, y) and return a
   * camera placement looking at it from a valley. Deterministic for a given seed and start.
   */
  findVista(x, y, { searchRadius = 400000, step = 10000 } = {}) {
    let best = null;
    const n = Math.floor(searchRadius / step);
    for (let j = -n; j <= n; j += 1) {
      for (let i = -n; i <= n; i += 1) {
        const px = x + i * step;
        const py = y + j * step;
        if (this.frame.domainAt(px, py) !== DOMAIN_ICE) continue;
        const c = this.field.sample(px, py);
        if (c.transition < 0.9) continue;
        let lo = c.height;
        let hi = c.height;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
          const h = this.field.sample(px + dx * 4000, py + dy * 4000).height;
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
        }
        const score = hi - lo + 0.3 * (c.height - this.field.params.rimHeightM);
        if (!best || score > best.score) best = { x: px, y: py, score, peak: hi, low: lo };
      }
    }
    if (!best) return null;
    // Stand back toward the lowest neighbouring ground and look at the peak.
    let viewFrom = null;
    for (let a = 0; a < 16; a += 1) {
      const ang = (a / 16) * Math.PI * 2;
      const vx = best.x + Math.cos(ang) * 9000;
      const vy = best.y + Math.sin(ang) * 9000;
      const h = this.field.sample(vx, vy).height;
      if (!viewFrom || h < viewFrom.h) viewFrom = { x: vx, y: vy, h, ang };
    }
    return { target: best, from: viewFrom, yaw: viewFrom.ang + Math.PI };
  }

  stats() {
    return { caves: this.caves.size, snowVisible: this.snow.visible, weather: { ...this.weather } };
  }

  destroy() {
    this.group.removeFromParent();
  }
}
