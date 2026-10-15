/**
 * The globe's WIND layer in the flat world: the same forecast grid (read from the wind layer),
 * advected as particles in latitude/longitude and drawn as short coloured streaks through the
 * projection, so the flow bends with the flat map exactly as the real wind does.
 * Particles live only around the view (re-seeded as they leave it or age out).
 */
import * as THREE from 'three';
import {
  sampleWind,
  advectParticle,
  windColor,
  windSpeed,
} from '../../layers/wind/model.js';

const COUNT = 6000;
const TRAIL = 6;

export class WindFlow {
  constructor({ frame, dataManager }) {
    this.frame = frame;
    this.dataManager = dataManager;
    this.enabled = true;
    this.particles = [];
    this.wind = { u: 0, v: 0 };
    const segs = COUNT * (TRAIL - 1);
    this.positions = new Float32Array(segs * 6);
    this.colors = new Float32Array(segs * 8);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage),
    );
    this.lines = new THREE.LineSegments(
      this.geometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        fog: false,
      }),
    );
    this.lines.renderOrder = 17;
    this.lines.frustumCulled = false;
    this.group = new THREE.Group();
    this.group.name = 'flatworld-wind';
    this.group.add(this.lines);
    // windColor per 0.5 m/s, parsed once.
    this.palette = Array.from({ length: 64 }, (_, i) =>
      new THREE.Color().setStyle(windColor(i * 0.5)),
    );
  }

  attach(view) {
    this.view = view;
    view.scene.add(this.group);
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    if (!this.enabled) this.group.visible = false;
  }

  _field() {
    const dm = this.dataManager;
    if (!dm?.isEffectivelyEnabled?.('wind')) return null;
    try {
      return dm.layers.get('wind')?.module?.getField?.() ?? null;
    } catch {
      return null;
    }
  }

  _seed(p, box) {
    p.lat = box.south + Math.random() * (box.north - box.south);
    p.lon = box.west + Math.random() * (box.east - box.west);
    p.age = Math.floor(Math.random() * 120);
    p.trail = [];
    return p;
  }

  update(dt, view) {
    const field = this.enabled ? this._field() : null;
    this.group.visible = Boolean(field);
    if (!field) return;
    const focus = view.getFocus();
    const geo = focus.domain?.domain === 'gps' ? focus.domain : null;
    const tilt = Math.max(0.35, Math.sin((-focus.pitchDeg * Math.PI) / 180));
    const reach = Math.max((focus.altitude * 1.6) / tilt, 40000);
    let box;
    if (!geo || reach > 4e6)
      box = { west: -180, east: 180, south: -80, north: 85 };
    else {
      const dLat = reach / 111320;
      const dLon = dLat / Math.max(Math.cos((geo.lat * Math.PI) / 180), 0.08);
      box = {
        west: geo.lon - dLon,
        east: geo.lon + dLon,
        south: Math.max(-85, geo.lat - dLat),
        north: Math.min(89, geo.lat + dLat),
      };
    }
    const boxKey = `${box.west.toFixed(2)},${box.south.toFixed(2)},${box.east.toFixed(2)}`;
    const reseedAll = boxKey !== this.boxKey && this._boxFar(box);
    this.boxKey = boxKey;
    this.box = box;
    while (this.particles.length < COUNT) this.particles.push(this._seed({}, box));
    // Speed: a particle crosses about a fifth of the view per second at 20 m/s.
    const speedScale = (reach * 0.2) / 20;
    const e = view.chunks.exaggeration;
    const ox = focus.x;
    const oy = focus.y;
    this.group.position.set(ox, 0, -oy);
    const lift = Math.max(focus.altitude * 0.004, 150) * e;
    const height = focus.ground + lift;
    const jump = reach * 0.1;
    let k = 0;
    const pos = this.positions;
    const col = this.colors;
    for (const p of this.particles) {
      if (
        reseedAll ||
        p.age++ > 140 ||
        p.lat < box.south ||
        p.lat > box.north ||
        p.lon < box.west ||
        p.lon > box.east
      )
        this._seed(p, box);
      sampleWind(field, p.lon, p.lat, this.wind);
      const speed = windSpeed(this.wind.u, this.wind.v);
      advectParticle(p, this.wind, Math.min(dt, 0.05), { speedScale });
      const w = this.frame.geodeticToWorld(p.lat, p.lon);
      if (!w) continue;
      // Drawn over the terrain (no depth test), so one height for the view is enough.
      p.trail.push(w.x, height, w.y);
      if (p.trail.length > TRAIL * 3) p.trail.splice(0, 3);
      const c = this.palette[Math.min(63, Math.round(speed * 2))];
      const t = p.trail;
      const n = t.length / 3;
      for (let i = 1; i < n; i += 1) {
        const a = (i - 1) * 3;
        const b = i * 3;
        // A jump (re-seed or wrap) is not a streak.
        if (Math.abs(t[a] - t[b]) + Math.abs(t[a + 2] - t[b + 2]) > jump) continue;
        const o = k * 6;
        pos[o] = t[a] - ox;
        pos[o + 1] = t[a + 1];
        pos[o + 2] = oy - t[a + 2];
        pos[o + 3] = t[b] - ox;
        pos[o + 4] = t[b + 1];
        pos[o + 5] = oy - t[b + 2];
        const q = k * 8;
        const fa = ((i - 1) / (n - 1)) * 0.9;
        const fb = (i / (n - 1)) * 0.9;
        col[q] = c.r;
        col[q + 1] = c.g;
        col[q + 2] = c.b;
        col[q + 3] = fa;
        col[q + 4] = c.r;
        col[q + 5] = c.g;
        col[q + 6] = c.b;
        col[q + 7] = fb;
        k += 1;
      }
    }
    this.geometry.setDrawRange(0, k * 2);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
    this.segments = k;
  }

  _boxFar(box) {
    const old = this.box;
    if (!old) return true;
    const span = Math.max(box.north - box.south, 1e-3);
    return (
      Math.abs(old.south - box.south) > span * 0.5 ||
      Math.abs(old.west - box.west) > span * 0.5 ||
      Math.abs(old.north - old.south - span) > span * 0.5
    );
  }

  destroy() {
    this.group.removeFromParent();
  }
}
