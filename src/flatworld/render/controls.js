/**
 * Camera systems for the flat world: orbit (map), fly and walk, with terrain collision.
 *
 * Plane coordinates are the display frame (x, y) in metres; three.js world is (x, h, −y).
 * Yaw is an absolute angle in the plane (0 = +x, π/2 = +y), so panning never spins the map.
 * Compass headings (relative to true north) are derived from yaw where needed: on this projection
 * true north at any point is the direction toward the disc centre.
 */
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function northAt(x, y) {
  const r = Math.hypot(x, y);
  if (r < 1e-3) return { x: 0, y: 1 };
  return { x: -x / r, y: -y / r };
}

/** Compass heading (degrees clockwise from true north) of plane yaw at (x, y). */
export function yawToHeading(yaw, x, y) {
  const n = northAt(x, y);
  const e = { x: n.y, y: -n.x };
  const dx = Math.cos(yaw);
  const dy = Math.sin(yaw);
  return (
    ((Math.atan2(dx * e.x + dy * e.y, dx * n.x + dy * n.y) * 180) / Math.PI +
      360) %
    360
  );
}

/** Plane yaw that looks along compass heading (degrees) at (x, y). */
export function headingToYaw(headingDeg, x, y) {
  const n = northAt(x, y);
  const e = { x: n.y, y: -n.x };
  const h = (headingDeg * Math.PI) / 180;
  return Math.atan2(
    n.y * Math.cos(h) + e.y * Math.sin(h),
    n.x * Math.cos(h) + e.x * Math.sin(h),
  );
}

export class FlatWorldControls {
  constructor({ camera, element, groundHeight }) {
    this.camera = camera;
    this.element = element;
    this.groundHeight = groundHeight; // (x, y) => exaggerated height or null
    this.mode = 'orbit';
    // Orbit state
    this.target = { x: 0, y: 0, h: 0 };
    /** When set (e.g. while tracking an aircraft), the orbit pivots at this height, not the ground. */
    this.targetHeightLock = null;
    this.distance = 6.0e7;
    this.yaw = Math.PI / 2;
    this.pitch = Math.PI / 2 - 1e-3;
    // Fly / walk state
    this.position = new THREE.Vector3();
    this.lookYaw = Math.PI / 2;
    this.lookPitch = -0.3;
    this.keys = new Set();
    this.eyeHeight = 1.7;
    this.speedBoost = 1;
    this.listeners = [];
    this.enabled = false;
    this.onChange = () => {};
    /** Called when the user moves the camera themselves (e.g. to end tracking). */
    this.onUserInput = () => {};
    this._bind();
  }

