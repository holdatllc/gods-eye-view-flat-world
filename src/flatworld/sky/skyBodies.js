/**
 * Sun and moon layer. Positions come from the real ephemeris (skyMath.js) and are projected with the
 * same aeqd function as planes and ships. Heights, body size and the spotlight are MODEL SETTINGS and
 * are labelled as such on screen. Day/night shading lives here, behind its own toggle.
 */
import * as THREE from 'three';
import {
  BODY_DIAMETER_KM,
  HEIGHT_MODES,
  TWILIGHT_EDGES_DEG,
  skyState,
  subBodyPoint,
  sunHeightKm,
} from './skyMath.js';
import { Body } from '../vendor/astronomy-engine/astronomy.js';

const KM = 1000;
const KM_PER_DEG = 10001.966 / 90;
const SPOT_RADIUS_KM = 10000;
const SPOT_SOFT_KM = 1500;
const TRAIL_DAYS = 30;
const TRAIL_STEP_MIN = 30;
const SIZE_BOOST = 20;
const NEAR_M = 1.5e5;
const FAR_M = 3e6;
const REFRESH_MS = 1000;
const CHUNKS_V = '#include <common>\n#include <logdepthbuf_pars_vertex>';
const CHUNKS_F = '#include <common>\n#include <logdepthbuf_pars_fragment>';

const HEIGHT_LABEL = {
  coil: 'coil (cone-shaped, 3,828 to 5,828 km)',
  constant: 'constant 4,828 km',
  rowbotham: 'Rowbotham 1,127 km',
};

const fmt = (n, d = 0) =>
  Number(n).toLocaleString('en-US', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
const latLon = (lat, lon) =>
  `${fmt(Math.abs(lat), 1)}°${lat >= 0 ? 'N' : 'S'} ${fmt(Math.abs(lon), 1)}°${
    lon >= 0 ? 'E' : 'W'
  }`;

function lightMaterial(color, opacity) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

function moonMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uLight: { value: new THREE.Vector3(1, 0, 0) },
    },
    vertexShader: `
${CHUNKS_V}
varying vec3 vN;
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`,
    fragmentShader: `
${CHUNKS_F}
uniform vec3 uLight;
varying vec3 vN;
void main() {
  #include <logdepthbuf_fragment>
  float lit = clamp(dot(normalize(vN), uLight), 0.0, 1.0);
  vec3 col = mix(vec3(0.035, 0.04, 0.055), vec3(0.93, 0.92, 0.86), smoothstep(0.0, 0.35, lit) * (0.45 + 0.55 * lit));
  gl_FragColor = vec4(col, 1.0);
}`,
    toneMapped: false,
  });
}

function groundMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    uniforms: {
      uAx: { value: new THREE.Vector2(1, 0) },
      uAy: { value: new THREE.Vector2(0, 1) },
      uSubLonRad: { value: 0 },
      uDecRad: { value: 0 },
      uKmPerDeg: { value: KM_PER_DEG * KM },
      uCircleM: { value: 20003932 },
      uBands: { value: 1 },
      uDim: { value: 1 },
      uMode: { value: 0 },
      uSpot: { value: new THREE.Vector2() },
      uSpotR: { value: SPOT_RADIUS_KM * KM },
      uSpotSoft: { value: SPOT_SOFT_KM * KM },
      uFade: { value: 1 },
      uEdges: {
        value: TWILIGHT_EDGES_DEG.map((d) => Math.sin((d * Math.PI) / 180)),
      },
    },
    vertexShader: `
${CHUNKS_V}
varying vec2 vDisp;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vDisp = vec2(w.x, -w.z);
  gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
}`,
    fragmentShader: `
${CHUNKS_F}
uniform vec2 uAx; uniform vec2 uAy;
uniform float uSubLonRad; uniform float uDecRad; uniform float uKmPerDeg;
uniform float uCircleM; uniform float uBands; uniform float uDim; uniform float uMode;
uniform vec2 uSpot; uniform float uSpotR; uniform float uSpotSoft; uniform float uFade;
uniform float uEdges[4];
varying vec2 vDisp;
void main() {
  #include <logdepthbuf_fragment>
  vec2 p = uAx * vDisp.x + uAy * vDisp.y;
  float rho = length(p);
  float a = 0.0;
  if (uMode > 0.5) {
    float d = length(vDisp - uSpot);
    a = smoothstep(uSpotR - uSpotSoft, uSpotR + uSpotSoft, d) * 0.78;
  } else {
    float lat = 1.5707963 - rho / (uKmPerDeg * 90.0) * 1.5707963;
    float lon = atan(p.x, -p.y);
    float s = sin(lat) * sin(uDecRad) + cos(lat) * cos(uDecRad) * cos(lon - uSubLonRad);
    if (uBands > 0.5) {
      a = s < uEdges[0] ? 0.10 : 0.0;
      a = s < uEdges[1] ? 0.22 : a;
      a = s < uEdges[2] ? 0.34 : a;
      a = s < uEdges[3] ? 0.46 : a;
    }
  }
  if (uMode < 0.5 && uDim > 0.5 && rho > uCircleM) a = max(a, 0.55);
  a *= uFade;
  if (a < 0.003) discard;
  gl_FragColor = vec4(0.0, 0.01, 0.04, a);
}`,
  });
}

