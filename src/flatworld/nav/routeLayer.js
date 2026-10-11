/**
 * Route measurement and distortion visualisation in the flat world.
 *
 * - Click two points (or choose a preset city pair): draws the real-world geodesic (cyan, curved on
 *   the disc) and the flat-map straight line (amber), with clearly labelled distances.
 * - Tissot indicatrices: true 500 km circles on the Earth drawn through the projection, showing
 *   how the map stretches along parallels (ellipses) but not along meridians.
 */
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import geographiclib from 'geographiclib-geodesic';
import { compareRoutes } from './routes.js';

const { Geodesic } = geographiclib;

export const ROUTE_PRESETS = [
  { name: 'London → New York', a: [51.5074, -0.1278], b: [40.7128, -74.006] },
  {
    name: 'Sydney → Santiago',
    a: [-33.8688, 151.2093],
    b: [-33.4489, -70.6693],
  },
  {
    name: 'Johannesburg → Perth',
    a: [-26.2041, 28.0473],
    b: [-31.9523, 115.8613],
  },
  {
    name: 'Tokyo → Los Angeles',
    a: [35.6762, 139.6503],
    b: [34.0522, -118.2437],
  },
];

// Shared marker resources (never disposed per marker, so markers cannot leak GPU objects).
const MARKER_GEOMETRY = new THREE.SphereGeometry(1, 16, 12);
const MARKER_MATERIAL = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  depthTest: false,
  fog: false,
});

function makeSegments(color, width) {
  const material = new LineMaterial({
    color,
    linewidth: width,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
  });
  const line = new LineSegments2(new LineSegmentsGeometry(), material);
  line.renderOrder = 20;
  line.frustumCulled = false;
  line.visible = false;
  return line;
}

function makeLine(color, width, dashed = false) {
  const material = new LineMaterial({
    color,
    linewidth: width,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    dashed,
    dashSize: 3,
    gapSize: 2,
  });
  const line = new Line2(new LineGeometry(), material);
  line.renderOrder = 20;
  line.frustumCulled = false;
  line.visible = false;
  return line;
}

export class RouteLayer {
  constructor({ frame }) {
    this.frame = frame;
    this.group = new THREE.Group();
    this.group.name = 'flatworld-routes';
    // The geodesic can be split in two where it crosses the South Pole, so it is drawn as
    // independent segments rather than one polyline.
    this.geodesicLine = makeSegments(0x39e1ff, 3);
    this.flatLine = makeLine(0xffc14d, 3);
    this.groundLine = makeLine(0xff6b6b, 1.5);
    this.group.add(this.geodesicLine, this.flatLine, this.groundLine);
    this.markers = new THREE.Group();
    this.group.add(this.markers);
    this.tissot = this._buildTissot();
    this.tissot.visible = false;
    this.group.add(this.tissot);
    this.points = [];
    this.result = null;
    this.measuring = false;
    this.onResult = () => {};
  }

  attach(view) {
    this.view = view;
    view.scene.add(this.group);
  }

  /** Drape a plane-space point on the rendered terrain (lines and markers sit on the ground). */
  _ground(p) {
    const h = this.view?.chunks.heightAt(p.x, p.y);
    return (h ?? 0) + 30 * (this.view?.chunks.exaggeration ?? 1);
  }

