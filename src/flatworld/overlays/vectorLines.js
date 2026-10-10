/**
 * Coastlines/borders (Natural Earth, bundled with the app) and a Gleason-style graticule, drawn
 * through the verified projection. Shown on far views; hidden close to the ground where the
 * imagery already carries the detail.
 */
import * as THREE from 'three';
import countries from '../../data/local_data/natural_earth/countries.json';

const MAX_STEP_DEG = 0.5;

function decodeRing(ring) {
  const out = [];
  let lon = 0;
  let lat = 0;
  for (let i = 0; i < ring.length; i += 2) {
    lon = i === 0 ? ring[0] : lon + ring[i];
    lat = i === 0 ? ring[1] : lat + ring[i + 1];
    out.push([lon / 1000, lat / 1000]);
  }
  return out;
}

export class VectorLines {
  constructor({ frame }) {
    this.frame = frame;
    this.group = new THREE.Group();
    this.group.name = 'flatworld-vectors';
    this.coast = this._build(this._countrySegments(), 0xd8f6ff, 0.55);
    this.grid = this._build(this._graticuleSegments(), 0x39e1ff, 0.28);
    this.rim = this._build(this._rimSegments(), 0xffd36b, 0.9);
    this.group.add(this.coast, this.grid, this.rim);
    this.showCoast = true;
    this.showGrid = false;
  }

  _densify(a, b, push) {
    let dLon = b[0] - a[0];
    if (Math.abs(dLon) > 180) return; // ring edges never cross the antimeridian in this pack
    const dLat = b[1] - a[1];
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dLon), Math.abs(dLat)) / MAX_STEP_DEG));
    let prev = a;
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps;
      const p = [a[0] + dLon * t, a[1] + dLat * t];
      push(prev, p);
      prev = p;
    }
  }

  _countrySegments() {
    const segs = [];
    for (const f of countries.features) {
      for (const poly of f.polygons || []) {
        for (const ring of poly) {
          const pts = decodeRing(ring);
          for (let i = 0; i < pts.length; i += 1) {
            this._densify(pts[i], pts[(i + 1) % pts.length], (a, b) => segs.push(a, b));
          }
        }
      }
    }
    return segs;
  }

  _graticuleSegments() {
    const segs = [];
    // 24 meridians every 15° (as printed on the 1892 Gleason map) and parallels every 15°,
    // plus the tropics and polar circles.
    for (let lon = -180; lon < 180; lon += 15) {
      for (let lat = 90; lat > -90; lat -= 1) segs.push([lon, lat], [lon, lat - 1]);
    }
    const parallels = [75, 60, 45, 30, 15, 0, -15, -30, -45, -60, -75, 23.436, -23.436, 66.564, -66.564];
    for (const lat of parallels) {
      for (let lon = -180; lon < 180; lon += 1) segs.push([lon, lat], [lon + 1, lat]);
    }
    return segs;
  }

  _rimSegments() {
    const segs = [];
    for (let lon = -180; lon < 180; lon += 0.5) segs.push([lon, -90], [lon + 0.5, -90]);
    return segs;
  }

  _build(segments, color, opacity) {
    const pos = new Float32Array(segments.length * 3);
    let n = 0;
    for (let i = 0; i < segments.length; i += 2) {
      // Natural Earth rounding can put Antarctic vertices a hair beyond ±90°; clamp them.
      const a = this.frame.geodeticToWorld(Math.max(-90, Math.min(90, segments[i][1])), segments[i][0]);
      const b = this.frame.geodeticToWorld(Math.max(-90, Math.min(90, segments[i + 1][1])), segments[i + 1][0]);
      if (!a || !b) continue;
      pos.set([a.x, 0, -a.y, b.x, 0, -b.y], n);
      n += 6;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, n), 3));
    const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, fog: false });
    const lines = new THREE.LineSegments(g, m);
    lines.frustumCulled = false;
    lines.renderOrder = 5;
    return lines;
  }

  attach(view) {
    view.scene.add(this.group);
  }

  update(dt, view) {
    const alt = view.focus?.altitude ?? Infinity;
    const far = alt > 900000;
    const fade = THREE.MathUtils.smoothstep(alt, 900000, 3000000);
    this.coast.visible = this.showCoast && far;
    this.coast.material.opacity = 0.55 * fade;
    this.grid.visible = this.showGrid && far;
    this.rim.visible = far;
    this.rim.material.opacity = 0.9 * fade;
  }

  destroy() {
    this.group.removeFromParent();
  }
}
