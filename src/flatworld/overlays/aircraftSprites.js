/**
 * The globe's aircraft icons in the flat world.
 *
 * The globe draws every aircraft as a white silhouette billboard (src/data/aircraftIcons.js),
 * about 20 px, turned to its heading on screen; military aircraft are tinted amber and the
 * selected one is cyan and larger. This draws the same icons, from the same SVG, as one
 * GPU point sprite per aircraft placed at its flat-world position (true height × relief). The
 * screen rotation is worked out in the shader from the aircraft's heading direction in the
 * flat frame, so a plane points along its track on the disc. The overlay's own 3D meshes stay
 * in place, hidden, as click targets.
 */
import * as THREE from 'three';
import { aircraftIcon } from '../../data/aircraftIcons.js';

const KINDS = ['flights', 'military'];
const COLOR = {
  flights: new THREE.Color(0xffffff),
  military: new THREE.Color(0xffb020),
  tracked: new THREE.Color(0x00dcff),
};
const ICON_PX = 20;
const TRACKED_PX = 26;

const VERT = /* glsl */ `
attribute vec2 aDir;
attribute vec3 aColor;
attribute float aSize;
uniform float uPixelRatio;
uniform float uAspect;
varying vec3 vColor;
varying float vAngle;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec4 c0 = projectionMatrix * mv;
  float step = max(-mv.z * 0.02, 1.0);
  vec4 c1 = projectionMatrix * (modelViewMatrix * vec4(position + vec3(aDir.x, 0.0, aDir.y) * step, 1.0));
  vec2 d = c1.xy / c1.w - c0.xy / c0.w;
  d.x *= uAspect;
  vAngle = atan(d.x, d.y);
  vColor = aColor;
  gl_Position = c0;
  // The globe's fleet billboard scale by distance: NearFarScalar(1 km, 3.0, 8,000 km, 0.5),
  // interpolated as Cesium does (pow 0.2).
  float t = pow(clamp((length(mv.xyz) - 1000.0) / (8.0e6 - 1000.0), 0.0, 1.0), 0.2);
  float scale = mix(3.0, 0.5, t);
  gl_PointSize = aSize * scale * uPixelRatio;
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uIcon;
varying vec3 vColor;
varying float vAngle;
void main() {
  vec2 q = vec2(gl_PointCoord.x - 0.5, 0.5 - gl_PointCoord.y);
  float c = cos(vAngle);
  float s = sin(vAngle);
  // Turn the nose-up glyph clockwise by vAngle (screen heading measured clockwise from up).
  vec2 src = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
  if (abs(src.x) > 0.5 || abs(src.y) > 0.5) discard;
  vec4 icon = texture2D(uIcon, src + 0.5);
  // Soft shadow under the glyph, as the globe's billboards read against imagery.
  vec4 sh = texture2D(uIcon, src + 0.5 + vec2(0.03, 0.05));
  float a = max(icon.a, sh.a * 0.45);
  if (a < 0.02) discard;
  vec3 rgb = mix(vec3(0.0), icon.rgb * vColor, icon.a / max(a, 1e-3));
  gl_FragColor = vec4(rgb, a);
}
`;

export class AircraftSprites {
  constructor({ live }) {
    this.live = live;
    this.enabled = true;
    this.capacity = 0;
    this.geometry = new THREE.BufferGeometry();
    const texture = new THREE.TextureLoader().load(
      aircraftIcon('airliner', 96),
    );
    texture.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uIcon: { value: texture },
        uPixelRatio: { value: 1 },
        uAspect: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      // The flat world uses a logarithmic depth buffer; aircraft fly above the ground anyway.
      depthTest: false,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 24;
  }

  attach(view) {
    this.view = view;
    view.scene.add(this.points);
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    this.points.visible = this.enabled;
    for (const k of KINDS)
      if (this.live.meshes[k]) this.live.meshes[k].visible = !this.enabled;
  }

  _ensure(n) {
    // Always allocate once, even with no aircraft (layers off), so the buffers exist.
    if (n <= this.capacity && this.capacity > 0) return;
    this.capacity = Math.max(n, Math.ceil(this.capacity * 1.5), 1024);
    const g = this.geometry;
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(this.capacity * 3), 3),
    );
    g.setAttribute(
      'aDir',
      new THREE.BufferAttribute(new Float32Array(this.capacity * 2), 2),
    );
    g.setAttribute(
      'aColor',
      new THREE.BufferAttribute(new Float32Array(this.capacity * 3), 3),
    );
    g.setAttribute(
      'aSize',
      new THREE.BufferAttribute(new Float32Array(this.capacity), 1),
    );
  }

  update(dt, view) {
    // The overlay's meshes are kept as (hidden) click targets while the icons are shown.
    for (const k of KINDS)
      if (this.live.meshes[k]) this.live.meshes[k].visible = !this.enabled;
    if (!this.enabled) return;
    const live = this.live;
    let total = 0;
    for (const k of KINDS)
      if (live.enabled[k]) total += live.records[k]?.length ?? 0;
    this._ensure(total);
    const pos = this.geometry.attributes.position.array;
    const dir = this.geometry.attributes.aDir.array;
    const col = this.geometry.attributes.aColor.array;
    const size = this.geometry.attributes.aSize.array;
    const origin = live.group.position;
    const t = live.tracked;
    let i = 0;
    for (const k of KINDS) {
      if (!live.enabled[k]) continue;
      for (const r of live.records[k] ?? []) {
        if (!r.drawn || r.instance === undefined) continue;
        pos[i * 3] = r.drawn.x - origin.x;
        pos[i * 3 + 1] = r.drawn.y;
        pos[i * 3 + 2] = r.drawn.z - origin.z;
        // Heading direction in the flat frame (the overlay's projection-corrected yaw).
        const yaw = r.yaw ?? 0;
        dir[i * 2] = Math.cos(yaw);
        dir[i * 2 + 1] = -Math.sin(yaw);
        const sel = t && t.kind === k && t.id === r.id;
        const c = sel ? COLOR.tracked : COLOR[k];
        col[i * 3] = c.r;
        col[i * 3 + 1] = c.g;
        col[i * 3 + 2] = c.b;
        size[i] = sel ? TRACKED_PX : ICON_PX;
        i += 1;
      }
    }
    this.geometry.setDrawRange(0, i);
    for (const name of ['position', 'aDir', 'aColor', 'aSize'])
      this.geometry.attributes[name].needsUpdate = true;
    this.points.position.copy(origin);
    this.material.uniforms.uPixelRatio.value = view.renderer.getPixelRatio();
    this.material.uniforms.uAspect.value = view.camera.aspect;
  }
}
