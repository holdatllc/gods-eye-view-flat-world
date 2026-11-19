/**
 * Dome sky model (from the owner's TikTok): sun and moon 3,000 miles up and 32 miles wide over
 * their real sub-points, stars and planets fixed to a dome 3,100 miles up that turns about Polaris
 * once per sidereal day, and the curved light path from the dome sun to the view centre that the
 * model needs to match real sunrises and sunsets. Numbers and their sources are in domeMath.js.
 *
 * Ground light is unchanged: the terrain stays lit by the real sun angle, which is what the video
 * says this model uses for what people actually see.
 */
import * as THREE from 'three';
import {
  Body,
  EquatorFromVector,
  Illumination,
  MakeTime,
  MoonPhase,
  RotateVector,
  Rotation_EQJ_EQD,
  SiderealTime,
  Spherical,
  VectorFromSphere,
} from '../vendor/astronomy-engine/astronomy.js';
import {
  moonPhaseName,
  seasonLabel,
  subBodyPoint,
  wrap180,
} from './skyMath.js';
import { moonMaterial } from './skyBodies.js';
import { sunLocal } from '../render/sun.js';
import { northAt } from '../render/controls.js';
import {
  BODY_DIAMETER_MI,
  DOME_FLAT_RADIUS_MI,
  MI,
  MOON_HEIGHT_MI,
  STAR_DOME_MI,
  SUN_HEIGHT_MI,
  bentRay,
  domeHeightM,
  straightElevationDeg,
} from './domeMath.js';
import {
  BRIGHT_STARS,
  CONSTELLATION_LINES,
  LABELLED_STARS,
} from './brightStars.js';

const DEG = Math.PI / 180;
const SIZE_BOOST = 20;
const NEAR_M = 1.5e5;
const FAR_M = 3e6;
const BODY_REFRESH_MS = 100;
const TEXT_REFRESH_MS = 500;
const FILLER_STARS = 2500;
const PLANETS = [
  ['Mercury', Body.Mercury, 0xd8c7a8],
  ['Venus', Body.Venus, 0xfff4d6],
  ['Mars', Body.Mars, 0xff8a5c],
  ['Jupiter', Body.Jupiter, 0xffe2b0],
  ['Saturn', Body.Saturn, 0xf2d58c],
];

