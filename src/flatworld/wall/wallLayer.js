/**
 * Ice wall layer: a continuous, procedurally shaded ice cliff standing on the outer circle of the
 * mapped world (frame.boundaryRadius), with low inlets, cracks, sea caves, a snow cornice and a
 * mist skirt. It is a HYPOTHETICAL model feature and is labelled as such on screen.
 *
 * Geometry is 32 sector meshes; each stores float32 vertices local to the sector centre, so the
 * 20,000 km ring has no precision loss. The wall height is exaggerated in the vertex shader by a
 * single uniform factor that grows with camera distance (see wallModel.wallExaggeration); at
 * close range the factor is 1 and the wall is at its true height.
 */
import * as THREE from 'three';
import { wallHeightM, wallExaggeration, wallLabel, WALL } from './wallModel.js';

const SECTORS = 32;
const COLUMNS = 1024; // per sector
const RIM_HEIGHT_M = 2832; // iceField.rimHeightM: the plateau the wall foot stands on

// Wall cross-section: [height fraction, radial offset (+ toward the viewer), normal out, normal up].
const WALL_PROFILE = [
  [0.0, 0.0, 1, 0],
  [0.45, 0.0, 1, 0],
  [0.93, 0.0, 1, 0],
  [0.965, 0.03, 0.8, -0.6],
  [1.0, 0.02, 0.2, 1],
  [1.0, -0.35, 0, 1],
  [0.0, -0.35, -1, 0],
];
const MIST_PROFILE = [
  [0.0, 0.4, 1, 0],
  [0.5, 0.4, 1, 0],
];