  _setLine(line, pts) {
    if (!pts || pts.length < 2) {
      line.visible = false;
      line.userData.pts = null;
      return;
    }
    // Densify long chords so the draped line can follow the terrain.
    const dense = [];
    for (let i = 0; i < pts.length; i += 1) {
      if (i > 0) {
        const a = pts[i - 1];
        const b = pts[i];
        const n = Math.min(
          64,
          Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 20000),
        );
        for (let k = 1; k < n; k += 1)
          dense.push({
            x: a.x + ((b.x - a.x) * k) / n,
            y: a.y + ((b.y - a.y) * k) / n,
          });
      }
      dense.push(pts[i]);
    }
    line.userData.pts = dense;
    this._drapeLine(line);
    line.visible = true;
  }

  _setSegments(line, segments) {
    const pairs = [];
    for (const seg of segments || [])
      for (let i = 1; i < seg.length; i += 1) pairs.push(seg[i - 1], seg[i]);
    if (!pairs.length) {
      line.visible = false;
      line.userData.pairs = null;
      return;
    }
    line.userData.pairs = pairs;
    this._drapeSegments(line);
    line.visible = true;
  }

  _drapeLine(line) {
    const pts = line.userData.pts;
    if (!pts) return;
    const arr = new Array(pts.length * 3);
    pts.forEach((p, i) => {
      arr[i * 3] = p.x;
      arr[i * 3 + 1] = this._ground(p);
      arr[i * 3 + 2] = -p.y;
    });
    line.geometry.dispose();
    line.geometry = new LineGeometry();
    line.geometry.setPositions(arr);
    line.computeLineDistances();
  }

  _drapeSegments(line) {
    const pairs = line.userData.pairs;
    if (!pairs) return;
    const arr = new Array(pairs.length * 3);
    pairs.forEach((p, i) => {
      arr[i * 3] = p.x;
      arr[i * 3 + 1] = this._ground(p);
      arr[i * 3 + 2] = -p.y;
    });
    line.geometry.dispose();
    line.geometry = new LineSegmentsGeometry();
    line.geometry.setPositions(arr);
  }

  _marker(p) {
    const m = new THREE.Mesh(MARKER_GEOMETRY, MARKER_MATERIAL);
    m.position.set(p.x, this._ground(p), -p.y);
    m.renderOrder = 21;
    m.userData.plane = p;
    this.markers.add(m);
  }

  clear() {
    this.points = [];
    this.result = null;
    this.measuring = false;
    this.markers.clear();
    for (const l of [this.geodesicLine, this.flatLine, this.groundLine]) {
      l.visible = false;
      l.userData.pts = null;
      l.userData.pairs = null;
    }
    this.onResult(null);
  }

  startMeasuring() {
    this.clear();
    this.measuring = true;
    this.onResult(null);
  }

  /** Feed a ground click; after two points the comparison is computed. */
  addPoint(p) {
    if (!this.measuring || !p) return false;
    this.points.push({ x: p.x, y: p.y });
    this._marker(p);
    if (this.points.length === 2) {
      this.measuring = false;
      this.measure(this.points[0], this.points[1]);
    }
    return true;
  }

  measureGeodetic(a, b) {
    this.clear();
    const p1 = this.frame.geodeticToWorld(a[0], a[1]);
    const p2 = this.frame.geodeticToWorld(b[0], b[1]);
    this.points = [p1, p2];
    this._marker(p1);
    this._marker(p2);
    return this.measure(p1, p2);
  }

  measure(p1, p2) {
    const r = compareRoutes(this.frame, p1, p2, { samples: 400 });
    this.result = r;
    this._setLine(this.flatLine, r.flat.points);
    this._setSegments(this.geodesicLine, r.geodesic?.segments);
    this._setLine(this.groundLine, null);
    this.onResult(r);
    return r;
  }

  _buildTissot() {
    // 500 km geodesic circles every 30° of longitude and 20° of latitude.
    const segments = [];
    const g = Geodesic.WGS84;
    for (let lat = 80; lat >= -80; lat -= 20) {
      for (let lon = -180; lon < 180; lon += 30) {
        let prev = null;
        for (let a = 0; a <= 360; a += 6) {
          const d = g.Direct(lat, lon, a, 500000);
          const w = this.frame.geodeticToWorld(d.lat2, d.lon2);
          if (prev) segments.push(prev.x, 0, -prev.y, w.x, 0, -w.y);
          prev = w;
        }
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(segments), 3),
    );
    const lines = new THREE.LineSegments(
      geom,
      new THREE.LineBasicMaterial({
        color: 0xff7ad9,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
        fog: false,
      }),
    );
    lines.renderOrder = 19;
    lines.frustumCulled = false;
    return lines;
  }

  update(dt, view) {
    const res = new THREE.Vector2();
    view.renderer.getSize(res);
    for (const l of [this.geodesicLine, this.flatLine, this.groundLine])
      l.material.resolution.copy(res);
    // Re-drape once a second as finer terrain loads under the route.
    this._drapeTimer = (this._drapeTimer || 0) + dt;
    if (this._drapeTimer > 1) {
      this._drapeTimer = 0;
      if (this.flatLine.visible) this._drapeLine(this.flatLine);
      if (this.geodesicLine.visible) this._drapeSegments(this.geodesicLine);
      for (const m of this.markers.children)
        m.position.y = this._ground(m.userData.plane);
    }
    // Keep markers a constant screen size.
    for (const m of this.markers.children) {
      const d = m.position.distanceTo(view.camera.position);
      m.scale.setScalar(d * 0.006);
    }
  }

  destroy() {
    this.group.removeFromParent();
  }
}