const fmt = (n, d = 0) =>
  Number(n).toLocaleString('en-US', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
const latLon = (lat, lon) =>
  `${fmt(Math.abs(lat), 1)}°${lat >= 0 ? 'N' : 'S'} ${fmt(Math.abs(lon), 1)}°${
    lon >= 0 ? 'E' : 'W'
  }`;
const miles = (m) => `${fmt(m / MI)} mi`;

/** Right ascension / declination of date for a J2000 catalogue position. */
function precess(raHours, decDeg, time) {
  const v = VectorFromSphere(new Spherical(decDeg, raHours * 15, 1), time);
  const eq = EquatorFromVector(RotateVector(Rotation_EQJ_EQD(time), v));
  return { ra: eq.ra, dec: eq.dec };
}

function starColor(name, mag) {
  const warm = ['Betelgeuse', 'Antares', 'Aldebaran', 'Arcturus', 'Pollux'];
  const blue = ['Rigel', 'Spica', 'Vega', 'Sirius', 'Achernar', 'Regulus'];
  const c = new THREE.Color(
    warm.includes(name) ? 0xffc89a : blue.includes(name) ? 0xcfe0ff : 0xffffff,
  );
  return c.multiplyScalar(THREE.MathUtils.clamp(1.25 - mag * 0.18, 0.35, 1));
}

function pointsMaterial(size) {
  return new THREE.PointsMaterial({
    size,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
}

export class DomeSky {
  constructor({ frame }) {
    this.frame = frame;
    this.opts = {
      bodies: true,
      stars: true,
      planets: true,
      dome: true,
      circles: true,
      ray: true,
      labels: true,
      boost: true,
    };
    this.group = new THREE.Group();
    this.group.name = 'flatworld-dome-sky';
    this._lastBodies = -1e9;
    this._lastText = -1e9;
    this.state = null;
  }

  attach(view) {
    this.view = view;
    const rim = this.frame.boundaryRadius;
    this.rim = rim;
    this._lonSign = this._measureLonSign();

    // Sun, its glow, and the moon (phase-lit with the spec model's shader).
    const sphere = new THREE.SphereGeometry(1, 40, 24);
    this.sun = new THREE.Mesh(
      sphere,
      new THREE.MeshBasicMaterial({ color: 0xffe9a0, toneMapped: false }),
    );
    this.halo = new THREE.Mesh(
      sphere,
      new THREE.MeshBasicMaterial({
        color: 0xffc860,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    );
    this.moon = new THREE.Mesh(sphere, moonMaterial());
    for (const m of [this.sun, this.halo, this.moon]) m.renderOrder = 8;

    this.dome = this._makeDome();
    this.domeGrid = this._makeDomeGrid();
    this.starGroup = new THREE.Group();
    this._makeStars();
    this.planets = this._makePlanets();

    // Daily circles: the sun's and moon's today, and the two tropics that bound the sun's year.
    this.sunCircle = this._circle(0xffd36b, 0.55);
    this.moonCircle = this._circle(0x9fd8ff, 0.45);
    this.cancer = this._circle(0xffd36b, 0.18);
    this.capricorn = this._circle(0xffd36b, 0.18);
    this.straight = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({
        color: 0xff7a59,
        dashSize: 60000,
        gapSize: 45000,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      }),
    );
    // The bent ray is a thin tube (WebGL lines are one pixel wide), sized to stay ~2 px.
    this.bent = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: 0xfff0a0,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      }),
    );
    this.bent.renderOrder = 9;
    this._lastTube = -1e9;
    for (const o of [
      this.sun,
      this.halo,
      this.moon,
      this.dome,
      this.domeGrid,
      this.starGroup,
      this.planets,
      this.sunCircle,
      this.moonCircle,
      this.cancer,
      this.capricorn,
      this.straight,
      this.bent,
    ]) {
      o.frustumCulled = false;
      this.group.add(o);
    }
    this.group.traverse((o) => {
      o.frustumCulled = false;
    });
    view.scene.add(this.group);
    this._buildDom();
  }

  destroy() {
    if (this.view?.stars) this.view.stars.visible = true;
    this.view?.scene.remove(this.group);
    this.group.traverse((o) => {
      o.geometry?.dispose?.();
      o.material?.dispose?.();
    });
    this.dom?.remove();
    this.labels?.remove();
    this.css?.remove();
  }

  /** +1 when a larger longitude turns the three.js scene positively about +Y, else −1. */
  _measureLonSign() {
    const a = (lon) => {
      const w = this.frame.geodeticToWorld(0, lon, 0);
      return Math.atan2(w.y, w.x);
    };
    return Math.sign(wrap180((a(90) - a(0)) / DEG)) || 1;
  }

  _toThree(w, h) {
    return new THREE.Vector3(w.x, h, -w.y);
  }

  _makeDome() {
    const H = STAR_DOME_MI * MI;
    const r0 = DOME_FLAT_RADIUS_MI * MI;
    const pts = [new THREE.Vector2(0, H)];
    for (let i = 1; i <= 8; i += 1)
      pts.push(new THREE.Vector2((r0 * i) / 8, H));
    for (let i = 1; i <= 48; i += 1) {
      const t = (i / 48) * (Math.PI / 2);
      pts.push(
        new THREE.Vector2(r0 + (this.rim - r0) * Math.sin(t), H * Math.cos(t)),
      );
    }
    const mesh = new THREE.Mesh(
      new THREE.LatheGeometry(pts, 160),
      new THREE.MeshBasicMaterial({
        color: 0x86b8ff,
        transparent: true,
        opacity: 0.07,
        side: THREE.DoubleSide,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      }),
    );
    mesh.renderOrder = 5;
    return mesh;
  }

  _makeDomeGrid() {
    const pos = [];
    const at = (r, a) => {
      const h = domeHeightM(r, this.rim);
      return [Math.cos(a) * r, h, Math.sin(a) * r];
    };
    const seg = 180;
    for (const rMi of [
      1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 10000, 11500,
    ]) {
      const r = rMi * MI;
      if (r >= this.rim) continue;
      for (let i = 0; i < seg; i += 1) {
        pos.push(
          ...at(r, (i / seg) * 2 * Math.PI),
          ...at(r, ((i + 1) / seg) * 2 * Math.PI),
        );
      }
    }
    for (let k = 0; k < 24; k += 1) {
      const a = (k / 24) * 2 * Math.PI;
      for (let i = 0; i < 60; i += 1) {
        pos.push(
          ...at((this.rim * i) / 60, a),
          ...at((this.rim * (i + 1)) / 60, a),
        );
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const lines = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({
        color: 0x9cc6ff,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        fog: false,
      }),
    );
    lines.renderOrder = 5;
    return lines;
  }

  /** Stars at their sub-star points for sidereal time 0; the group turns with sidereal time. */
  _starPoint(raHours, decDeg) {
    const w = this.frame.geodeticToWorld(decDeg, wrap180(raHours * 15), 0);
    return this._toThree(w, domeHeightM(Math.hypot(w.x, w.y), this.rim));
  }

  _makeStars() {
    const time = MakeTime(this._simDate());
    this.starPos = new Map();
    const buckets = [
      { max: 0.5, size: 5.2 },
      { max: 1.5, size: 4 },
      { max: 2.5, size: 3 },
      { max: 99, size: 2.3 },
    ].map((b) => ({ ...b, pos: [], col: [] }));
    for (const [name, ra, dec, mag] of BRIGHT_STARS) {
      const p = precess(ra, dec, time);
      const v = this._starPoint(p.ra, p.dec);
      this.starPos.set(name, v);
      const b = buckets.find((x) => mag <= x.max);
      const c = starColor(name, mag);
      b.pos.push(v.x, v.y, v.z);
      b.col.push(c.r, c.g, c.b);
    }
    this.starMaterials = [];
    for (const b of buckets) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
      const m = pointsMaterial(b.size);
      this.starMaterials.push(m);
      const pts = new THREE.Points(g, m);
      pts.renderOrder = 6;
      this.starGroup.add(pts);
    }
    // Faint background stars: decorative, seeded random positions (not a catalogue).
    let seed = 1789;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const fpos = [];
    const fcol = [];
    for (let i = 0; i < FILLER_STARS; i += 1) {
      const dec = Math.asin(rnd() * 2 - 1) / DEG;
      const v = this._starPoint(rnd() * 24, dec);
      const k = 0.25 + rnd() * 0.35;
      fpos.push(v.x, v.y, v.z);
      fcol.push(k, k, k * 1.05);
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(fpos, 3));
    fg.setAttribute('color', new THREE.Float32BufferAttribute(fcol, 3));
    const fm = pointsMaterial(1.6);
    this.starMaterials.push(fm);
    const filler = new THREE.Points(fg, fm);
    filler.renderOrder = 6;
    this.starGroup.add(filler);

    const lpos = [];
    for (const [a, b] of CONSTELLATION_LINES) {
      const pa = this.starPos.get(a);
      const pb = this.starPos.get(b);
      if (pa && pb) lpos.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lpos, 3));
    this.figureMaterial = new THREE.LineBasicMaterial({
      color: 0x8fb4ff,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      fog: false,
    });
    this.starGroup.add(new THREE.LineSegments(lg, this.figureMaterial));
  }

  _makePlanets() {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(new Float32Array(PLANETS.length * 3), 3),
    );
    const col = [];
    for (const [, , hex] of PLANETS) {
      const c = new THREE.Color(hex);
      col.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.planetMaterial = pointsMaterial(4.5);
    const p = new THREE.Points(g, this.planetMaterial);
    p.renderOrder = 6;
    return p;
  }

  _circle(color, opacity) {
    const n = 256;
    const pos = [];
    for (let i = 0; i < n; i += 1) {
      const a = (i / n) * Math.PI * 2;
      pos.push(Math.cos(a), 0, Math.sin(a));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const line = new THREE.LineLoop(
      g,
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false,
        fog: false,
      }),
    );
    line.renderOrder = 7;
    return line;
  }

  _setCircle(line, radiusM, heightM) {
    line.scale.set(radiusM, 1, radiusM);
    line.position.set(0, heightM, 0);
  }

  _simDate() {
    const t = this.view?.time || {};
    return t.date ?? new Date(Date.now() + (t.offsetMinutes || 0) * 60000);
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

  setOptions(next) {
    Object.assign(this.opts, next);
    this._lastBodies = -1e9;
    this._lastText = -1e9;
    this._syncControls();
  }

  /** Model state for one instant (positions real, heights and sizes the video's). */
  computeState(date) {
    const sun = subBodyPoint(Body.Sun, date);
    const moon = subBodyPoint(Body.Moon, date);
    const sunH = SUN_HEIGHT_MI * MI;
    const moonH = MOON_HEIGHT_MI * MI;
    const sw = this.frame.geodeticToWorld(sun.lat, sun.lon, sunH);
    const mw = this.frame.geodeticToWorld(moon.lat, moon.lon, moonH);
    const ahead = subBodyPoint(Body.Sun, new Date(date.getTime() + 86400000));
    const phaseDeg = MoonPhase(date);
    const planets = PLANETS.map(([name, body]) => {
      const p = subBodyPoint(body, date);
      const w = this.frame.geodeticToWorld(p.lat, p.lon, 0);
      const h = domeHeightM(Math.hypot(w.x, w.y), this.rim);
      return { name, ...p, world: w, heightM: h };
    });
    return {
      date,
      gstHours: SiderealTime(MakeTime(date)),
      sun: {
        ...sun,
        heightM: sunH,
        world: sw,
        radiusM: Math.hypot(sw.x, sw.y),
      },
      moon: {
        ...moon,
        heightM: moonH,
        world: mw,
        radiusM: Math.hypot(mw.x, mw.y),
        phaseDeg,
        phaseName: moonPhaseName(phaseDeg),
        illuminatedFraction: Illumination(Body.Moon, date).phase_fraction,
      },
      planets,
      season: seasonLabel(sun.dec, ahead.dec > sun.dec),
    };
  }

  _tropicRadius(decDeg) {
    const w = this.frame.geodeticToWorld(decDeg, 0, 0);
    return Math.hypot(w.x, w.y);
  }

  update(dt, view) {
    const now = performance.now();
    if (now - this._lastBodies > BODY_REFRESH_MS) {
      this._lastBodies = now;
      this.state = this.computeState(this._simDate());
    }
    const st = this.state;
    if (!st) return;
    const o = this.opts;
    const cam = view.camera.position;
    const alt = view.focus?.altitude ?? 1e6;

    // Night level the original view computed for its own stars this frame; those stars are
    // replaced by the dome's, which also show whenever the camera is up near the dome.
    const night = THREE.MathUtils.clamp(
      (view.stars?.material.color.r ?? 0.9) / 0.9,
      0,
      1,
    );
    if (view.stars && o.stars) view.stars.visible = false;
    const nearDome = THREE.MathUtils.smoothstep(alt, 4e5, 3e6);
    const starLevel = Math.max(night, nearDome);
    this.starGroup.visible = o.stars && starLevel > 0.03;
    this.starGroup.rotation.y = this._lonSign * -st.gstHours * 15 * DEG;
    for (const m of this.starMaterials) m.opacity = starLevel;
    this.figureMaterial.opacity = 0.35 * starLevel;

    const domeFade = THREE.MathUtils.smoothstep(alt, 2e5, 2.5e6);
    this.dome.visible = o.dome && domeFade > 0.01;
    this.domeGrid.visible = this.dome.visible;
    this.dome.material.opacity = 0.07 * domeFade;
    this.domeGrid.material.opacity = 0.16 * domeFade;

    // Sun and moon.
    const sp = this._toThree(st.sun.world, st.sun.heightM);
    const mp = this._toThree(st.moon.world, st.moon.heightM);
    const trueR = (BODY_DIAMETER_MI / 2) * MI;
    const ks = this._scaleFor(cam.distanceTo(sp));
    const km = this._scaleFor(cam.distanceTo(mp));
    for (const m of [this.sun, this.halo, this.moon]) m.visible = o.bodies;
    this.sun.position.copy(sp);
    this.sun.scale.setScalar(trueR * ks);
    this.halo.position.copy(sp);
    this.halo.scale.setScalar(trueR * ks * 1.7);
    this.moon.position.copy(mp);
    this.moon.scale.setScalar(trueR * km);
    this._updateMoonLight(sp, mp, cam);

    // Planets on the dome.
    this.planets.visible = o.planets && starLevel > 0.03;
    this.planetMaterial.opacity = Math.max(starLevel, 0.4);
    const pa = this.planets.geometry.attributes.position;
    st.planets.forEach((p, i) => {
      pa.setXYZ(i, p.world.x, p.heightM, -p.world.y);
    });
    pa.needsUpdate = true;

    // Circles.
    for (const c of [
      this.sunCircle,
      this.moonCircle,
      this.cancer,
      this.capricorn,
    ])
      c.visible = o.circles;
    this._setCircle(this.sunCircle, st.sun.radiusM, st.sun.heightM);
    this._setCircle(this.moonCircle, st.moon.radiusM, st.moon.heightM);
    this._setCircle(this.cancer, this._tropicRadius(23.44), st.sun.heightM);
    this._setCircle(this.capricorn, this._tropicRadius(-23.44), st.sun.heightM);

    this._updateRay(st, sp, view);
    if (now - this._lastText > TEXT_REFRESH_MS) {
      this._lastText = now;
      this._updateReadout(st);
    }
    this._updateLabels(st, sp, mp);
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
    this.moon.material.uniforms.uLight.value
      .copy(v)
      .multiplyScalar(Math.cos(pa))
      .addScaledVector(s, Math.sin(pa))
      .normalize();
  }

  /** The observer is the view centre on the real map. */
  _observer(view) {
    const f = view.focus;
    if (!f || f.domain?.domain !== 'gps') return null;
    return {
      lat: f.domain.lat,
      lon: f.domain.lon,
      x: f.x,
      y: f.y,
      ground: f.ground ?? 0,
      radiusM: Math.hypot(f.x, f.y),
    };
  }

  _updateRay(st, sp, view) {
    const obs = this._observer(view);
    this.obs = null;
    if (!this.opts.ray || !obs) {
      this.straight.visible = false;
      this.bent.visible = false;
      return;
    }
    const real = sunLocal(obs.lat, obs.lon, st.date);
    const n = northAt(obs.x, obs.y);
    const e = { x: n.y, y: -n.x };
    const arrive = [
      real.east * e.x + real.north * n.x,
      real.up,
      -(real.east * e.y + real.north * n.y),
    ];
    const ground = Math.hypot(st.sun.world.x - obs.x, st.sun.world.y - obs.y);
    const straightDeg = straightElevationDeg(
      st.sun.heightM,
      ground,
      obs.ground,
    );
    const polarisDeg = straightElevationDeg(
      STAR_DOME_MI * MI,
      obs.radiusM,
      obs.ground,
    );
    this.obs = { ...obs, real, straightDeg, polarisDeg, groundM: ground };

    const o3 = [obs.x, obs.ground + 50, -obs.y];
    const s3 = [sp.x, sp.y, sp.z];
    this.straight.geometry.setFromPoints([
      new THREE.Vector3(...s3),
      new THREE.Vector3(...o3),
    ]);
    this.straight.computeLineDistances();
    this.straight.visible = true;
    const up = real.elevationDeg > -0.833;
    this.bent.visible = up;
    const now = performance.now();
    if (up && now - this._lastTube > BODY_REFRESH_MS) {
      this._lastTube = now;
      const pts = bentRay(s3, o3, arrive, 64).map(
        (p) => new THREE.Vector3(...p),
      );
      const camD = view.camera.position.distanceTo(pts.at(-1));
      const radius = THREE.MathUtils.clamp(camD * 0.0011, 30, 40000);
      this.bent.geometry.dispose();
      this.bent.geometry = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(pts),
        96,
        radius,
        6,
        false,
      );
    }
  }

  _buildDom() {
    const host = this.view.host || document.body;
    this.css = document.createElement('style');
    this.css.textContent = `
.fw-dome-panel{position:fixed;right:12px;bottom:70px;z-index:1000;background:rgba(8,14,28,.84);color:#dfe9ff;font:12px/1.35 system-ui,sans-serif;padding:8px 10px;border-radius:8px;width:268px;box-sizing:border-box;backdrop-filter:blur(6px);max-height:calc(100vh - 140px);overflow:auto}
.fw-dome-panel b{display:block;margin-bottom:4px}
.fw-dome-panel .fw-dome-title{cursor:pointer;user-select:none}
.fw-dome-panel.collapsed>:not(.fw-dome-title){display:none}
.fw-dome-panel label{display:flex;align-items:center;gap:6px;margin:2px 0}
.fw-dome-panel .fw-dome-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 6px}
.fw-dome-panel .fw-dome-read{margin-top:6px;border-top:1px solid #2c4170;padding-top:6px}
.fw-dome-panel .fw-dome-read p{margin:0 0 5px}
.fw-dome-panel small{display:block;margin-top:4px;color:#9fb4de}
.fw-dome-labels{position:fixed;inset:0;pointer-events:none;z-index:29;overflow:hidden}
.fw-dome-label{position:absolute;transform:translate(10px,-50%);color:#e8f0ff;font:11px system-ui,sans-serif;text-shadow:0 0 3px #000,0 0 6px #000;white-space:nowrap}
.fw-dome-label.sun{color:#ffe08a}.fw-dome-label.moon{color:#bfe6ff}.fw-dome-label.planet{color:#ffd9b0}`;
    document.head.appendChild(this.css);
    this.labels = document.createElement('div');
    this.labels.className = 'fw-dome-labels';
    this.dom = document.createElement('div');
    this.dom.className = 'fw-dome-panel';
    const box = (k, text) =>
      `<label><input type="checkbox" data-k="${k}"> ${text}</label>`;
    this.dom.innerHTML = `<b class="fw-dome-title" title="Show or hide">Dome model (from the video) ▾</b>
<div class="fw-dome-grid">${box('bodies', 'sun &amp; moon')}${box('stars', 'stars')}${box(
      'planets',
      'planets',
    )}${box('dome', 'dome')}${box('circles', 'daily circles')}${box(
      'ray',
      'light ray',
    )}${box('labels', 'labels')}${box('boost', 'size x20')}</div>
<div class="fw-dome-read" data-r="read"></div>
<small>Sun and moon ${fmt(SUN_HEIGHT_MI)} mi up and ${BODY_DIAMETER_MI} mi wide; stars and planets on the dome ${fmt(STAR_DOME_MI)} mi up, turning about Polaris once every 23 h 56 m. Positions are the real ephemeris; heights and sizes are the video's model. Ground light follows the real sun.</small>`;
    host.append(this.labels, this.dom);
    this.read = this.dom.querySelector('[data-r=read]');
    this.dom
      .querySelector('.fw-dome-title')
      .addEventListener('click', () => this.dom.classList.toggle('collapsed'));
    this.dom.addEventListener('change', (e) => {
      const k = e.target.dataset.k;
      if (!k) return;
      this.opts[k] = e.target.checked;
      this._lastText = -1e9;
    });
    this._syncControls();
    this.labelEls = new Map();
  }

  _syncControls() {
    if (!this.dom) return;
    for (const el of this.dom.querySelectorAll('input[data-k]'))
      el.checked = !!this.opts[el.dataset.k];
  }

  _updateReadout(st) {
    const s = st.sun;
    const m = st.moon;
    let html = `<p><b>Sun</b> over ${latLon(s.lat, s.lon)}, ${miles(s.radiusM)} from the pole, ${fmt(
      SUN_HEIGHT_MI,
    )} mi up. Season: ${st.season}. (Circle: ${miles(this._tropicRadius(23.44))} in June, ${miles(
      this._tropicRadius(-23.44),
    )} in December.)</p>
<p><b>Moon</b> over ${latLon(m.lat, m.lon)}, ${miles(m.radiusM)} from the pole, ${fmt(
      MOON_HEIGHT_MI,
    )} mi up, ${m.phaseName} (${Math.round(m.illuminatedFraction * 100)}% lit).</p>`;
    const o = this.obs;
    if (o) {
      const r = o.real;
      const realText =
        r.elevationDeg > -0.833
          ? `${fmt(r.elevationDeg, 1)}° up, azimuth ${fmt(r.azimuthDeg)}°`
          : `${fmt(r.elevationDeg, 1)}° (below the horizon: night)`;
      const bend =
        r.elevationDeg > -0.833
          ? `The light has to bend ${fmt(Math.abs(o.straightDeg - r.elevationDeg), 1)}° on its way down (yellow curve).`
          : `A straight ray would still arrive ${fmt(o.straightDeg, 1)}° up, so in this model the light must curve away for it to be night here.`;
      html += `<p><b>At the view centre</b> ${latLon(o.lat, o.lon)}, ${miles(o.radiusM)} from the pole:<br>
Polaris: straight line ${fmt(o.polarisDeg, 1)}° up; real ${fmt(o.lat, 1)}° (your latitude).<br>
Sun: straight line from the dome sun ${fmt(o.straightDeg, 1)}° up (dashed red); real ${realText}. ${bend}</p>`;
    } else {
      html += `<p>Centre the view on the real map to see the light ray and the angles there.</p>`;
    }
    this.read.innerHTML = html;
  }

  _label(key, cls, text, vec) {
    let el = this.labelEls.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = `fw-dome-label ${cls}`;
      this.labels.appendChild(el);
      this.labelEls.set(key, el);
    }
    const s = vec && this.view.worldToScreen(vec);
    if (!s || !Number.isFinite(s.x)) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    el.style.left = `${s.x}px`;
    el.style.top = `${s.y}px`;
    if (el.textContent !== text) el.textContent = text;
  }

  _updateLabels(st, sp, mp) {
    const on = this.opts.labels;
    this.labels.style.display = on ? '' : 'none';
    if (!on) return;
    this._label(
      'sun',
      'sun',
      `Sun · ${fmt(SUN_HEIGHT_MI)} mi up`,
      this.opts.bodies ? sp : null,
    );
    this._label(
      'moon',
      'moon',
      `Moon · ${st.moon.phaseName}`,
      this.opts.bodies ? mp : null,
    );
    const showStars = this.starGroup.visible;
    const v = this._lv || (this._lv = new THREE.Vector3());
    for (const name of LABELLED_STARS) {
      const p = this.starPos.get(name);
      const w =
        p && showStars
          ? v.copy(p).applyMatrix4(this.starGroup.matrixWorld)
          : null;
      this._label(`star:${name}`, 'star', name, w ? w.clone() : null);
    }
    st.planets.forEach((p) => {
      const vec =
        this.planets.visible && this.opts.planets
          ? new THREE.Vector3(p.world.x, p.heightM, -p.world.y)
          : null;
      this._label(`planet:${p.name}`, 'planet', p.name, vec);
    });
  }
}
