/**
 * Live aircraft, ships and satellites in the flat world.
 *
 * Positions are read from the app's existing layers (no new network requests) and placed by the
 * same verified projection as everything else. The overlay keeps each object's source lat/lon/alt
 * so `verify()` can prove the rendered position inverts back to the source position.
 *
 * Heading on the disc: AEQD scales along-parallel motion by k and along-meridian motion by 1, so a
 * true course θ (clockwise from north) is drawn along atan2(k·sin θ, cos θ) in the local
 * (north, east) basis — not along θ itself.
 */
import * as THREE from 'three';
import { northAt } from '../render/controls.js';

const KINDS = {
  flights: { color: 0x39e1ff, layer: 'flights', size: 1, label: 'Aircraft' },
  military: { color: 0xffb020, layer: 'military', size: 1, label: 'Military aircraft' },
  vessels: { color: 0x5dff8f, layer: 'ais-live-vessels', size: 1.4, label: 'Ship' },
  satellites: { color: 0xff5ad7, layer: 'satellites', size: 1.8, label: 'Satellite' },
};
const MAX_PER_KIND = 12000;

function aircraftGeometry() {
  // A small swept-wing silhouette pointing along +X, unit length ≈ 1.
  const shape = new THREE.Shape();
  shape.moveTo(0.6, 0);
  shape.lineTo(-0.1, 0.08);
  shape.lineTo(-0.15, 0.5);
  shape.lineTo(-0.3, 0.5);
  shape.lineTo(-0.3, 0.07);
  shape.lineTo(-0.45, 0.06);
  shape.lineTo(-0.5, 0.2);
  shape.lineTo(-0.6, 0.2);
  shape.lineTo(-0.58, 0);
  shape.lineTo(-0.6, -0.2);
  shape.lineTo(-0.5, -0.2);
  shape.lineTo(-0.45, -0.06);
  shape.lineTo(-0.3, -0.07);
  shape.lineTo(-0.3, -0.5);
  shape.lineTo(-0.15, -0.5);
  shape.lineTo(-0.1, -0.08);
  shape.lineTo(0.6, 0);
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.06, bevelEnabled: false });
  g.rotateX(-Math.PI / 2); // lie flat: shape Y → world −Z
  g.translate(0, 0.03, 0);
  return g;
}

function shipGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(0.6, 0);
  shape.lineTo(0.3, 0.18);
  shape.lineTo(-0.5, 0.18);
  shape.lineTo(-0.5, -0.18);
  shape.lineTo(0.3, -0.18);
  shape.lineTo(0.6, 0);
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.12, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  return g;
}