  _on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.listeners.push(() => target.removeEventListener(type, fn, opts));
  }

  _bind() {
    const el = this.element;
    let drag = null;
    this._on(el, 'contextmenu', (e) => e.preventDefault());
    this._on(el, 'pointerdown', (e) => {
      if (!this.enabled) return;
      el.setPointerCapture(e.pointerId);
      drag = {
        x: e.clientX,
        y: e.clientY,
        button: e.button,
        shift: e.shiftKey || e.ctrlKey || e.altKey,
        // Grab-pan: the ground point under the cursor stays under it while dragging.
        grab:
          this.mode === 'orbit'
            ? this.groundUnderCursor(e.clientX, e.clientY)
            : null,
      };
    });
    this._on(el, 'pointerup', (e) => {
      drag = null;
      el.releasePointerCapture?.(e.pointerId);
    });
    this._on(el, 'pointermove', (e) => {
      if (!this.enabled || !drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      const rotate = drag.button === 2 || drag.shift;
      if (Math.hypot(dx, dy) > 0) this.onUserInput();
      if (this.mode === 'orbit') {
        if (rotate) {
          this.yaw -= dx * 0.005;
          this.pitch = clamp(this.pitch + dy * 0.004, 0.05, Math.PI / 2 - 1e-3);
          drag.grab = null;
        } else {
          const now = drag.grab
            ? this.groundUnderCursor(e.clientX, e.clientY)
            : null;
          if (drag.grab && now) {
            this.target.x += drag.grab.x - now.x;
            this.target.y += drag.grab.y - now.y;
            this.update(0); // re-pose the camera so the next ray uses the moved target
          } else this._pan(dx, dy);
        }
      } else {
        this.lookYaw -= dx * 0.004;
        this.lookPitch = clamp(this.lookPitch - dy * 0.004, -1.5, 1.5);
      }
      this.onChange();
    });
    this._on(
      el,
      'wheel',
      (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        this.onUserInput();
        if (this.mode === 'orbit') this._zoom(e.deltaY, e.clientX, e.clientY);
        else
          this.speedBoost = clamp(
            this.speedBoost * Math.exp(-e.deltaY * 0.002),
            0.05,
            400,
          );
        this.onChange();
      },
      { passive: false },
    );
    this._on(el, 'dblclick', (e) => {
      if (!this.enabled || this.mode !== 'orbit') return;
      const p = this.groundUnderCursor(e.clientX, e.clientY);
      if (p) this.flyTo({ x: p.x, y: p.y, distance: this.distance / 3 });
    });
    const typing = () => {
      const a = document.activeElement;
      return (
        a &&
        (a.tagName === 'INPUT' ||
          a.tagName === 'TEXTAREA' ||
          a.tagName === 'SELECT' ||
          a.isContentEditable)
      );
    };
    const MOVE_KEYS = [
      'w',
      'a',
      's',
      'd',
      'q',
      'e',
      'shift',
      ' ',
      'arrowup',
      'arrowdown',
      'arrowleft',
      'arrowright',
    ];
    // Capture phase on window: while the flat world is shown, the globe's own keyboard shortcuts
    // (voice push-to-talk on Space, detection-mode cycling on D, …) must not fire.
    // The globe's own shortcuts that mean the same in the flat world pass through: visual styles
    // 1-7, HUD h, clean view v, CCTV c, layers f, and detection d (d is a move key in fly/walk).
    const APP_KEYS = new Set(['1', '2', '3', '4', '5', '6', '7', 'h', 'v', 'c', 'f']);
    const appKey = (e) => {
      const k = e.key.toLowerCase();
      return APP_KEYS.has(k) || (k === 'd' && this.mode === 'orbit');
    };
    const owns = (e) =>
      this.enabled &&
      !appKey(e) &&
      !typing() &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      e.key !== 'Escape' &&
      !/^F\d+$/.test(e.key);
    this._on(
      window,
      'keydown',
      (e) => {
        if (!owns(e)) return;
        e.stopImmediatePropagation();
        const k = e.key.toLowerCase();
        // o: the globe's orbit toggle; here, back to the orbit camera.
        if (k === 'o' && !e.repeat) {
          this.setMode?.('orbit');
          return;
        }
        if (MOVE_KEYS.includes(k)) {
          this.keys.add(k);
          if (this.mode !== 'orbit' || k.startsWith('arrow') || k === ' ')
            e.preventDefault();
          this.onUserInput();
        }
      },
      { capture: true },
    );
    this._on(
      window,
      'keyup',
      (e) => {
        this.keys.delete(e.key.toLowerCase());
        if (owns(e)) e.stopImmediatePropagation();
      },
      { capture: true },
    );
    this._on(window, 'blur', () => this.keys.clear());
  }

  metresPerPixel() {
    const h = this.element.clientHeight || 1;
    return (
      (2 * this.distance * Math.tan((this.camera.fov * Math.PI) / 360)) / h
    );
  }

  _pan(dx, dy) {
    const m = this.metresPerPixel();
    // Screen right/up mapped onto the ground in the current yaw.
    const fx = Math.cos(this.yaw);
    const fy = Math.sin(this.yaw);
    const rx = fy;
    const ry = -fx;
    const tilt = Math.max(Math.sin(this.pitch), 0.25);
    this.target.x -= (dx * rx - (dy * fx) / tilt) * m;
    this.target.y -= (dx * ry - (dy * fy) / tilt) * m;
  }

  _zoom(deltaY, clientX, clientY) {
    const factor = Math.exp(deltaY * 0.0015);
    const newDistance = clamp(this.distance * factor, 2, 2.5e8);
    const p = this.groundUnderCursor(clientX, clientY);
    if (p) {
      // Zooming in moves toward the cursor point, zooming out away from it (it stays put).
      const t = 1 - newDistance / this.distance;
      this.target.x += (p.x - this.target.x) * t;
      this.target.y += (p.y - this.target.y) * t;
    }
    this.distance = newDistance;
  }

  /** Intersect the cursor ray with the plane at the target's height. */
  groundUnderCursor(clientX, clientY) {
    const rect = this.element.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const h = this.mode === 'orbit' ? this.target.h : 0;
    const dirY = ray.ray.direction.y;
    if (Math.abs(dirY) < 1e-9) return null;
    const t = (h - ray.ray.origin.y) / dirY;
    if (t <= 0) return null;
    const hit = ray.ray.origin.clone().addScaledVector(ray.ray.direction, t);
    return { x: hit.x, y: -hit.z, h };
  }

  flyTo({
    x,
    y,
    distance = this.distance,
    yaw = this.yaw,
    pitch = this.pitch,
    duration = 1.6,
  }) {
    this.animation = {
      from: {
        x: this.target.x,
        y: this.target.y,
        distance: this.distance,
        yaw: this.yaw,
        pitch: this.pitch,
      },
      to: { x, y, distance, yaw, pitch },
      t: 0,
      duration,
    };
    if (this.mode !== 'orbit') this.setMode('orbit');
  }

  setMode(mode) {
    if (mode === this.mode) return;
    const cam = this.camera;
    if (mode !== 'orbit') {
      this.position.copy(cam.position);
      const dir = new THREE.Vector3();
      cam.getWorldDirection(dir);
      this.lookYaw = Math.atan2(-dir.z, dir.x);
      this.lookPitch = Math.asin(clamp(dir.y, -1, 1));
      if (mode === 'walk') {
        const g = this.groundHeight(cam.position.x, -cam.position.z) ?? 0;
        this.position.y = g + this.eyeHeight;
        this.lookPitch = 0;
        this.speedBoost = 1;
      }
    } else {
      const dir = new THREE.Vector3();
      cam.getWorldDirection(dir);
      const g = this.groundHeight(cam.position.x, -cam.position.z) ?? 0;
      const agl = Math.max(cam.position.y - g, 10);
      const down = Math.max(-dir.y, 0.2);
      const dist = Math.min(agl / down, agl * 5);
      this.target = {
        x: cam.position.x + dir.x * dist,
        y: -(cam.position.z + dir.z * dist),
        h: g,
      };
      this.distance = Math.hypot(dist * dir.x, dist * dir.z, agl);
      this.yaw = Math.atan2(-dir.z, dir.x);
      this.pitch = clamp(
        Math.asin(clamp(agl / this.distance, 0, 1)),
        0.05,
        Math.PI / 2 - 1e-3,
      );
    }
    this.mode = mode;
    this.onChange();
  }

  /** Advance one frame. */
  update(dt) {
    const cam = this.camera;
    if (this.animation) {
      const a = this.animation;
      a.t = Math.min(1, a.t + dt / a.duration);
      const s = a.t * a.t * (3 - 2 * a.t);
      // Zoom out-and-in arc for long flights.
      const span = Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y);
      const arc = Math.sin(Math.PI * s) * Math.min(span * 0.6, 3e7);
      this.target.x = a.from.x + (a.to.x - a.from.x) * s;
      this.target.y = a.from.y + (a.to.y - a.from.y) * s;
      const logD =
        Math.log(a.from.distance) +
        (Math.log(a.to.distance) - Math.log(a.from.distance)) * s;
      this.distance = Math.exp(logD) + arc;
      let dyaw = a.to.yaw - a.from.yaw;
      dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
      this.yaw = a.from.yaw + dyaw * s;
      this.pitch = a.from.pitch + (a.to.pitch - a.from.pitch) * s;
      if (a.t >= 1) this.animation = null;
      this.onChange();
    }
    if (this.mode === 'orbit') {
      const g =
        this.targetHeightLock ??
        this.groundHeight(this.target.x, this.target.y);
      if (g !== null)
        this.target.h += (g - this.target.h) * Math.min(1, dt * 6);
      // Keyboard panning in orbit mode (arrows).
      const kx =
        (this.keys.has('arrowright') ? 1 : 0) -
        (this.keys.has('arrowleft') ? 1 : 0);
      const ky =
        (this.keys.has('arrowup') ? 1 : 0) -
        (this.keys.has('arrowdown') ? 1 : 0);
      if (kx || ky) this._pan(-kx * 400 * dt, ky * 400 * dt);
      const fx = Math.cos(this.yaw);
      const fy = Math.sin(this.yaw);
      const cp = Math.cos(this.pitch);
      const sp = Math.sin(this.pitch);
      const look = new THREE.Vector3(fx * cp, -sp, -fy * cp);
      const tgt = new THREE.Vector3(
        this.target.x,
        this.target.h,
        -this.target.y,
      );
      cam.position.copy(tgt).addScaledVector(look, -this.distance);
      // Terrain collision: keep the camera above the ground under it.
      const under = this.groundHeight(cam.position.x, -cam.position.z);
      if (under !== null && cam.position.y < under + 3)
        cam.position.y = under + 3;
      const right = new THREE.Vector3().crossVectors(look, UP);
      if (right.lengthSq() < 1e-12) right.set(fy, 0, fx);
      right.normalize();
      cam.up.copy(new THREE.Vector3().crossVectors(right, look).normalize());
      cam.lookAt(tgt);
    } else {
      const cp = Math.cos(this.lookPitch);
      const fwd = new THREE.Vector3(
        Math.cos(this.lookYaw) * cp,
        Math.sin(this.lookPitch),
        -Math.sin(this.lookYaw) * cp,
      );
      const flat = new THREE.Vector3(
        Math.cos(this.lookYaw),
        0,
        -Math.sin(this.lookYaw),
      );
      const right = new THREE.Vector3().crossVectors(flat, UP).normalize();
      const g = this.groundHeight(this.position.x, -this.position.z);
      const agl = g === null ? this.position.y : this.position.y - g;
      const base = this.mode === 'walk' ? 4.2 : Math.max(8, agl * 0.9);
      const speed = base * this.speedBoost * (this.keys.has('shift') ? 5 : 1);
      const move = new THREE.Vector3();
      const dirVec = this.mode === 'walk' ? flat : fwd;
      if (this.keys.has('w') || this.keys.has('arrowup')) move.add(dirVec);
      if (this.keys.has('s') || this.keys.has('arrowdown')) move.sub(dirVec);
      if (this.keys.has('d') || this.keys.has('arrowright')) move.add(right);
      if (this.keys.has('a') || this.keys.has('arrowleft')) move.sub(right);
      if (this.mode === 'fly') {
        if (this.keys.has('e') || this.keys.has(' ')) move.y += 1;
        if (this.keys.has('q')) move.y -= 1;
      }
      if (move.lengthSq() > 0) {
        this.position.addScaledVector(move.normalize(), speed * dt);
        this.onChange();
      }
      if (this.mode === 'walk' && g !== null)
        this.position.y = g + this.eyeHeight;
      else if (g !== null && this.position.y < g + 2) this.position.y = g + 2;
      cam.position.copy(this.position);
      cam.up.copy(UP);
      cam.lookAt(this.position.clone().add(fwd));
    }
    cam.updateMatrixWorld();
  }

  destroy() {
    for (const off of this.listeners) off();
    this.listeners = [];
  }
}
