/**
 * The globe's CELESTIAL ring in the flat world: the same ring, sun rays, moon haze and markers
 * (drawn by celestialRing.js's own painters), around the flat disc, with the sun and moon
 * placed at the bearing of their real sub-points as the sky lane computes them (no second
 * solar model). Shown while the globe's CELESTIAL switch is on and the whole disc is in view.
 */
import {
  KEYHOLE_OUTER_RADIUS,
  drawTaperedArc,
  drawSunRays,
  drawMoonHaze,
} from '../../celestialRing.js';
import * as THREE from 'three';

export class FlatCelestialRing {
  constructor({ frame, sky }) {
    this.frame = frame;
    this.sky = sky;
    this.v = new THREE.Vector3();
    this.lastKey = '';
  }

  attach(view) {
    this.view = view;
    const root = document.createElement('div');
    root.className = 'celestial-ring-overlay fw-celestial-ring';
    root.setAttribute('aria-hidden', 'true');
    this.outline = document.createElement('div');
    this.outline.className = 'celestial-ring-outline';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'celestial-ring-canvas';
    this.ctx = this.canvas.getContext('2d');
    const marker = (cls, icon) => {
      const m = document.createElement('span');
      m.className = `celestial-marker ${cls} material-symbols-outlined`;
      m.textContent = icon;
      return m;
    };
    this.sunMarker = marker('celestial-sun', 'light_mode');
    this.moonMarker = marker('celestial-moon', 'dark_mode');
    root.append(this.outline, this.canvas, this.sunMarker, this.moonMarker);
    view.host.appendChild(root);
    this.root = root;
  }

  /** The globe's CELESTIAL switch (its toolbar button carries the state). */
  _wanted() {
    const btn = document.getElementById('celestial-toggle');
    return Boolean(btn?.classList.contains('active'));
  }

  _screen(x, y) {
    const p = this.v.set(x, 0, -y).project(this.view.camera);
    if (!(p.z > -1 && p.z < 1)) return null;
    return {
      x: ((p.x + 1) / 2) * this.view.canvas.clientWidth,
      y: ((1 - p.y) / 2) * this.view.canvas.clientHeight,
    };
  }

  _hide() {
    if (this.root.classList.contains('visible')) {
      this.root.classList.remove('visible');
      this.lastKey = '';
    }
  }

  update() {
    const st = this.sky?.state;
    const wanted = this._wanted();
    // Switching CELESTIAL on frames the whole disc, as the globe frames the whole globe.
    // (A little farther out than WHOLE DISC, so the ring clears the screen edges and panels.)
    if (wanted && !this.wasWanted)
      this.view.lookAtPlane?.({
        x: 0,
        y: 0,
        range: 7.6e7,
        yaw: Math.PI / 2,
        pitch: Math.PI / 2 - 1e-3,
        animate: true,
      });
    this.wasWanted = wanted;
    if (!wanted || !st?.sun?.world || !st?.moon?.world) return this._hide();
    const view = this.view;
    const w = view.canvas.clientWidth;
    const h = view.canvas.clientHeight;
    // The disc: its centre (the pole) and rim (the south-pole circle) on screen.
    const c = this._screen(0, 0);
    const R = this.frame.boundaryRadius;
    if (!c) return this._hide();
    let r = 0;
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2;
      const s = this._screen(Math.cos(a) * R, Math.sin(a) * R);
      if (!s) return this._hide();
      r += Math.hypot(s.x - c.x, s.y - c.y) / 8;
    }
    const radius = r * KEYHOLE_OUTER_RADIUS;
    // Only for the whole-disc composition (the disc's centre in view and most of it on screen);
    // markers stay inside the screen edge, as the globe's do.
    if (
      c.x < 0 ||
      c.x > w ||
      c.y < 0 ||
      c.y > h ||
      radius > Math.max(w, h) * 0.75
    )
      return this._hide();
    this.root.classList.add('visible');
    // Bearing of each body's sub-point from the pole, on screen.
    const angleOf = (world) => {
      const len = Math.hypot(world.x, world.y) || 1;
      const s = this._screen((world.x / len) * R, (world.y / len) * R);
      return s ? Math.atan2(s.y - c.y, s.x - c.x) : 0;
    };
    const sunA = angleOf(st.sun.world);
    const moonA = angleOf(st.moon.world);
    const key = [c.x, c.y, radius, sunA, moonA]
      .map((n) => n.toFixed(1))
      .join(':');
    if (key === this.lastKey) return;
    this.lastKey = key;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.canvas.width !== Math.round(w * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    drawSunRays(ctx, c.x, c.y, radius, r, sunA);
    drawTaperedArc(ctx, c.x, c.y, radius, sunA, '222, 190, 89', 0.56);
    drawMoonHaze(ctx, c.x, c.y, radius, moonA);
    drawTaperedArc(ctx, c.x, c.y, radius, moonA, '48, 201, 229', 0.42);
    Object.assign(this.outline.style, {
      left: `${c.x - radius}px`,
      top: `${c.y - radius}px`,
      width: `${radius * 2}px`,
      height: `${radius * 2}px`,
    });
    const place = (m, a) => {
      const margin = 14;
      const x = Math.min(
        Math.max(c.x + Math.cos(a) * radius, margin),
        w - margin,
      );
      const y = Math.min(
        Math.max(c.y + Math.sin(a) * radius, margin),
        h - margin,
      );
      m.style.left = `${x}px`;
      m.style.top = `${y}px`;
    };
    place(this.sunMarker, sunA);
    place(this.moonMarker, moonA);
  }
}