export class SkyBodies {
  constructor({ frame }) {
    this.frame = frame;
    this.opts = {
      show: true,
      cards: true,
      mode: 'coil',
      moonPlace: 'dark',
      dayNight: 'A',
      bands: true,
      dim: true,
      trail: true,
      boost: true,
    };
    this.state = null;
    this._lastRefresh = -1e9;
    this._trailCache = new Map();
    this._trailKey = '';
    this.group = new THREE.Group();
    this.group.name = 'flatworld-sky';
  }

  attach(view) {
    this.view = view;
    const sphere = new THREE.SphereGeometry(1, 40, 24);
    this.sun = new THREE.Mesh(
      sphere,
      new THREE.MeshBasicMaterial({ color: 0xffe9a0, toneMapped: false }),
    );
    this.moon = new THREE.Mesh(sphere, moonMaterial());
    this.cone = new THREE.Mesh(
      new THREE.ConeGeometry(1, 1, 48, 1, true),
      lightMaterial(0xffd98a, 0.1),
    );
    this.cone.geometry.translate(0, -0.5, 0);
    this.trailLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: 0xffd36b,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
      }),
    );
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4e8, 1.4e8),
      groundMaterial(),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = 30;
    this.ground.renderOrder = 6;
    for (const o of [
      this.sun,
      this.moon,
      this.cone,
      this.trailLine,
      this.ground,
    ]) {
      o.frustumCulled = false;
      this.group.add(o);
    }
    this.sun.renderOrder = 8;
    this.moon.renderOrder = 8;
    this.cone.renderOrder = 7;
    this.trailLine.renderOrder = 7;
    view.scene.add(this.group);
    this._buildDom();
    this._nightLevel = view.chunks?.material?.uniforms?.uNightLevel?.value;
  }

  destroy() {
    this._restoreNight();
    this.view?.scene.remove(this.group);
    this.group.traverse((o) => {
      o.geometry?.dispose?.();
      o.material?.dispose?.();
    });
    this.dom?.remove();
    this.cards?.remove();
  }

  /** Public so the build session can drive it from the URL or panel if it wants to. */
  setOptions(next) {
    Object.assign(this.opts, next);
    this._lastRefresh = -1e9;
    this._syncControls();
  }

  _simDate() {
    const t = this.view.time || {};
    return t.date ?? new Date(Date.now() + (t.offsetMinutes || 0) * 60000);
  }

  _restoreNight() {
    const u = this.view?.chunks?.material?.uniforms?.uNightLevel;
    if (u && this._nightLevel !== undefined) u.value = this._nightLevel;
  }

  _toThree(w, out) {
    return out.set(w.x, w.z, -w.y);
  }

  _scaleFor(distM) {
    if (!this.opts.boost) return 1;
    const t = THREE.MathUtils.clamp(
      Math.log(distM / NEAR_M) / Math.log(FAR_M / NEAR_M),
      0,
      1,
    );
    return Math.pow(SIZE_BOOST, t);
  }

  update(dt, view) {
    const now = performance.now();
    this.group.visible = this.opts.show;
    if (!this.opts.show) {
      this.cards.style.display = 'none';
      this.corner.style.display = 'none';
      this._restoreNight();
      return;
    }
    if (now - this._lastRefresh > REFRESH_MS) {
      this._lastRefresh = now;
      this.state = skyState(this._simDate(), this.frame, {
        mode: this.opts.mode,
        moonPlace: this.opts.moonPlace,
      });
      this._updateTrail();
      this._updateGroundUniforms();
    }
    const st = this.state;
    if (!st) return;
    const cam = view.camera.position;
    const sp = this._toThree(
      st.sun.world,
      this._v1 || (this._v1 = new THREE.Vector3()),
    );
    const mp = this._toThree(
      st.moon.world,
      this._v2 || (this._v2 = new THREE.Vector3()),
    );
    const trueR = (BODY_DIAMETER_KM / 2) * KM;

    const ks = this._scaleFor(cam.distanceTo(sp));
    const km = this._scaleFor(cam.distanceTo(mp));
    this.sun.position.copy(sp);
    this.sun.scale.setScalar(trueR * ks);
    this.moon.position.copy(mp);
    this.moon.scale.setScalar(trueR * km);
    this._updateMoonLight(sp, mp, cam);

    // Glow cone: apex at the sun, opening to a footprint on the ground below it.
    const h = st.sun.heightM;
    this.cone.position.set(sp.x, h, sp.z);
    this.cone.scale.set(
      Math.max(trueR * ks * 6, 250 * KM),
      h,
      Math.max(trueR * ks * 6, 250 * KM),
    );
    this.cone.position.y = h;

    const fade = THREE.MathUtils.clamp(
      (view.focus?.altitude ?? 1e6) / 40000 - 0.5,
      0,
      1,
    );
    this.ground.material.uniforms.uFade.value = fade;
    this.ground.visible = fade > 0.01;
    this._updateNightLevel();
    this._updateCards(st, ks);
  }

  _updateNightLevel() {
    const u = this.view?.chunks?.material?.uniforms?.uNightLevel;
    if (!u) return;
    // Option B replaces real shading with the spotlight; hand the terrain shader back full light.
    u.value = this.opts.dayNight === 'B' ? 1 : (this._nightLevel ?? u.value);
  }

  _updateMoonLight(sp, mp, cam) {
    const st = this.state;
    const v = this._v3 || (this._v3 = new THREE.Vector3());
    const s = this._v4 || (this._v4 = new THREE.Vector3());
    v.copy(cam).sub(mp).normalize();
    s.copy(sp).sub(mp).normalize();
    s.addScaledVector(v, -s.dot(v));
    if (s.lengthSq() < 1e-8) s.set(v.y, -v.x, 0);
    s.normalize();
    const pa = ((180 - st.moon.phaseDeg) * Math.PI) / 180;
    const L = this.moon.material.uniforms.uLight.value;
    L.copy(v)
      .multiplyScalar(Math.cos(pa))
      .addScaledVector(s, Math.sin(pa))
      .normalize();
  }

  _updateGroundUniforms() {
    const st = this.state;
    const u = this.ground.material.uniforms;
    const o = this.frame.fromDisplay(0, 0);
    const ax = this.frame.fromDisplay(1, 0);
    const ay = this.frame.fromDisplay(0, 1);
    u.uAx.value.set(ax.x - o.x, ax.y - o.y);
    u.uAy.value.set(ay.x - o.x, ay.y - o.y);
    u.uSubLonRad.value = (st.sun.lon * Math.PI) / 180;
    u.uDecRad.value = (st.sun.dec * Math.PI) / 180;
    u.uCircleM.value = this.frame.boundaryRadius ?? 20003932;
    u.uBands.value = this.opts.bands ? 1 : 0;
    u.uDim.value = this.opts.dim ? 1 : 0;
    u.uMode.value = this.opts.dayNight === 'B' ? 1 : 0;
    u.uSpot.value.set(st.sun.world.x, st.sun.world.y);
  }

  _updateTrail() {
    const line = this.trailLine;
    line.visible = this.opts.trail;
    if (!this.opts.trail) return;
    const stepMs = TRAIL_STEP_MIN * 60000;
    const end = Math.floor(this.state.date.getTime() / stepMs);
    const key = `${this.opts.mode}:${end}`;
    if (key === this._trailKey) return;
    this._trailKey = key;
    const n = (TRAIL_DAYS * 1440) / TRAIL_STEP_MIN;
    const pos = new Float32Array((n + 2) * 3);
    const v = new THREE.Vector3();
    let k = 0;
    for (let i = end - n; i <= end; i += 1) {
      let s = this._trailCache.get(i);
      if (!s) {
        s = subBodyPoint(Body.Sun, new Date(i * stepMs));
        this._trailCache.set(i, s);
      }
      const w = this.frame.geodeticToWorld(
        s.lat,
        s.lon,
        sunHeightKm(s.dec, this.opts.mode) * KM,
      );
      this._toThree(w, v);
      pos[k++] = v.x;
      pos[k++] = v.y;
      pos[k++] = v.z;
    }
    if (this._trailCache.size > n * 3) {
      for (const key2 of this._trailCache.keys()) {
        if (key2 < end - n) this._trailCache.delete(key2);
      }
    }
    this._toThree(this.state.sun.world, v);
    pos[k++] = v.x;
    pos[k++] = v.y;
    pos[k++] = v.z;
    line.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(pos.subarray(0, k), 3),
    );
    line.geometry.computeBoundingSphere();
  }

  _buildDom() {
    const host = this.view.host || document.body;
    const css = document.createElement('style');
    css.textContent = `
.fw-sky-panel{position:fixed;right:12px;bottom:70px;z-index:30;background:rgba(8,14,28,.82);color:#dfe9ff;font:12px/1.35 system-ui,sans-serif;padding:8px 10px;border-radius:8px;width:230px;box-sizing:border-box;backdrop-filter:blur(6px)}
.fw-sky-panel b{display:block;margin-bottom:4px}
.fw-sky-panel label{display:flex;align-items:center;gap:6px;margin:2px 0}
.fw-sky-panel select{display:block;width:100%;margin:2px 0;background:#14213d;color:#dfe9ff;border:1px solid #2c4170;border-radius:4px;font:inherit}
.fw-sky-panel small{display:block;margin-top:4px;color:#9fb4de}
.fw-sky-corner{position:fixed;left:12px;bottom:12px;z-index:30;color:#ffd98a;font:12px system-ui,sans-serif;background:rgba(8,14,28,.7);padding:3px 8px;border-radius:6px;pointer-events:none}
.fw-sky-cards{position:fixed;inset:0;pointer-events:none;z-index:29;overflow:hidden}
.fw-sky-card{position:absolute;transform:translate(14px,-50%);background:rgba(8,14,28,.85);color:#e8f0ff;font:11px/1.35 system-ui,sans-serif;padding:6px 8px;border-radius:6px;max-width:260px;white-space:normal}
.fw-sky-card i{display:block;color:#9fb4de;font-style:normal;margin-top:3px}`;
    document.head.appendChild(css);
    this.cards = document.createElement('div');
    this.cards.className = 'fw-sky-cards';
    this.cardSun = document.createElement('div');
    this.cardMoon = document.createElement('div');
    this.cardSun.className = this.cardMoon.className = 'fw-sky-card';
    this.cards.append(this.cardSun, this.cardMoon);
    this.corner = document.createElement('div');
    this.corner.className = 'fw-sky-corner';
    this.dom = document.createElement('div');
    this.dom.className = 'fw-sky-panel';
    this.dom.innerHTML = `<b>Sun &amp; moon</b>
<label><input type="checkbox" data-k="show"> show sun &amp; moon</label>
<label><input type="checkbox" data-k="cards"> info cards</label>
<label>Height <select data-k="mode">${HEIGHT_MODES.map(
      (m) => `<option value="${m}">${HEIGHT_LABEL[m]}</option>`,
    ).join('')}</select></label>
<label>Moon <select data-k="moonPlace"><option value="dark">on the dark side (model choice)</option><option value="real">real ephemeris position</option></select></label>
<label>Day/night <select data-k="dayNight"><option value="A">A: real sun angle</option><option value="B">B: 10,000 km spotlight (hypothetical)</option></select></label>
<label><input type="checkbox" data-k="bands"> twilight bands</label>
<label><input type="checkbox" data-k="dim"> dim ice outside GPS circle</label>
<label><input type="checkbox" data-k="trail"> 30-day trail</label>
<label><input type="checkbox" data-k="boost"> size x20 (off = true size)</label>
<small data-k="note"></small>`;
    host.append(this.cards, this.corner, this.dom);
    this.dom.addEventListener('change', (e) => {
      const k = e.target.dataset.k;
      if (!k) return;
      this.opts[k] =
        e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      this._lastRefresh = -1e9;
      this._trailKey = '';
      this._syncControls();
    });
    this._syncControls();
  }

  _syncControls() {
    if (!this.dom) return;
    for (const el of this.dom.querySelectorAll('[data-k]')) {
      const k = el.dataset.k;
      if (k === 'note') continue;
      if (el.type === 'checkbox') el.checked = !!this.opts[k];
      else el.value = this.opts[k];
    }
    this.dom.querySelector('[data-k=note]').textContent =
      this.opts.dayNight === 'B'
        ? 'Spotlight is a published-model idea. It does not match real day lengths (Sydney gets about 6 h of daylight in December instead of 14.3 h).'
        : 'Day and night follow the real sun angle. Heights are a model setting.';
  }

  _project(vec) {
    const s = this.view.worldToScreen(vec);
    return s && Number.isFinite(s.x) ? s : null;
  }

  _updateCards(st, ks) {
    this.cards.style.display = this.opts.cards ? '' : 'none';
    this.corner.style.display = '';
    this.corner.textContent = this.opts.boost
      ? `size x${fmt(ks, ks < 2 ? 1 : 0)} for visibility (true diameter ${BODY_DIAMETER_KM} km)`
      : `true size (${BODY_DIAMETER_KM} km)`;
    const note = 'Position from real ephemeris; height is a model setting.';
    const sunPos = this._project(this.sun.position);
    const moonPos = this._project(this.moon.position);
    const near =
      sunPos &&
      moonPos &&
      Math.hypot(sunPos.x - moonPos.x, sunPos.y - moonPos.y) < 130;
    const place = (el, s, html, dy = 0) => {
      if (!s) {
        el.style.display = 'none';
        return;
      }
      el.style.display = '';
      el.style.left = `${s.x}px`;
      el.style.top = `${s.y + dy}px`;
      el.innerHTML = html;
    };
    const mode = HEIGHT_LABEL[this.opts.mode];
    place(
      this.cardSun,
      sunPos,
      `<b>Sun</b> ${latLon(st.sun.lat, st.sun.lon)}, ${fmt(st.sun.radiusM / KM)} km from the pole<br>
height ${fmt(st.sun.heightM / KM)} km, ${mode}<br>season: ${st.season}<i>${note}</i>`,
    );
    const frac = Math.round(st.moon.illuminatedFraction * 100);
    const moonNote =
      st.moonPlace === 'real'
        ? note
        : `Placed on the night side opposite the sun (model choice). Real position: ${latLon(st.moon.realLat, st.moon.realLon)}. Phase is real.`;
    place(
      this.cardMoon,
      moonPos,
      `<b>Moon</b> ${latLon(st.moon.lat, st.moon.lon)}, ${fmt(st.moon.radiusM / KM)} km from the pole<br>
height ${fmt(st.moon.heightM / KM)} km, ${mode}<br>phase: ${st.moon.phaseName} (${frac}% lit), season: ${st.season}<i>${moonNote}</i>`,
      near ? 150 : 0,
    );
  }
}
