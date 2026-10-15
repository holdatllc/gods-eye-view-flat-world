/**
 * The globe's 3D aircraft models in the flat world.
 *
 * Close in, the globe swaps the 2D icons of the nearest planes for its glTF airliner model
 * (public/models/airplane.glb, real-world metres, class-scaled, never smaller than ~24 px):
 * proximity mode models new planes within 150 km and keeps them to 185 km, at most 150 at a
 * time, below 800 km camera altitude (layers/flights/policy.js). This does the same with one
 * instanced draw per model part, placed at the planes' flat-world positions and headings; the
 * modelled planes' icons are hidden. Switchable (3D PLANE MODELS).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  MODEL_ALT_CEIL_M,
  MODEL_MAX,
  MODEL_MIN_PX,
  MODEL_NATIVE_RADIUS_M,
  MODEL_PROX_ADD_M,
  MODEL_PROX_KEEP_M,
  PLANE_MODEL_URL,
  TRACKED_MODEL_MIN_PX,
} from '../../layers/flights/policy.js';
import { CLASS_SCALE_3D } from '../../data/aircraftClass.js';

const KINDS = ['flights', 'military'];
/** The glTF's nose relative to the overlay's heading axis (+X), found against the icons. */
const NOSE_OFFSET = 0;

export class AircraftModels {
  constructor({ live }) {
    this.live = live;
    this.enabled = true;
    this.parts = [];
    this.group = new THREE.Group();
    this.group.name = 'flatworld-aircraft-models';
    this.modeled = new Set();
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.s = new THREE.Vector3();
    this.p = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    new GLTFLoader().load(PLANE_MODEL_URL, (gltf) => this._build(gltf.scene));
  }

  attach(view) {
    this.view = view;
    view.scene.add(this.group);
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    this.group.visible = this.enabled;
    if (!this.enabled) this._release();
  }

  _build(scene) {
    scene.updateMatrixWorld(true);
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const geometry = o.geometry.clone().applyMatrix4(o.matrixWorld);
      // Clean light silhouettes, as the globe blends its model colour almost all the way to white
      // (MODEL_COLOR_BLEND_AMOUNT 0.94); lit from within so it reads at night too.
      const material = new THREE.MeshStandardMaterial({
        color: 0xf2f6fa,
        emissive: 0x7d858f,
        roughness: 0.55,
        metalness: 0.1,
      });
      const mesh = new THREE.InstancedMesh(geometry, material, MODEL_MAX + 1);
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.parts.push(mesh);
      this.group.add(mesh);
    });
  }

  _release() {
    for (const r of this.modeled) r.modeled = false;
    this.modeled.clear();
    for (const p of this.parts) p.count = 0;
  }

  update(dt, view) {
    if (!this.enabled || !this.parts.length) return;
    const live = this.live;
    const cam = view.camera.position;
    const camAlt = cam.y - (view.chunks.heightAt(cam.x, -cam.z) ?? 0);
    if (camAlt > MODEL_ALT_CEIL_M * view.chunks.exaggeration) {
      this._release();
      return;
    }
    // Proximity mode: nearest planes, with add/keep hysteresis, capped.
    const cand = [];
    for (const k of KINDS) {
      if (!live.enabled[k]) continue;
      for (const r of live.records[k] ?? []) {
        if (!r.drawn) continue;
        const d = r.drawn.distanceTo(cam);
        const limit = r.modeled ? MODEL_PROX_KEEP_M : MODEL_PROX_ADD_M;
        if (d <= limit) cand.push([d, r]);
      }
    }
    cand.sort((a, b) => a[0] - b[0]);
    const chosen = new Set(cand.slice(0, MODEL_MAX).map((c) => c[1]));
    for (const r of this.modeled) if (!chosen.has(r)) r.modeled = false;
    this.modeled = chosen;
    const origin = live.group.position;
    this.group.position.copy(origin);
    const k =
      view.canvas.clientHeight /
      (2 * Math.tan((view.camera.fov * Math.PI) / 360));
    const t = live.tracked;
    let i = 0;
    for (const r of chosen) {
      r.modeled = true;
      const d = Math.max(r.drawn.distanceTo(cam), 1);
      const sel = t && r.id === t.id && KINDS.includes(t.kind);
      // Real size × class scale, but never under the globe's minimum on-screen size.
      const minPx = sel ? TRACKED_MODEL_MIN_PX : MODEL_MIN_PX;
      const real = CLASS_SCALE_3D[r.aircraftClass] || 1;
      const scale = Math.max(
        real,
        (minPx * d) / (2 * MODEL_NATIVE_RADIUS_M * k),
      );
      this.q.setFromAxisAngle(this.up, (r.yaw ?? 0) + NOSE_OFFSET);
      this.s.setScalar(scale);
      this.p.copy(r.drawn).sub(origin);
      this.m.compose(this.p, this.q, this.s);
      for (const part of this.parts) part.setMatrixAt(i, this.m);
      i += 1;
    }
    for (const part of this.parts) {
      part.count = i;
      part.instanceMatrix.needsUpdate = true;
    }
  }
}
