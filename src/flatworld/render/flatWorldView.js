/**
 * The polar rendering adapter: a dedicated three.js renderer for the North-Pole-centred flat
 * world, mounted beside (never inside) the Cesium globe. Cesium's own scene modes cannot render an
 * azimuthal-equidistant disc with full 3D terrain, so this adapter reprojects source data itself.
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { ChunkManager } from '../terrain/chunkManager.js';
import {
  FlatWorldControls,
  headingToYaw,
  northAt,
  yawToHeading,
} from './controls.js';
import { createWorldFrame, DOMAIN_GPS } from '../projection/domains.js';
import { sunEcef, sunLocal } from './sun.js';

export class FlatWorldView {
  constructor({ host, frame = createWorldFrame() } = {}) {
    this.frame = frame;
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'flatworld-canvas';
    Object.assign(this.canvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      display: 'none',
      zIndex: '0',
      touchAction: 'none',
      outline: 'none',
    });
    this.canvas.tabIndex = 0;
    host.appendChild(this.canvas);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.62;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 1, 2e9);
    this.scene.add(this.camera);

    this.sky = new Sky();
    this.sky.scale.setScalar(1e8);
    this.sky.material.uniforms.turbidity.value = 4;
    this.sky.material.uniforms.rayleigh.value = 1.2;
    this.sky.material.uniforms.mieCoefficient.value = 0.004;
    this.sky.material.uniforms.mieDirectionalG.value = 0.8;
    // Sky.js has no logarithmic-depth support, so draw it first and never depth-test it.
    this.sky.material.depthWrite = false;
    this.sky.material.depthTest = false;
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    this.stars = this._makeStars();
    this.scene.add(this.stars);

    this.sun = new THREE.DirectionalLight(0xffffff, 3.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x3b3328, 0.9);
    this.scene.add(this.hemi);
    this.scene.fog = new THREE.FogExp2(0xa8c4e0, 0);

    this.chunks = new ChunkManager({ scene: this.scene });
    this.chunks.material.uniforms.uBoundary.value = frame.boundaryRadius;
    this.controls = new FlatWorldControls({
      camera: this.camera,
      element: this.canvas,
      groundHeight: (x, y) => this.chunks.heightAt(x, y),
    });

    this.time = {
      date: null,
      iceSky: 'pole',
      iceSunElevationDeg: 14,
      iceSunAzimuthDeg: 210,
    };
    this.weather = null;
    this.layers = new Set();
    this.active = false;
    this.clock = new THREE.Clock();
    this.frameStats = { frames: 0, times: [], last: performance.now() };
    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(host);
    this.resize();
    this._loop = this._loop.bind(this);
  }

  _makeStars() {
    const n = 6000;
    const pos = new Float32Array(n * 3);
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < n; i += 1) {
      const u = rnd() * 2 - 1;
      const t = rnd() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      pos[i * 3] = s * Math.cos(t) * 9e8;
      pos[i * 3 + 1] = Math.abs(u) * 9e8;
      pos[i * 3 + 2] = s * Math.sin(t) * 9e8;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({
      color: 0x000000,
      size: 1.6,
      sizeAttenuation: false,
      fog: false,
      depthTest: false,
      depthWrite: false,
    });
    const p = new THREE.Points(g, m);
    p.renderOrder = -9;
    p.frustumCulled = false;
    return p;
  }

  resize() {
    const w = this.host.clientWidth || window.innerWidth;
    const h = this.host.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  addLayer(layer) {
    this.layers.add(layer);
    layer.attach?.(this);
  }

  setActive(active) {
    if (active === this.active) return;
    this.active = active;
    this.canvas.style.display = active ? 'block' : 'none';
    this.controls.enabled = active;
    if (active) {
      this.resize();
      this.clock.getDelta();
      // One loop only, even if the view is toggled off and on within a single frame.
      if (!this._rafId) this._rafId = requestAnimationFrame(this._loop);
    }
  }

  /** Camera ground point in the display frame and its domain information. */
  getFocus() {
    const c = this.controls;
    let x;
    let y;
    if (c.mode === 'orbit') {
      x = c.target.x;
      y = c.target.y;
    } else {
      x = this.camera.position.x;
      y = -this.camera.position.z;
    }
    const sampled = this.chunks.heightAt(x, y);
    // No terrain loaded yet: the height is unknown, not 0 m.
    const ground = sampled ?? 0;
    const altitude = this.camera.position.y - ground;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const yaw = Math.atan2(-dir.z, dir.x);
    return {
      x,
      y,
      ground,
      altitude,
      cameraHeight: this.camera.position.y,
      heading: yawToHeading(yaw, x, y),
      pitchDeg: (Math.asin(Math.max(-1, Math.min(1, dir.y))) * 180) / Math.PI,
      domain: this.frame.worldToDomain(
        x,
        y,
        sampled === null ? NaN : ground / this.chunks.exaggeration,
      ),
      groundKnown: sampled !== null,
    };
  }

  /** Point the orbit camera at a real geodetic location. */
  lookAtGeodetic({
    lat,
    lon,
    range = 2e6,
    headingDeg = 0,
    pitchDeg = -90,
    animate = false,
  }) {
    const w = this.frame.geodeticToWorld(lat, lon, 0);
    if (!w) return;
    this.controls.setMode('orbit');
    const yaw = headingToYaw(headingDeg, w.x, w.y);
    const pitch = Math.min(
      Math.max((-pitchDeg * Math.PI) / 180, 0.05),
      Math.PI / 2 - 1e-3,
    );
    if (animate)
      this.controls.flyTo({ x: w.x, y: w.y, distance: range, yaw, pitch });
    else {
      Object.assign(this.controls, { distance: range, yaw, pitch });
      this.controls.target = {
        x: w.x,
        y: w.y,
        h: this.chunks.heightAt(w.x, w.y) ?? 0,
      };
    }
  }

  lookAtPlane({ x, y, range = 2e5, yaw, pitch, animate = true }) {
    this.controls.setMode('orbit');
    const target = {
      x,
      y,
      distance: range,
      yaw: yaw ?? this.controls.yaw,
      pitch: pitch ?? this.controls.pitch,
    };
    if (animate) this.controls.flyTo(target);
    else {
      Object.assign(this.controls, {
        distance: range,
        yaw: target.yaw,
        pitch: target.pitch,
      });
      this.controls.target = { x, y, h: this.chunks.heightAt(x, y) ?? 0 };
    }
  }

  /** Whole-disc overview in the Gleason orientation (90°E up). */
  overview() {
    this.lookAtPlane({
      x: 0,
      y: 0,
      range: 5.4e7,
      yaw: Math.PI / 2,
      pitch: Math.PI / 2 - 1e-3,
      animate: true,
    });
  }

  /** Project a three.js world point to CSS pixels, or null when behind the camera. */
  worldToScreen(v) {
    const p = v.clone().project(this.camera);
    if (p.z > 1 || p.z < -1) return null;
    return {
      x: ((p.x + 1) / 2) * this.canvas.clientWidth,
      y: ((1 - p.y) / 2) * this.canvas.clientHeight,
    };
  }

  /** Terrain point under a CSS pixel (raycast against the visible chunks). */
  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const meshes = (this.chunks.visible || []).map((c) => c.mesh);
    const hit = ray.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    const x = hit.point.x;
    const y = -hit.point.z;
    const height = hit.point.y / this.chunks.exaggeration;
    return {
      x,
      y,
      point: hit.point,
      domain: this.frame.worldToDomain(x, y, height),
    };
  }

  _updateEnvironment() {
    const focus = this.getFocus();
    const date =
      this.time.date ??
      new Date(Date.now() + (this.time.offsetMinutes || 0) * 60000);
    const s = sunEcef(date);
    this.chunks.material.uniforms.uSunEcef.value.set(s[0], s[1], s[2]);

    // Local sun at the focus → a direction in the flat frame.
    let east;
    let north;
    let up;
    const fixedIceSun = this.time.iceSky === 'fixed';
    this.chunks.material.uniforms.uIceFixedSun.value = fixedIceSun ? 1 : 0;
    if (focus.domain.domain === DOMAIN_GPS || !fixedIceSun) {
      // Ice-domain focus uses the South Pole's real sky along the rim direction (continuity).
      let lat = focus.domain.lat;
      let lon = focus.domain.lon;
      if (focus.domain.domain !== DOMAIN_GPS) {
        const p = this.frame.fromDisplay(focus.x, focus.y);
        lat = -89.99;
        lon = (Math.atan2(p.x, -p.y) * 180) / Math.PI;
      }
      const l = sunLocal(lat, lon, date);
      east = l.east;
      north = l.north;
      up = l.up;
      this.chunks.material.uniforms.uIceDay.value = 1;
    } else {
      const el = (this.time.iceSunElevationDeg * Math.PI) / 180;
      const az = (this.time.iceSunAzimuthDeg * Math.PI) / 180;
      east = Math.cos(el) * Math.sin(az);
      north = Math.cos(el) * Math.cos(az);
      up = Math.sin(el);
      this.chunks.material.uniforms.uIceDay.value = Math.max(
        0.15,
        Math.min(1, (up + 0.1) / 0.2),
      );
    }
    const n = northAt(focus.x, focus.y);
    const e = { x: n.y, y: -n.x };
    const dir = new THREE.Vector3(
      east * e.x + north * n.x,
      up,
      -(east * e.y + north * n.y),
    ).normalize();

    const alt = Math.max(focus.altitude, 1);
    const day = THREE.MathUtils.smoothstep(dir.y, -0.12, 0.08);
    // Far views light every fragment with its own true local sun (terrain shader); close views
    // use one directional sun at the focus so mountains and buildings cast shadows.
    const global = THREE.MathUtils.smoothstep(alt, 150000, 1500000);
    const u = this.chunks.material.uniforms;
    u.uGlobalLight.value = global;
    // Close up at night: fade the coarse city-light layer and keep the ground faintly visible.
    const near = 1 - THREE.MathUtils.smoothstep(alt, 30000, 500000);
    u.uNightLights.value = 1 - 0.8 * near;
    u.uNightLevel.value = 0.12 + 0.33 * near;
    this.sun.intensity = 3.2 * day * (1 - global);
    this.hemi.intensity = (0.25 + 0.75 * day) * (1 - global) + 0.05;
    {
      const el = (this.time.iceSunElevationDeg * Math.PI) / 180;
      const az = (this.time.iceSunAzimuthDeg * Math.PI) / 180;
      u.uIceSun.value.set(
        Math.cos(el) * Math.sin(az),
        Math.cos(el) * Math.cos(az),
        Math.sin(el),
      );
    }

    // Shadow frustum follows the focus and shrinks with altitude.
    const tgt = new THREE.Vector3(focus.x, focus.ground, -focus.y);
    const extent = Math.min(Math.max(alt * 2.5, 300), 40000);
    this.sun.position.copy(tgt).addScaledVector(dir, extent * 4);
    this.sun.target.position.copy(tgt);
    const cam = this.sun.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = 1;
    cam.far = extent * 10;
    cam.updateProjectionMatrix();
    // Shadow maps are float32 on the GPU: beyond ~3e7 m from the disc centre their depth
    // comparisons lose precision and darken everything, so shadows are off that far out.
    this.sun.castShadow = alt < 60000 && Math.hypot(focus.x, focus.y) < 3.0e7;

    // Sky and atmosphere fade into space with altitude.
    const space = THREE.MathUtils.smoothstep(alt, 25000, 220000);
    this.sky.position.copy(this.camera.position);
    this.sky.material.uniforms.sunPosition.value.copy(dir);
    this.sky.visible = space < 0.999;
    this.stars.position.copy(this.camera.position);
    const starLevel = Math.max(space, 1 - day) * 0.9;
    this.stars.material.color.setScalar(starLevel);
    this.stars.visible = starLevel > 0.03;
    this.renderer.setClearColor(0x000000, 1);
    const weatherFog = this.weather?.fogDensity?.(focus) ?? 0;
    const haze = 1 / Math.max(6e4, alt * 25);
    this.scene.fog.density =
      (haze * (1 - space) + weatherFog) * (0.35 + 0.65 * day);
    // Fog matches the sky near the horizon so distant terrain fades into it, not against it.
    const horizon = new THREE.Color(0.78, 0.86, 0.95).multiplyScalar(
      0.18 + 0.82 * day,
    );
    if (weatherFog > 0)
      horizon.lerp(
        new THREE.Color(0.93, 0.95, 0.98).multiplyScalar(0.3 + 0.7 * day),
        Math.min(1, weatherFog * 4000),
      );
    this.scene.fog.color.copy(horizon);
    this.focus = focus;
  }

  _loop() {
    this._rafId = 0;
    if (!this.active) return;
    this._rafId = requestAnimationFrame(this._loop);
    const t0 = performance.now();
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.controls.update(dt);
    const g =
      this.chunks.heightAt(this.camera.position.x, -this.camera.position.z) ??
      0;
    const agl = Math.max(this.camera.position.y - g, 0.5);
    this.camera.near = Math.min(Math.max(agl * 0.002, 0.05), 2000);
    this.camera.far = 2e9;
    this.camera.updateProjectionMatrix();
    // Terrain detail is chosen per screen pixel; lodPixelScale > 1 (GLOBE-SHARP PHOTOS) counts
    // device pixels on high-DPI screens, as the globe does.
    this.chunks.update(
      this.camera,
      (this.canvas.clientHeight || 800) * (this.lodPixelScale || 1),
    );
    this._updateEnvironment();
    for (const layer of this.layers) layer.update?.(dt, this);
    this.renderer.render(this.scene, this.camera);
    const ms = performance.now() - t0;
    const s = this.frameStats;
    s.frames += 1;
    s.times.push(dt * 1000);
    if (s.times.length > 600) s.times.shift();
    s.cpuMs = ms;
  }

  diagnostics() {
    const times = [...this.frameStats.times].sort((a, b) => a - b);
    const pct = (p) =>
      times[Math.min(times.length - 1, Math.floor(p * times.length))] ?? null;
    const info = this.renderer.info;
    return {
      frames: this.frameStats.frames,
      frameMsMedian: pct(0.5),
      frameMsP95: pct(0.95),
      fps: times.length ? 1000 / pct(0.5) : null,
      chunksLoaded: this.chunks.chunks.size,
      chunksVisible: this.chunks.stats.visible,
      chunksPending: this.chunks.pending.size,
      chunkStats: { ...this.chunks.stats },
      estimatedChunkMemoryMB: this.chunks.memoryEstimate() / 1048576,
      gpu: {
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        calls: info.render.calls,
        triangles: info.render.triangles,
      },
      jsHeapMB: performance.memory
        ? performance.memory.usedJSHeapSize / 1048576
        : null,
      focus: this.focus,
    };
  }

  destroy() {
    this.active = false;
    this._resizeObserver.disconnect();
    this.controls.destroy();
    for (const layer of this.layers) layer.destroy?.();
    this.chunks.destroy();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
