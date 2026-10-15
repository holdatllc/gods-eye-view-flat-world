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
import { satelliteClassColor } from '../../data/satelliteClass.js';

export const KINDS = {
  flights: { color: 0x39e1ff, layer: 'flights', size: 1, label: 'Aircraft' },
  military: {
    color: 0xffb020,
    layer: 'military',
    size: 1,
    label: 'Military aircraft',
  },
  vessels: {
    color: 0x5dff8f,
    layer: 'ais-live-vessels',
    size: 1.4,
    label: 'Ship',
  },
  satellites: {
    color: 0xff5ad7,
    layer: 'satellites',
    size: 0.9,
    label: 'Satellite',
  },
};
const MAX_PER_KIND = 20000;
const UP_AXIS = new THREE.Vector3(0, 1, 0);
/** Smooth mode: satellites (the bulk of the instances) are re-placed at this interval. */
const SMOOTH_SATELLITE_MS = 100;
const SATELLITE_FALLBACK = new THREE.Color(KINDS.satellites.color);

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
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: 0.06,
    bevelEnabled: false,
  });
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
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: 0.12,
    bevelEnabled: false,
  });
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
    this.enabled = {
      flights: true,
      military: true,
      vessels: true,
      satellites: true,
    };
    this.tracked = null;
    /** Whether the camera follows the selected object (dragging the map stops following). */
    this.following = false;
    this.lastPoll = 0;
    this.drawScale = 1;
    this.smooth = true;
    // Satellites in the flat world's original single colour by default; per-class colours
    // (the globe's satellite classes) behind a switch.
    this.satelliteClassColours = false;
    this.motion = 'interpolated';
    /** Off by default: satellites at their real height. On: at their sub-satellite ground point. */
    this.satelliteGroundPoints = false;
    /** Called with the tracked record (or null) whenever tracking starts or ends. */
    this.onTrackingChange = () => {};
    const geos = {
      flights: aircraftGeometry(),
      military: aircraftGeometry(),
      vessels: shipGeometry(),
      satellites: new THREE.OctahedronGeometry(0.35),
    };
    for (const [kind, spec] of Object.entries(KINDS)) {
      // Satellites take their class colour per instance (as on the globe).
      const mat = new THREE.MeshBasicMaterial({
        color: kind === 'satellites' ? 0xffffff : spec.color,
        fog: false,
      });
      const mesh = new THREE.InstancedMesh(geos[kind], mat, MAX_PER_KIND);
      mesh.count = 0;
      mesh.frustumCulled = false;
      if (kind === 'satellites')
        mesh.instanceColor = new THREE.InstancedBufferAttribute(
          new Float32Array(MAX_PER_KIND * 3),
          3,
        );
      mesh.userData.kind = kind;
      this.meshes[kind] = mesh;
      this.records[kind] = [];
      this.group.add(mesh);
    }
    // Ground "stalks" from aircraft/satellites down to their nadir make altitude readable.
    this.stalkGeometry = new THREE.BufferGeometry();
    this.stalkGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(6 * 4096), 3),
    );
    this.stalks = new THREE.LineSegments(
      this.stalkGeometry,
      new THREE.LineBasicMaterial({
        color: 0x9fe8ff,
        transparent: true,
        opacity: 0.35,
        fog: false,
      }),
    );
    this.stalks.frustumCulled = false;
    this.group.add(this.stalks);
    this.trackMarker = new THREE.Mesh(
      new THREE.RingGeometry(1.1, 1.35, 48),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        fog: false,
        depthTest: false,
      }),
    );
    this.trackMarker.rotateX(-Math.PI / 2);
    // Ground track (sub-satellite points) and orbit path for a tracked satellite.
    this.groundTrack = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: 0xff5ad7,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        fog: false,
      }),
    );
    this.orbitPath = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({
        color: 0xffb3ec,
        dashSize: 60000,
        gapSize: 40000,
        transparent: true,
        opacity: 0.7,
        depthTest: false,
        fog: false,
      }),
    );
    for (const l of [this.groundTrack, this.orbitPath]) {
      l.frustumCulled = false;
      l.renderOrder = 15;
      l.visible = false;
    }
    this.trackMarker.visible = false;
    this.group.add(this.trackMarker);
    this.trackLines = new THREE.Group();
    this.trackLines.add(this.groundTrack, this.orbitPath);
  }

  /** Ground track ±1 orbit around now, from the satellite layer's own SGP4 propagation. */
  _buildSatelliteTrack(id) {
    const mod = this._module(KINDS.satellites.layer);
    const track = mod?.getSatelliteOrbitTrack?.(id);
    if (!track) return false;
    const period = track.periodSec || 5400;
    const now = Date.now();
    const ground = [];
    const orbit = [];
    const e = this.view?.chunks.exaggeration ?? 1;
    for (let t = -period; t <= period; t += Math.max(20, period / 400)) {
      const p = track.positionAt(new Date(now + t * 1000));
      if (!p) continue;
      const w = this.frame.geodeticToWorld(p.latitude, p.longitude);
      if (!w) continue;
      ground.push(w.x, 2000 * e, -w.y);
      orbit.push(w.x, p.altitude * e, -w.y);
    }
    this.groundTrack.geometry.dispose();
    this.groundTrack.geometry = new THREE.BufferGeometry();
    this.groundTrack.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(ground), 3),
    );
    this.orbitPath.geometry.dispose();
    this.orbitPath.geometry = new THREE.BufferGeometry();
    this.orbitPath.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(orbit), 3),
    );
    this.orbitPath.computeLineDistances();
    this.groundTrack.visible = this.orbitPath.visible = true;
    this.trackBuiltAt = now;
    this.trackPeriodSec = period;
    return true;
  }

  attach(view) {
    this.view = view;
    view.scene.add(this.group);
    view.scene.add(this.trackLines);
  }

  _module(layerId) {
    return this.dataManager?.layers?.get(layerId)?.module ?? null;
  }

  /** The app's layer module behind a flat-world kind (the same object the globe uses). */
  layerModule(kind) {
    return KINDS[kind] ? this._module(KINDS[kind].layer) : null;
  }

  isLayerOn(kind) {
    return Boolean(this.dataManager?.isEffectivelyEnabled?.(KINDS[kind].layer));
  }

  /** The layer's own reported problem (e.g. a missing provider key), or null. */
  layerError(kind) {
    try {
      const st = this._module(KINDS[kind].layer)?.getStats?.();
      if (!st) return null;
      if (st.error) return String(st.error).replace(/_/g, ' ');
      if (st.status === 'unavailable') return 'unavailable';
      if (st.stale) return 'feed is stale';
      return null;
    } catch {
      return null;
    }
  }

  toggleLayer(kind) {
    return this.dataManager?.toggle?.(KINDS[kind].layer, { origin: 'user' });
  }

  /** The satellite layer's catalogue: 'core' (~830 main satellites) or 'dense' (~11,500). */
  satelliteCatalog() {
    try {
      return this.layerModule('satellites')?.getParams?.()?.catalog ?? null;
    } catch {
      return null;
    }
  }

  /** Switch the satellite layer's catalogue through the app's own layer-params path. */
  setSatelliteCatalog(catalog) {
    const layerId = KINDS.satellites.layer;
    if (this.dataManager?.setLayerParams)
      return this.dataManager.setLayerParams(
        layerId,
        { catalog },
        { origin: 'user' },
      );
    return this.layerModule('satellites')?.setParams?.(
      { catalog },
      { origin: 'user' },
    );
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
      rows = mod.getAnalystRecords?.(MAX_PER_KIND) ?? [];
    } catch {
      rows = [];
    }
    let shown = [];
    try {
      shown = mod.getAllPositions?.() ?? [];
    } catch {
      shown = [];
    }
    if (!rows.length)
      rows = shown.map((p) => ({ ...p, lat: p.latitude, lon: p.longitude }));
    // Some feeds omit altitude in their records (e.g. military contacts without a barometric
    // value); the layer's own rendered altitude for the same contact is used then.
    const shownAlt = new Map(shown.map((p) => [String(p.id), p.altitudeM]));
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
        altitudeM: Number.isFinite(a.altitudeM)
          ? a.altitudeM
          : Number.isFinite(shownAlt.get(String(a.icao24 ?? a.id)))
            ? shownAlt.get(String(a.icao24 ?? a.id))
            : 0,
        heading:
          [a.heading, a.courseDeg, a.cog, a.trueTrack].find(Number.isFinite) ??
          null,
        speedMps: a.speedMps ?? null,
        onGround: a.onGround === true,
        source: mod.source ?? null,
        group: a.group ?? null,
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
    // After a pause (flat world hidden, tab in background) the previous fix is history, not the
    // start of a segment to animate along: start again from the latest fix.
    const resume = this._lastPollMs && now - this._lastPollMs > 30000;
    this._lastPollMs = now;
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
        if (resume || (r.source && row.source && r.source !== row.source))
          r.fixes.length = 0;
        const last = r.fixes[r.fixes.length - 1];
        if (
          !last ||
          last.lat !== row.lat ||
          last.lon !== row.lon ||
          last.altitudeM !== row.altitudeM
        ) {
          const fix = {
            lat: row.lat,
            lon: row.lon,
            altitudeM: row.altitudeM,
            t: now,
          };
          // Fixes are only animated when the step is plausible for the reported course and
          // speed; stale, out-of-order or cross-feed fixes snap instead of flying backwards.
          if (last && kind !== 'satellites' && !plausibleStep(last, fix, row))
            r.fixes.length = 0;
          r.fixes.push(fix);
          if (r.fixes.length > 2) r.fixes.shift();
          r.lastFixMs = now;
        }
        if (kind === 'satellites' && (!r.colorObj || r.group !== row.group)) {
          r.classColor = satelliteClassColor(row.group);
          r.colorObj = new THREE.Color(r.classColor);
        }
        Object.assign(r, {
          label: row.label,
          heading: row.heading,
          speedMps: row.speedMps,
          source: row.source,
          onGround: row.onGround,
          group: row.group,
        });
        byId.set(row.id, r);
        next.push(r);
      }
      (this._byId ||= {})[kind] = byId;
      this.records[kind] = next;
    }
    // A tracked contact that disappears (layer switched off, contact dropped by the feed) ends
    // tracking instead of leaving a frozen label and a locked camera.
    if (this.tracked) {
      const still = this._byId?.[this.tracked.kind]?.get(this.tracked.id);
      if (!still || !this.isLayerOn(this.tracked.kind)) {
        this._trackMisses = (this._trackMisses || 0) + 1;
        if (this._trackMisses >= 2) this.stopTracking();
      } else this._trackMisses = 0;
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
    const origin = new THREE.Vector3(
      Math.round(cam.x / 1000) * 1000,
      0,
      Math.round(cam.z / 1000) * 1000,
    );
    const originMoved = !this.lastOrigin || !this.lastOrigin.equals(origin);
    this.lastOrigin = origin.clone();
    this.group.position.copy(origin);
    this.group.updateMatrixWorld();
    let stalkCount = 0;
    const projection = this.frame.projection;
    const local = new THREE.Vector3();
    // Smooth mode: ~11,500 satellites move a few pixels a second on the disc, so they are
    // re-placed ten times a second instead of every frame (always when the camera's floating
    // origin moves, or one of them is selected).
    const satellitesDue =
      !this.smooth ||
      originMoved ||
      this.tracked?.kind === 'satellites' ||
      now - (this.satellitesPlacedAt || 0) >= SMOOTH_SATELLITE_MS;
    for (const [kind, mesh] of Object.entries(this.meshes)) {
      const recs = this.records[kind];
      if (kind === 'satellites' && !satellitesDue) {
        // Keep their stalks from the last placement.
        const cached = this.satelliteStalks;
        if (cached?.length) {
          const n = Math.min(cached.length / 6, 4096 - stalkCount);
          stalkPos.set(cached.subarray(0, n * 6), stalkCount * 6);
          stalkCount += n;
        }
        continue;
      }
      if (kind === 'satellites') this.satellitesPlacedAt = now;
      const stalkStart = stalkCount;
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
        if (r.onGround && kind !== 'satellites') {
          // Grounded: on the rendered terrain (airports can be 1–4 km above sea level).
          const g = view.chunks.heightAt(w.x, w.y);
          if (g !== null) r.altitudeM = g / e;
        }
        // Satellites are drawn at their true orbital height (default). The optional ground mode
        // puts each on the point directly beneath it instead.
        const y =
          kind === 'satellites' && this.satelliteGroundPoints
            ? (view.chunks.heightAt(w.x, w.y) ?? 0) + 1500 * e
            : r.altitudeM * e;
        r.drawnHeightM = y / e;
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
        q.setFromAxisAngle(UP_AXIS, yaw);
        const dist = p.distanceTo(cam);
        const size = Math.max(
          dist * 0.0065 * KINDS[kind].size * this.drawScale,
          30,
        );
        s.setScalar(size);
        m.compose(local.copy(p).sub(origin), q, s);
        mesh.setMatrixAt(i, m);
        if (mesh.instanceColor)
          mesh.setColorAt(
            i,
            (this.satelliteClassColours && r.colorObj) || SATELLITE_FALLBACK,
          );
        r.instance = i;
        // Reused per record: a new vector per object per frame (~25,000) churned the GC.
        if (r.drawn) r.drawn.copy(p);
        else r.drawn = p.clone();
        i += 1;
        if (kind !== 'vessels' && stalkCount < 4096 && dist < 3e6) {
          // Ground under the stalk: terrain lookups are costly at street level (fine chunks)
          // and thousands of stalks are in range there, so each is refreshed once a second.
          if (!(now - (r.stalkGroundAt || 0) < 1000)) {
            r.stalkGround = view.chunks.heightAt(w.x, w.y) ?? 0;
            r.stalkGroundAt = now;
          }
          const g = r.stalkGround;
          const lx = w.x - origin.x;
          const lz = -w.y - origin.z;
          stalkPos.set([lx, y, lz, lx, Math.min(g, y), lz], stalkCount * 6);
          stalkCount += 1;
        }
      }
      if (kind === 'satellites')
        this.satelliteStalks = stalkPos.slice(stalkStart * 6, stalkCount * 6);
      mesh.count = i;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      // Raycasting culls against the bounding sphere; recompute it lazily from the current
      // instances (it would otherwise stay empty if the layer had no data on the first frame).
      mesh.boundingSphere = null;
    }
    this.stalkGeometry.setDrawRange(0, stalkCount * 2);
    this.stalkGeometry.attributes.position.needsUpdate = true;
    this._updateTracking(view);
  }

  _find(kind, id) {
    return this.records[kind]?.find((r) => r.id === id) ?? null;
  }

  /** Select an object and follow it with the camera. */
  track(kind, id) {
    this.tracked = { kind, id };
    this.following = true;
    this.groundTrack.visible = this.orbitPath.visible = false;
    if (kind === 'satellites') this._buildSatelliteTrack(id);
    this.onTrackingChange(this._find(kind, id));
    const r = this._find(kind, id);
    if (r && this.view) {
      const w = this.frame.geodeticToWorld(r.lat, r.lon);
      const range = Math.max(
        r.altitudeM * this.view.chunks.exaggeration * 3,
        6000,
      );
      this.view.lookAtPlane({
        x: w.x,
        y: w.y,
        range,
        pitch: 0.6,
        animate: true,
      });
    }
  }

  /** Deselect: no selected object, no follow. */
  stopTracking() {
    const was = this.tracked;
    this.tracked = null;
    this.following = false;
    if (was) this.onTrackingChange(null);
    if (this.view) this.view.controls.targetHeightLock = null;
    this.groundTrack.visible = this.orbitPath.visible = false;
    this.trackMarker.visible = false;
  }

  /** Keep the selection but stop moving the camera with it (the user took the camera). */
  releaseFollow() {
    if (!this.following) return;
    this.following = false;
    if (this.view) this.view.controls.targetHeightLock = null;
  }

  /** Follow the selected object again, flying to it first. */
  follow() {
    if (!this.tracked) return;
    this.track(this.tracked.kind, this.tracked.id);
  }

  _updateTracking(view) {
    if (
      this.tracked?.kind === 'satellites' &&
      Date.now() - (this.trackBuiltAt || 0) > 60000
    ) {
      this._buildSatelliteTrack(this.tracked.id);
    }
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
    if (this.following && c.mode === 'orbit' && !c.animation) {
      c.target.x += (r.world.x - c.target.x) * 0.2;
      c.target.y += (r.world.y - c.target.y) * 0.2;
      // Pivot on the aircraft itself so it stays centred on screen (review D7).
      c.targetHeightLock = r.drawn.y;
    }
    const dist = r.drawn.distanceTo(view.camera.position);
    this.trackMarker.position.copy(r.drawn).sub(this.group.position);
    this.trackMarker.scale.setScalar(dist * 0.03);
    this.trackMarker.visible = true;
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
   * Verify every drawn object against independent evidence:
   * 1. projection exactness — the drawn 3D position inverts (through the domain frame) to the
   *    geodetic point the overlay meant to draw;
   * 2. source fidelity — that point lies on the segment between the contact's last two fixes
   *    (latitude and longitude, wrap-aware), and the latest fix equals the value the layer reports
   *    *now* when re-read fresh from the source module (or the source has moved on since the poll).
   */
  verify() {
    const result = {
      checked: 0,
      maxLatErrDeg: 0,
      maxLonErrDeg: 0,
      maxAltErrM: 0,
      offSegment: 0,
      latestFixMatchesSource: 0,
      sourceMovedSincePoll: 0,
      missingFromSource: 0,
      byKind: {},
    };
    const e = this.view?.chunks.exaggeration ?? 1;
    const wrap = (d) => {
      let x = ((d % 360) + 360) % 360;
      if (x > 180) x -= 360;
      return x;
    };
    for (const [kind, recs] of Object.entries(this.records)) {
      const fresh = new Map(this._readSource(kind).map((row) => [row.id, row]));
      let n = 0;
      for (const r of recs) {
        if (!r.drawn) continue;
        const local = r.drawn;
        const d = this.frame.worldToDomain(local.x, -local.z, local.y / e);
        if (d.domain !== 'gps') {
          result.outOfDomain = (result.outOfDomain || 0) + 1;
          continue;
        }
        const dLat = Math.abs(d.lat - r.lat);
        const dLon =
          Math.abs(r.lat) > 89.9999 ? 0 : Math.abs(wrap(d.lon - r.lon));
        result.maxLatErrDeg = Math.max(result.maxLatErrDeg, dLat);
        result.maxLonErrDeg = Math.max(result.maxLonErrDeg, dLon);
        result.maxAltErrM = Math.max(
          result.maxAltErrM,
          Math.abs(d.height - (r.drawnHeightM ?? r.altitudeM)),
        );
        const f = r.fixes;
        const a = f[0];
        const b = f[f.length - 1];
        const tol = 1e-9;
        const latOk =
          r.lat >= Math.min(a.lat, b.lat) - tol &&
          r.lat <= Math.max(a.lat, b.lat) + tol;
        const span = wrap(b.lon - a.lon);
        const along = wrap(r.lon - a.lon);
        const lonOk =
          Math.abs(span) < 1e-12
            ? Math.abs(along) < 1e-6
            : along / span >= -1e-6 && along / span <= 1 + 1e-6;
        if (!latOk || !lonOk) result.offSegment += 1;
        const src = fresh.get(r.id);
        if (!src) result.missingFromSource += 1;
        else if (src.lat === b.lat && src.lon === b.lon)
          result.latestFixMatchesSource += 1;
        else result.sourceMovedSincePoll += 1;
        result.lagFractionMax = Math.max(
          result.lagFractionMax || 0,
          1 - (r.alpha ?? 1),
        );
        n += 1;
      }
      result.byKind[kind] = n;
      result.checked += n;
    }
    // Nothing drawn means nothing was verified: say so rather than reporting a clean pass.
    result.status =
      result.checked === 0
        ? 'not_run'
        : result.offSegment ||
            result.outOfDomain ||
            result.maxLatErrDeg > 1e-9 ||
            result.maxLonErrDeg > 1e-9
          ? 'fail'
          : 'pass';
    return result;
  }

  destroy() {
    this.group.removeFromParent();
    this.trackLines.removeFromParent();
  }
}

/**
 * Whether moving from fix `a` to fix `b` is a believable forward step for a contact reporting
 * `row.heading` and `row.speedMps`: not against its course and not faster than it can fly.
 */
export function plausibleStep(a, b, row) {
  const DEG = Math.PI / 180;
  const dLat = (b.lat - a.lat) * DEG;
  let dLon = (b.lon - a.lon) % 360;
  if (dLon > 180) dLon -= 360;
  if (dLon < -180) dLon += 360;
  dLon *= DEG;
  const north = dLat * 6371000;
  const east = dLon * 6371000 * Math.cos(((a.lat + b.lat) / 2) * DEG);
  const dist = Math.hypot(north, east);
  if (dist < 1) return true;
  if (Number.isFinite(row.heading) && dist > 200) {
    const h = row.heading * DEG;
    const along = (north * Math.cos(h) + east * Math.sin(h)) / dist;
    if (along < -0.2) return false; // moving against its own reported course
  }
  const dtS = Math.max((b.t - a.t) / 1000, 1);
  if (
    Number.isFinite(row.speedMps) &&
    row.speedMps > 0 &&
    dist > 3 * row.speedMps * dtS + 5000
  )
    return false;
  return true;
}