export class LiveOverlay {
  constructor({ dataManager, frame }) {
    this.dataManager = dataManager;
    this.frame = frame;
    this.group = new THREE.Group();
    this.group.name = 'flatworld-live';
    this.meshes = {};
    this.records = {};
    this.enabled = { flights: true, military: true, vessels: true, satellites: true };
    this.tracked = null;
    this.lastPoll = 0;
    this.labels = null;
    this.drawScale = 1;
    this.motion = 'interpolated';
    const geos = {
      flights: aircraftGeometry(),
      military: aircraftGeometry(),
      vessels: shipGeometry(),
      satellites: new THREE.OctahedronGeometry(0.35),
    };
    for (const [kind, spec] of Object.entries(KINDS)) {
      const mat = new THREE.MeshBasicMaterial({ color: spec.color, fog: false });
      const mesh = new THREE.InstancedMesh(geos[kind], mat, MAX_PER_KIND);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.userData.kind = kind;
      this.meshes[kind] = mesh;
      this.records[kind] = [];
      this.group.add(mesh);
    }
    // Ground "stalks" from aircraft/satellites down to their nadir make altitude readable.
    this.stalkGeometry = new THREE.BufferGeometry();
    this.stalkGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 4096), 3));
    this.stalks = new THREE.LineSegments(
      this.stalkGeometry,
      new THREE.LineBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.35, fog: false }),
    );
    this.stalks.frustumCulled = false;
    this.group.add(this.stalks);
    this.trackMarker = new THREE.Mesh(
      new THREE.RingGeometry(1.1, 1.35, 48),
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, fog: false, depthTest: false }),
    );
    this.trackMarker.rotateX(-Math.PI / 2);
    this.trackMarker.visible = false;
    this.group.add(this.trackMarker);
  }

  attach(view) {
    this.view = view;
    view.scene.add(this.group);
    this.labels = document.createElement('div');
    this.labels.className = 'flatworld-labels';
    view.host.appendChild(this.labels);
  }

  _module(layerId) {
    return this.dataManager?.layers?.get(layerId)?.module ?? null;
  }

  isLayerOn(kind) {
    return Boolean(this.dataManager?.isEffectivelyEnabled?.(KINDS[kind].layer));
  }

  toggleLayer(kind) {
    return this.dataManager?.toggle?.(KINDS[kind].layer, { origin: 'user' });
  }

  /**
   * Source fixes for one layer, exactly as the feed reported them (the app's analyst records:
   * every contact in its snapshot). Falls back to the layer's own positions for layers without
   * analyst records.
   */
  _readSource(kind) {
    const mod = this._module(KINDS[kind].layer);
    if (!mod || !this.isLayerOn(kind)) return [];
    let rows = [];
    try {
      rows = mod.getAnalystRecords?.() ?? [];
    } catch {
      rows = [];
    }
    if (!rows.length) {
      try {
        rows = (mod.getAllPositions?.() ?? []).map((p) => ({ ...p, lat: p.latitude, lon: p.longitude }));
      } catch {
        rows = [];
      }
    }
    const out = [];
    for (const a of rows) {
      const lat = a.lat ?? a.latitude;
      const lon = a.lon ?? a.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      out.push({
        id: String(a.icao24 ?? a.mmsi ?? a.noradId ?? a.id),
        label: a.callsign || a.name || a.label || String(a.id),
        lat,
        lon,
        altitudeM: Number.isFinite(a.altitudeM) ? a.altitudeM : 0,
        heading: [a.heading, a.courseDeg, a.cog, a.trueTrack].find(Number.isFinite) ?? null,
        speedMps: a.speedMps ?? null,
        source: mod.source ?? null,
      });
    }
    return out;
  }

  /**
   * Poll the layers. Each contact keeps its last two distinct fixes with their arrival times; the
   * renderer draws it one feed interval behind real time, interpolated between those two real
   * fixes (as the globe does), or exactly at the latest fix when `motion === 'fixes'`.
   */
  poll() {
    const now = Date.now();
    for (const kind of Object.keys(KINDS)) {
      if (!this.enabled[kind]) {
        this.records[kind] = [];
        continue;
      }
      const rows = this._readSource(kind).slice(0, MAX_PER_KIND);
      const next = [];
      const prevById = this._byId?.[kind] ?? new Map();
      const byId = new Map();
      for (const row of rows) {
        let r = prevById.get(row.id);
        if (!r) {
          r = { kind, id: row.id, fixes: [] };
        }
        const last = r.fixes[r.fixes.length - 1];
        if (!last || last.lat !== row.lat || last.lon !== row.lon || last.altitudeM !== row.altitudeM) {
          r.fixes.push({ lat: row.lat, lon: row.lon, altitudeM: row.altitudeM, t: now });
          if (r.fixes.length > 2) r.fixes.shift();
        }
        Object.assign(r, { label: row.label, heading: row.heading, speedMps: row.speedMps, source: row.source });
        byId.set(row.id, r);
        next.push(r);
      }
      (this._byId ||= {})[kind] = byId;
      this.records[kind] = next;
    }
  }

  /** Display position of a contact at wall time `now` (ms). */
  _displayFix(r, now) {
    const f = r.fixes;
    const last = f[f.length - 1];
    if (this.motion === 'fixes' || f.length < 2) return { ...last, alpha: 1 };
    const a = f[0];
    const span = Math.max(last.t - a.t, 1);
    const alpha = Math.min(1, Math.max(0, (now - span - a.t) / span));
    let dLon = last.lon - a.lon;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    let lon = a.lon + dLon * alpha;
    if (lon > 180) lon -= 360;
    if (lon < -180) lon += 360;
    return {
      lat: a.lat + (last.lat - a.lat) * alpha,
      lon,
      altitudeM: a.altitudeM + (last.altitudeM - a.altitudeM) * alpha,
      alpha,
    };
  }

  update(dt, view) {
    const now = performance.now();
    if (now - this.lastPoll > 500) {
      this.lastPoll = now;
      this.poll();
    }
    const e = view.chunks.exaggeration;
    const cam = view.camera.position;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const stalkPos = this.stalkGeometry.attributes.position.array;
    // Floating origin: instance matrices are float32 on the GPU, so keep them camera-relative.
    const origin = new THREE.Vector3(Math.round(cam.x / 1000) * 1000, 0, Math.round(cam.z / 1000) * 1000);
    this.group.position.copy(origin);
    this.group.updateMatrixWorld();
    let stalkCount = 0;
    const projection = this.frame.projection;
    for (const [kind, mesh] of Object.entries(this.meshes)) {
      const recs = this.records[kind];
      let i = 0;
      const wall = Date.now();
      for (const r of recs) {
        const fix = this._displayFix(r, wall);
        r.lat = fix.lat;
        r.lon = fix.lon;
        r.altitudeM = fix.altitudeM;
        r.alpha = fix.alpha;
        const w = this.frame.geodeticToWorld(r.lat, r.lon, r.altitudeM);
        if (!w) continue;
        r.world = w;
        const y = r.altitudeM * e;
        p.set(w.x, y, -w.y);
        // Visual heading corrected for the projection's anisotropic scale.
        let yaw = 0;
        if (Number.isFinite(r.heading)) {
          const k = Math.min(projection.scaleFactors(r.lat).k, 1e3);
          const th = (r.heading * Math.PI) / 180;
          const vn = Math.cos(th);
          const ve = k * Math.sin(th);
          const n = northAt(w.x, w.y);
          const east = { x: n.y, y: -n.x };
          const dx = vn * n.x + ve * east.x;
          const dy = vn * n.y + ve * east.y;
          yaw = Math.atan2(dy, dx);
        }
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        const dist = p.distanceTo(cam);
        const size = Math.max(dist * 0.018 * KINDS[kind].size * this.drawScale, 30);
        s.setScalar(size);
        m.compose(p.clone().sub(origin), q, s);
        mesh.setMatrixAt(i, m);
        r.instance = i;
        r.drawn = p.clone();
        i += 1;
        if (kind !== 'vessels' && stalkCount < 4096 && dist < 3e6) {
          const g = view.chunks.heightAt(w.x, w.y) ?? 0;
          const lx = w.x - origin.x;
          const lz = -w.y - origin.z;
          stalkPos.set([lx, y, lz, lx, Math.min(g, y), lz], stalkCount * 6);
          stalkCount += 1;
        }
      }
      mesh.count = i;
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.stalkGeometry.setDrawRange(0, stalkCount * 2);
    this.stalkGeometry.attributes.position.needsUpdate = true;
    this._updateTracking(view);
  }

  _find(kind, id) {
    return this.records[kind]?.find((r) => r.id === id) ?? null;
  }

  track(kind, id) {
    this.tracked = { kind, id };
    const r = this._find(kind, id);
    if (r && this.view) {
      const w = this.frame.geodeticToWorld(r.lat, r.lon);
      const range = Math.max(r.altitudeM * this.view.chunks.exaggeration * 3, 6000);
      this.view.lookAtPlane({ x: w.x, y: w.y, range, pitch: 0.6, animate: true });
    }
  }

  stopTracking() {
    this.tracked = null;
    this.trackMarker.visible = false;
    if (this.labels) this.labels.innerHTML = '';
  }

  _updateTracking(view) {
    if (!this.tracked) {
      this.trackMarker.visible = false;
      return;
    }
    const r = this._find(this.tracked.kind, this.tracked.id);
    if (!r || !r.drawn) {
      this.trackMarker.visible = false;
      return;
    }
    const c = view.controls;
    if (c.mode === 'orbit' && !c.animation) {
      c.target.x += (r.world.x - c.target.x) * 0.2;
      c.target.y += (r.world.y - c.target.y) * 0.2;
    }
    const dist = r.drawn.distanceTo(view.camera.position);
    this.trackMarker.position.copy(r.drawn).sub(this.group.position);
    this.trackMarker.scale.setScalar(dist * 0.03);
    this.trackMarker.visible = true;
    const screen = view.worldToScreen(r.drawn);
    if (screen && this.labels) {
      const alt = r.kind === 'vessels' ? '' : ` · ${Math.round(r.altitudeM).toLocaleString()} m`;
      const hdg = Number.isFinite(r.heading) ? ` · ${Math.round(r.heading)}°` : '';
      this.labels.innerHTML = `<div class="flatworld-label" style="transform:translate(${Math.round(screen.x + 14)}px,${Math.round(screen.y - 10)}px)">${escapeHtml(r.label)}<span>${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}${alt}${hdg}</span></div>`;
    }
  }

  /** Raycast the instanced meshes; returns the nearest record under the cursor. */
  pick(raycaster) {
    const hits = raycaster.intersectObjects(Object.values(this.meshes), false);
    for (const h of hits) {
      const kind = h.object.userData.kind;
      const rec = this.records[kind].find((r) => r.instance === h.instanceId);
      if (rec) return rec;
    }
    return null;
  }

  /**
   * Prove every drawn object sits at the projection of its source coordinates: invert each drawn
   * position back to lat/lon and compare. Returns maxima in degrees and metres.
   */
  verify() {
    const result = { checked: 0, maxLatErrDeg: 0, maxLonErrDeg: 0, maxAltErrM: 0, byKind: {} };
    const e = this.view?.chunks.exaggeration ?? 1;
    for (const [kind, recs] of Object.entries(this.records)) {
      let n = 0;
      for (const r of recs) {
        if (!r.drawn) continue;
        const d = this.frame.worldToDomain(r.drawn.x, -r.drawn.z, r.drawn.y / e);
        if (d.domain !== 'gps') {
          result.outOfDomain = (result.outOfDomain || 0) + 1;
          continue;
        }
        const dLat = Math.abs(d.lat - r.lat);
        let dLon = Math.abs(d.lon - r.lon) % 360;
        if (dLon > 180) dLon = 360 - dLon;
        if (Math.abs(r.lat) > 89.9999) dLon = 0;
        result.maxLatErrDeg = Math.max(result.maxLatErrDeg, dLat);
        result.maxLonErrDeg = Math.max(result.maxLonErrDeg, dLon);
        result.maxAltErrM = Math.max(result.maxAltErrM, Math.abs(d.height - r.altitudeM));
        // The displayed point must lie on the segment between two real source fixes.
        const f = r.fixes;
        const a = f[0];
        const b = f[f.length - 1];
        const lo = Math.min(a.lat, b.lat) - 1e-9;
        const hi = Math.max(a.lat, b.lat) + 1e-9;
        if (r.lat < lo || r.lat > hi) result.offSegment = (result.offSegment || 0) + 1;
        result.lagFractionMax = Math.max(result.lagFractionMax || 0, 1 - (r.alpha ?? 1));
        n += 1;
      }
      result.byKind[kind] = n;
      result.checked += n;
    }
    return result;
  }

  destroy() {
    this.group.removeFromParent();
    this.labels?.remove();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