function buildSector(frame, sector, profile) {
  const R = frame.boundaryRadius;
  const circumference = 2 * Math.PI * R;
  const cols = COLUMNS + 1;
  const rows = profile.length;
  const a0 = (sector / SECTORS) * Math.PI * 2;
  const am = a0 + Math.PI / SECTORS;
  const cx = R * Math.cos(am);
  const cz = -R * Math.sin(am);

  const position = new Float32Array(cols * rows * 3);
  const face = new Float32Array(cols * rows * 2);
  const meta = new Float32Array(cols * rows * 4);
  const info = new Float32Array(cols * rows * 3);
  for (let c = 0; c < cols; c++) {
    const u = (sector * COLUMNS + c) / (SECTORS * COLUMNS);
    const a = u * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const H = wallHeightM(u, circumference);
    for (let r = 0; r < rows; r++) {
      const v = c * rows + r;
      position[v * 3] = R * ca - cx;
      position[v * 3 + 1] = 0;
      position[v * 3 + 2] = -R * sa - cz;
      face[v * 2] = -ca;
      face[v * 2 + 1] = sa;
      meta.set(profile[r], v * 4);
      info[v * 3] = H;
      info[v * 3 + 1] = u * circumference;
      info[v * 3 + 2] = c;
    }
  }
  const index = new Uint16Array(COLUMNS * (rows - 1) * 6);
  let k = 0;
  for (let c = 0; c < COLUMNS; c++) {
    for (let r = 0; r < rows - 1; r++) {
      const a = c * rows + r;
      const b = (c + 1) * rows + r;
      index[k++] = a;
      index[k++] = b;
      index[k++] = a + 1;
      index[k++] = b;
      index[k++] = b + 1;
      index[k++] = a + 1;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('aFace', new THREE.BufferAttribute(face, 2));
  g.setAttribute('aMeta', new THREE.BufferAttribute(meta, 4));
  g.setAttribute('aInfo', new THREE.BufferAttribute(info, 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  return { geometry: g, centre: new THREE.Vector3(cx, 0, cz) };
}

const VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>
attribute vec2 aFace;
attribute vec4 aMeta;
attribute vec3 aInfo;
uniform float uExag;
uniform float uFoot;
varying vec3 vN;
varying float vF;
varying float vS;
varying float vH;
void main() {
  float H = aInfo.x;
  float scale = H * uExag;
  vec3 p = position + vec3(aFace.x * aMeta.y * scale, uFoot + aMeta.x * scale, aFace.y * aMeta.y * scale);
  vN = vec3(aFace.x * aMeta.z, aMeta.w, aFace.y * aMeta.z);
  vF = aMeta.x;
  vS = aInfo.y;
  vH = H;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const NOISE = /* glsl */ `
uniform float uSeed;
float h11(float n) { return fract(sin(n * 127.1 + uSeed) * 43758.5453); }
float vn(float x) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(h11(i), h11(i + 1.0), f);
}
`;

const WALL_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>
${NOISE}
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uSky;
uniform vec3 uGround;
varying vec3 vN;
varying float vF;
varying float vS;
varying float vH;

// Vertical crack: a thin dark line per cell that reaches down from the top.
float crack(float s, float f, float cell, float seed, float widthMax) {
  float x = s / cell;
  float id = floor(x);
  float fr = fract(x);
  float pos = 0.2 + 0.6 * h11(id * 3.7 + seed);
  float reach = 0.25 + 0.75 * h11(id * 5.3 + seed + 9.0);
  float w = (0.012 + widthMax * h11(id * 1.9 + seed + 4.0)) * (0.35 + 0.65 * smoothstep(0.0, 1.0, (1.0 - f) / max(reach, 0.05)));
  float line = 1.0 - smoothstep(w * 0.4, w, abs(fr - pos));
  float present = step(0.45, h11(id * 7.1 + seed + 2.0));
  float depth = 1.0 - smoothstep(reach * 0.8, reach, 1.0 - f);
  return line * present * depth;
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vN);
  float f = clamp(vF, 0.0, 1.0);
  float s = vS;

  vec3 ice = vec3(0.86, 0.90, 0.93);
  float strata = 0.5 + 0.5 * sin(f * 38.0 + vn(s / 900.0) * 6.0);
  ice *= 0.94 + 0.06 * strata;
  // Weathered snow-white upper part and the top surface.
  ice = mix(ice, vec3(0.97, 0.97, 0.95), smoothstep(0.78, 0.97, f));
  if (n.y > 0.5) ice = vec3(0.97, 0.97, 0.96);

  float cr = 0.0;
  cr = max(cr, crack(s, f, 420.0, 11.0, 0.03));
  cr = max(cr, crack(s, f, 1700.0, 23.0, 0.04));
  cr = max(cr, crack(s, f, 7000.0, 37.0, 0.05));
  cr = max(cr, crack(s, f, 28000.0, 51.0, 0.07));
  cr = max(cr, crack(s, f, 110000.0, 67.0, 0.09));
  vec3 sapphire = mix(vec3(0.10, 0.45, 0.78), vec3(0.02, 0.14, 0.45), smoothstep(0.0, 0.6, cr));
  ice = mix(ice, sapphire, clamp(cr, 0.0, 1.0) * 0.9);

  // Sea caves: dark blue arches at the foot, one in about seven 900 m cells.
  float cell = floor(s / 900.0);
  float cu = (fract(s / 900.0) - 0.5) / (0.18 + 0.2 * h11(cell + 3.0));
  float arch = 0.1 + 0.14 * h11(cell + 8.0);
  float inArch = step(h11(cell + 1.0), 0.14) * (1.0 - smoothstep(0.85, 1.0, abs(cu))) *
    (1.0 - smoothstep(arch * 0.7, arch, f / max(sqrt(max(1.0 - cu * cu, 0.0001)), 0.05)));
  ice = mix(ice, vec3(0.01, 0.07, 0.22), inArch);

  // Shade the foot toward blue where mist and meltwater sit.
  ice = mix(ice, ice * vec3(0.78, 0.88, 1.0), (1.0 - smoothstep(0.0, 0.18, f)) * 0.5);

  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 hemi = mix(uGround, uSky, n.y * 0.5 + 0.5);
  vec3 lit = ice * (uSunCol * ndl + hemi) / PI;
  gl_FragColor = vec4(lit, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

const MIST_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>
${NOISE}
uniform vec3 uSky;
uniform vec3 uSunCol;
varying vec3 vN;
varying float vF;
varying float vS;
varying float vH;
void main() {
  #include <logdepthbuf_fragment>
  float f = clamp(vF / 0.5, 0.0, 1.0);
  float drift = vn(vS / 2600.0) * 0.6 + vn(vS / 520.0) * 0.4;
  float a = (1.0 - f) * (1.0 - f) * (0.25 + 0.5 * drift);
  vec3 col = (vec3(0.8, 0.88, 0.95) * (uSky * 0.6 + uSunCol * 0.25)) / PI;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

const LABEL_CSS = `
.fw-wall-label { position: absolute; left: 50%; transform: translateX(-50%); top: 150px; z-index: 2;
  max-width: min(640px, calc(100vw - 340px)); text-align: center; pointer-events: none;
  font: 10px/1.35 ui-monospace, 'SF Mono', Menlo, monospace; color: #bfe9f5; background: rgba(4, 14, 20, 0.62);
  padding: 3px 9px; border-radius: 4px; }
body:not(.flatworld-active) .fw-wall-label { display: none; }
`;

export class WallLayer {
  /** @param {{ frame: { boundaryRadius: number } }} opts */
  constructor({ frame }) {
    this.frame = frame;
    this.group = new THREE.Group();
    this.group.name = 'ice-wall';
    this.exaggeration = 1;
    this.label = null;
    this._labelText = '';
    this._labelExag = -1;
    this._style = null;
    this.uniforms = {
      uExag: { value: 1 },
      uFoot: { value: RIM_HEIGHT_M },
      uSeed: { value: (WALL.seed % 97) * 0.37 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunCol: { value: new THREE.Color(1, 1, 1) },
      uSky: { value: new THREE.Color(0.7, 0.8, 1) },
      uGround: { value: new THREE.Color(0.2, 0.2, 0.2) },
    };
  }

  attach(view) {
    this.view = view;
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, this.uniforms]);
    this._mergedUniforms = uniforms;
    // Keep our own value objects shared so update() can write through `this.uniforms`.
    for (const k of Object.keys(this.uniforms)) uniforms[k] = this.uniforms[k];

    const wallMat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERTEX,
      fragmentShader: WALL_FRAGMENT,
      side: THREE.DoubleSide,
      fog: true,
    });
    const mistMat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERTEX,
      fragmentShader: MIST_FRAGMENT,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this._materials = [wallMat, mistMat];
    this._geometries = [];
    for (let s = 0; s < SECTORS; s++) {
      for (const [profile, mat, order] of [
        [WALL_PROFILE, wallMat, 0],
        [MIST_PROFILE, mistMat, 2],
      ]) {
        const { geometry, centre } = buildSector(this.frame, s, profile);
        const mesh = new THREE.Mesh(geometry, mat);
        mesh.position.copy(centre);
        mesh.frustumCulled = false;
        mesh.renderOrder = order;
        this.group.add(mesh);
        this._geometries.push(geometry);
      }
    }
    view.scene.add(this.group);

    this._style = document.createElement('style');
    this._style.textContent = LABEL_CSS;
    document.head.appendChild(this._style);
    this.label = document.createElement('div');
    this.label.className = 'fw-wall-label';
    view.host.appendChild(this.label);
  }

  update(dt, view) {
    const R = this.frame.boundaryRadius;
    const exagTerrain = view.chunks?.exaggeration ?? 1;
    const foot = RIM_HEIGHT_M * exagTerrain;
    const cam = view.camera.position;
    const radial = Math.hypot(cam.x, cam.z);
    const distance = Math.hypot(radial - R, cam.y - foot);
    const e = wallExaggeration(distance);
    this.exaggeration = e;
    this.uniforms.uExag.value = e;
    this.uniforms.uFoot.value = foot;

    const sun = view.sun;
    this.uniforms.uSunDir.value
      .copy(sun.position)
      .sub(sun.target.position)
      .normalize();
    this.uniforms.uSunCol.value.copy(sun.color).multiplyScalar(sun.intensity);
    this.uniforms.uSky.value.copy(view.hemi.color).multiplyScalar(view.hemi.intensity);
    this.uniforms.uGround.value.copy(view.hemi.groundColor).multiplyScalar(view.hemi.intensity);

    if (this.label && Math.abs(e - this._labelExag) > Math.max(0.5, this._labelExag * 0.03)) {
      this._labelExag = e;
      const text = wallLabel(e);
      if (text !== this._labelText) {
        this._labelText = text;
        this.label.textContent = text;
      }
    }
  }

  destroy() {
    this.view?.scene.remove(this.group);
    for (const g of this._geometries ?? []) g.dispose();
    for (const m of this._materials ?? []) m.dispose();
    this.label?.remove();
    this._style?.remove();
  }
}
