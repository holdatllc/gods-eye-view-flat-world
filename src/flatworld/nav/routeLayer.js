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
    this.geodesicLine = makeLine(0x39e1ff, 3);
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

  _setLine(line, pts, lift) {
    if (!pts || pts.length < 2) {
      line.visible = false;
      return;
    }
    const arr = [];
    for (const p of pts) arr.push(p.x, lift, -p.y);
    line.geometry.dispose();
    line.geometry = new LineGeometry();
    line.geometry.setPositions(arr);
    line.computeLineDistances();
    line.visible = true;
  }

  _marker(p) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        depthTest: false,
        fog: false,
      }),
    );
    m.position.set(p.x, 0, -p.y);
    m.renderOrder = 21;
    m.userData.plane = p;
    this.markers.add(m);
  }

  clear() {
    this.points = [];
    this.result = null;
    this.markers.clear();
    for (const l of [this.geodesicLine, this.flatLine, this.groundLine])
      l.visible = false;
    this.onResult(null);
  }

  startMeasuring() {
    this.clear();
    this.measuring = true;
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
    this._setLine(this.flatLine, r.flat.points, 0);
    this._setLine(this.geodesicLine, r.geodesic?.plane, 0);
    this._setLine(this.groundLine, null, 0);
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
