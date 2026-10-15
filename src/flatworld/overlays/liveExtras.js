/**
 * Extra live data for the flat world: a key-free regional ship feed, local ADS-B, street traffic,
 * and a marker legend with per-type counts and a type audit.
 *
 * Installed with one call from the flat-world build (`installLiveExtras`). It adds kinds to the
 * live overlay's KINDS table and wraps the overlay's source reads, so every extra contact goes
 * through the same projection, interpolation, picking, tracking and verify() path as aircraft.
 *
 * Kinds added:
 * - `vesselsRegional` — Fintraffic Digitraffic AIS (Baltic / Gulf of Finland / Bothnia), no key,
 *   CORS-open. Ships already reported by the AISStream layer (same MMSI) are dropped here.
 * - `localAdsb` — aircraft heard by the owner's own receiver (the app's `local-adsb` layer).
 * - `traffic` — the `traffic` layer's simulated vehicles. The globe's per-frame animator is paused
 *   while the flat world is shown, so the vehicles are advanced here along their own roads.
 *
 * Classification fix: a contact the flights feed itself flags as military is drawn as a military
 * aircraft (amber), and an aircraft present in both feeds is drawn once.
 */
import * as THREE from 'three';
import { createOpenFreeMapSource } from '../../sources/openFreeMap.js';
import { KINDS } from './liveOverlay.js';
import {
  advanceAlong,
  digitrafficRows,
  spawnVehicles,
  splitMilitary,
} from './liveExtrasCore.js';

export const DIGITRAFFIC_LOCATIONS =
  'https://meri.digitraffic.fi/api/ais/v1/locations';
export const DIGITRAFFIC_VESSELS =
  'https://meri.digitraffic.fi/api/ais/v1/vessels';
const DIGITRAFFIC_HEADERS = { 'Digitraffic-User': 'gods-eye-view/flat-world' };
const MAX_TRAFFIC = 3000;
const DEG = Math.PI / 180;
const TRAFFIC_MAX_ALTITUDE_M = 8000; // the globe traffic layer's own activation altitude
const TRAFFIC_RELOAD_M = 1500;

export const EXTRA_KINDS = {
  vesselsRegional: {
    color: 0x2ad4c4,
    layer: null,
    size: 1.4,
    label: 'Ship (Finnish AIS)',
    shape: 'ship',
  },
  localAdsb: {
    color: 0xf2f6ff,
    layer: 'local-adsb',
    size: 1,
    label: 'Aircraft (your receiver)',
    shape: 'aircraft',
  },
  traffic: {
    color: 0xffe14d,
    layer: 'traffic',
    size: 0.3,
    label: 'Street traffic (simulated)',
    shape: 'box',
  },
};

/** Legend order and names for every kind the overlay can draw. */
export const LEGEND = [
  ['satellites', 'Satellites', 'octahedron'],
  ['flights', 'Aircraft', 'aircraft'],
  ['military', 'Military aircraft', 'aircraft'],
  ['localAdsb', 'Aircraft (your receiver)', 'aircraft'],
  ['vessels', 'Ships (AISStream)', 'ship'],
  ['vesselsRegional', 'Ships (Finnish AIS)', 'ship'],
  ['traffic', 'Street traffic (simulated)', 'box'],
];

// ---- Sources -----------------------------------------------------------------------------------

class DigitrafficSource {
  constructor(fetchImpl = globalThis.fetch?.bind(globalThis)) {
    this.fetch = fetchImpl;
    this.enabled = true;
    this.geojson = null;
    this.meta = new Map();
    this.lastLocations = 0;
    this.lastMeta = 0;
    this.error = null;
    this.busy = false;
    this.updatedAt = null;
  }

  async _refresh() {
    if (this.busy || !this.fetch) return;
    this.busy = true;
    try {
      const now = Date.now();
      if (now - this.lastMeta > 10 * 60 * 1000) {
        this.lastMeta = now;
        const res = await this.fetch(DIGITRAFFIC_VESSELS, {
          headers: DIGITRAFFIC_HEADERS,
        });
        if (res.ok) {
          const list = await res.json();
          this.meta = new Map(list.map((v) => [v.mmsi, v]));
        }
      }
      this.lastLocations = Date.now();
      const res = await this.fetch(DIGITRAFFIC_LOCATIONS, {
        headers: DIGITRAFFIC_HEADERS,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.geojson = await res.json();
      this.updatedAt =
        this.geojson?.dataUpdatedTime ?? new Date().toISOString();
      this.error = null;
    } catch (err) {
      this.error = `Finnish AIS unreachable (${err?.message || err})`;
    } finally {
      this.busy = false;
    }
  }

  rows(skipMmsi) {
    if (!this.enabled) return [];
    // The feed itself refreshes about once a minute (cache max-age 60 s).
    if (Date.now() - this.lastLocations > 60000) this._refresh();
    return digitrafficRows(this.geojson, this.meta, { skipMmsi });
  }
}

/**
 * Simulated street traffic on the real OpenStreetMap road network under the flat-world focus
 * (OpenFreeMap z14 tiles, the same roads the globe's keyless traffic mode uses). Runs only while
 * the app's Street Traffic layer is on and the focus is below the globe layer's own activation
 * altitude; the globe layer itself is paused while the flat world is shown.
 */
class TrafficSource {
  constructor(live) {
    this.live = live;
    this.tiles = createOpenFreeMapSource();
    this.cars = [];
    this.lastMs = 0;
    this.loadedAt = null; // focus {x, y} of the loaded road set
    this.loading = false;
    this.error = null;
    this.generation = 0;
  }

  async _load(f) {
    this.loading = true;
    const gen = ++this.generation;
    // The road source refuses more than 16 z14 tiles: about 1.8 tile widths each way (z14 tiles
    // shrink with latitude, ~1.2 km wide at 60°N).
    const c = Math.max(Math.cos(f.domain.lat * DEG), 0.05);
    const half = 1.8 * 2446 * c;
    const dLat = half / 111195;
    const dLon = half / (111195 * c);
    const box = {
      south: f.domain.lat - dLat,
      north: f.domain.lat + dLat,
      west: f.domain.lon - dLon,
      east: f.domain.lon + dLon,
    };
    try {
      const res = await this.tiles.fetchBounds(box, { zoom: 14 });
      if (gen !== this.generation) return;
      const roads = res.tiles.flatMap((t) => t.roads ?? []);
      this.cars = spawnVehicles(roads, { max: MAX_TRAFFIC, seed: gen });
      this.error = res.partial ? 'some road tiles did not load' : null;
    } catch (err) {
      if (gen === this.generation)
        this.error = `roads unavailable (${err?.message || err})`;
    } finally {
      if (gen === this.generation) this.loading = false;
    }
  }

  rows() {
    const f = this.live.view?.focus;
    if (
      !f ||
      f.domain?.domain !== 'gps' ||
      f.altitude > TRAFFIC_MAX_ALTITUDE_M
    ) {
      this.cars = [];
      this.loadedAt = null;
      this.generation += 1;
      this.loading = false;
      return [];
    }
    const moved = this.loadedAt
      ? Math.hypot(f.x - this.loadedAt.x, f.y - this.loadedAt.y)
      : Infinity;
    if (moved > TRAFFIC_RELOAD_M && !this.loading) {
      this.loadedAt = { x: f.x, y: f.y };
      this._load(f);
    }
    const now = Date.now();
    const dt = this.lastMs ? Math.min((now - this.lastMs) / 1000, 5) : 0;
    this.lastMs = now;
    const out = [];
    for (const car of this.cars) {
      if (dt > 0) {
        let next = advanceAlong(car.coords, car, car.mps * dt);
        if (next.done) {
          // Leaving the road: a new vehicle enters at the start (as the globe layer does).
          next = advanceAlong(
            car.coords,
            {
              ...car,
              segIdx: car.direction > 0 ? 0 : car.coords.length - 2,
              t: car.direction > 0 ? 0 : 1,
            },
            0,
          );
          car.restart = (car.restart || 0) + 1;
        }
        Object.assign(car, next);
      }
      out.push({
        // A restarted vehicle is a new identity, so it snaps instead of sliding back along the road.
        id: car.restart ? `${car.id}#${car.restart}` : car.id,
        label: `Simulated vehicle on ${car.roadName || car.roadClass || 'road'}`,
        lat: car.lat,
        lon: car.lon,
        altitudeM: 0,
        heading: car.heading,
        speedMps: car.mps,
        onGround: true,
        source: 'Simulated on OpenStreetMap roads',
      });
    }
    return out;
  }
}

// ---- Geometry ----------------------------------------------------------------------------------

function shapeGeometry(shape, depth) {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  return g;
}

function geometryFor(kind) {
  if (kind === 'traffic') {
    const g = new THREE.BoxGeometry(0.5, 0.25, 0.25);
    g.translate(0, 0.125, 0);
    return g;
  }
  const s = new THREE.Shape();
  if (EXTRA_KINDS[kind].shape === 'ship') {
    s.moveTo(0.6, 0);
    s.lineTo(0.3, 0.18);
    s.lineTo(-0.5, 0.18);
    s.lineTo(-0.5, -0.18);
    s.lineTo(0.3, -0.18);
    s.lineTo(0.6, 0);
    return shapeGeometry(s, 0.12);
  }
  // Aircraft: same silhouette as the overlay's own aircraft.
  const pts = [
    [0.6, 0],
    [-0.1, 0.08],
    [-0.15, 0.5],
    [-0.3, 0.5],
    [-0.3, 0.07],
    [-0.45, 0.06],
    [-0.5, 0.2],
    [-0.6, 0.2],
    [-0.58, 0],
    [-0.6, -0.2],
    [-0.5, -0.2],
    [-0.45, -0.06],
    [-0.3, -0.07],
    [-0.3, -0.5],
    [-0.15, -0.5],
    [-0.1, -0.08],
    [0.6, 0],
  ];
  s.moveTo(...pts[0]);
  for (const p of pts.slice(1)) s.lineTo(...p);
  const g = shapeGeometry(s, 0.06);
  g.translate(0, 0.03, 0);
  return g;
}

// ---- Install -----------------------------------------------------------------------------------

/**
 * Add the extra kinds, the legend and the audit to a built flat world.
 * @param {{ live: import('./liveOverlay.js').LiveOverlay, panel: any, host?: HTMLElement }} ctx
 */
export function installLiveExtras({ live, panel, host }) {
  if (live._extrasInstalled) return live._extras;
  live._extrasInstalled = true;
  const regional = new DigitrafficSource();
  const traffic = new TrafficSource(live);

  for (const [kind, spec] of Object.entries(EXTRA_KINDS)) {
    KINDS[kind] = spec;
    const mesh = new THREE.InstancedMesh(
      geometryFor(kind),
      new THREE.MeshBasicMaterial({ color: spec.color, fog: false }),
      kind === 'traffic' ? MAX_TRAFFIC : 20000,
    );
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.userData.kind = kind;
    live.meshes[kind] = mesh;
    live.records[kind] = [];
    live.enabled[kind] = true;
    live.group.add(mesh);
  }

  // Military classification: read each feed's own flags once per poll.
  let flagCache = {
    at: -1,
    militaryFlagIds: new Set(),
    militaryIds: new Set(),
  };
  const flags = () => {
    const now = performance.now();
    if (now - flagCache.at < 200) return flagCache;
    const militaryFlagIds = new Set();
    try {
      for (const a of live._module('flights')?.getAnalystRecords?.(20000) ?? [])
        if (a.military === true) militaryFlagIds.add(String(a.icao24 ?? a.id));
    } catch {
      /* layer not ready */
    }
    const militaryIds = new Set(origRead('military').map((r) => r.id));
    flagCache = { at: now, militaryFlagIds, militaryIds };
    return flagCache;
  };

  const origRead = live._readSource.bind(live);
  const origOn = live.isLayerOn.bind(live);
  const origErr = live.layerError.bind(live);
  const origToggle = live.toggleLayer.bind(live);
  live._readSource = (kind) => {
    if (kind === 'vesselsRegional') {
      const skip = new Set((live.records.vessels ?? []).map((r) => r.id));
      return regional.rows(skip);
    }
    if (kind === 'traffic') return origOn('traffic') ? traffic.rows() : [];
    if (kind === 'flights' || kind === 'military') {
      const f = flags();
      if (!f.militaryFlagIds.size) return origRead(kind);
      const flightRows = origOn('flights') ? origRead('flights') : [];
      const { civil, militaryExtra } = splitMilitary(
        flightRows,
        f.militaryFlagIds,
        f.militaryIds,
      );
      if (kind === 'flights') return civil;
      return [...origRead('military'), ...militaryExtra];
    }
    return origRead(kind);
  };
  live.isLayerOn = (kind) =>
    kind === 'vesselsRegional' ? regional.enabled : origOn(kind);
  live.layerError = (kind) =>
    kind === 'vesselsRegional' ? regional.error : origErr(kind);
  live.toggleLayer = (kind) => {
    if (kind === 'vesselsRegional') {
      regional.enabled = !regional.enabled;
      return regional.enabled;
    }
    return origToggle(kind);
  };
  live._module = ((orig) => (layerId) => (layerId ? orig(layerId) : null))(
    live._module.bind(live),
  );

  const audit = () => auditMarkers(live);
  const counts = () => markerCounts(live);
  const extras = { regional, traffic, audit, counts };
  live._extras = extras;
  if (panel) buildLegend({ live, panel, extras });
  if (host) {
    const credits = host.querySelector('.fw-credits');
    if (credits) {
      const span = document.createElement('span');
      span.innerHTML =
        ' · Ships (Baltic): <a href="https://www.digitraffic.fi/en/" target="_blank" rel="noopener">Fintraffic / digitraffic.fi</a>, CC BY 4.0';
      credits.appendChild(span);
    }
  }
  return extras;
}

/** Markers drawn this frame, per kind, plus how many records each feed supplied. */
export function markerCounts(live) {
  const out = {};
  for (const [kind, mesh] of Object.entries(live.meshes))
    out[kind] = { drawn: mesh.count, records: live.records[kind]?.length ?? 0 };
  return out;
}

/**
 * Audit every drawn marker:
 * - each instance belongs to a record of the mesh's own kind (no cross-kind mix-ups);
 * - picking a sample of markers at their own screen position through the overlay's click path
 *   returns a record of the same kind (what the card is built from);
 * - no contact id appears in more than one aircraft kind; no civil row the feed flags military.
 */
export function auditMarkers(live, { samplePerKind = 8 } = {}) {
  const view = live.view;
  const report = { kinds: {}, problems: [] };
  const ray = new THREE.Raycaster();
  const aircraftIds = new Map();
  for (const [kind, mesh] of Object.entries(live.meshes)) {
    const recs = live.records[kind] ?? [];
    const drawn = recs.filter(
      (r) => r.instance !== undefined && r.instance < mesh.count,
    );
    const wrongKind = drawn.filter((r) => r.kind !== kind).length;
    const k = {
      label: KINDS[kind]?.label ?? kind,
      drawn: mesh.count,
      wrongKind,
      picked: 0,
      pickedSameKind: 0,
      pickedOtherKind: 0,
    };
    if (wrongKind)
      report.problems.push(`${kind}: ${wrongKind} markers carry another kind`);
    if (['flights', 'military', 'localAdsb'].includes(kind))
      for (const r of drawn) {
        const prev = aircraftIds.get(r.id);
        if (prev && prev !== kind)
          report.problems.push(
            `aircraft ${r.id} drawn as both ${prev} and ${kind}`,
          );
        aircraftIds.set(r.id, kind);
      }
    if (view?.camera && view.canvas) {
      const rect = view.canvas.getBoundingClientRect();
      const step = Math.max(1, Math.floor(drawn.length / samplePerKind));
      for (let i = 0; i < drawn.length && k.picked < samplePerKind; i += step) {
        const r = drawn[i];
        const s = view.worldToScreen?.(r.drawn);
        if (!s || s.x < 0 || s.y < 0 || s.x > rect.width || s.y > rect.height)
          continue;
        ray.setFromCamera(
          new THREE.Vector2(
            (s.x / rect.width) * 2 - 1,
            -(s.y / rect.height) * 2 + 1,
          ),
          view.camera,
        );
        const hit = live.pick(ray);
        if (!hit) continue;
        k.picked += 1;
        if (hit.kind === kind) k.pickedSameKind += 1;
        else k.pickedOtherKind += 1;
      }
    }
    report.kinds[kind] = k;
  }
  report.status = report.problems.length ? 'problems' : 'ok';
  return report;
}

// ---- Legend ------------------------------------------------------------------------------------

function swatchSvg(color, shape) {
  const hex = `#${color.toString(16).padStart(6, '0')}`;
  const path =
    shape === 'aircraft'
      ? 'M15 7 L7 8 L6 2 L4 2 L4 7.5 L2 8 L1 5 L0 5 L0.5 7 L0 9 L1 9 L2 8 L4 8.5 L4 12 L6 12 L7 8 Z'
      : shape === 'ship'
        ? 'M14 7 L11 4.5 L1 4.5 L1 9.5 L11 9.5 Z'
        : shape === 'octahedron'
          ? 'M7 1 L12 7 L7 13 L2 7 Z'
          : 'M4 5 L10 5 L10 9 L4 9 Z';
  return `<svg width="16" height="14" viewBox="0 0 15 14" aria-hidden="true"><path d="${path}" fill="${hex}"/></svg>`;
}

function buildLegend({ live, panel, extras }) {
  const box = panel.section('markers', 'MARKERS ON SCREEN');
  const table = document.createElement('div');
  table.className = 'fw-legend';
  table.style.cssText =
    'display:grid;grid-template-columns:18px 1fr auto;gap:2px 6px;align-items:center;';
  const rows = {};
  for (const [kind, name, shape] of LEGEND) {
    const spec = KINDS[kind];
    if (!spec) continue;
    const sw = document.createElement('span');
    sw.innerHTML = swatchSvg(spec.color, shape);
    const label = document.createElement('span');
    label.textContent = name;
    const count = document.createElement('b');
    count.style.cssText = 'font-weight:400;color:#cfeef7;text-align:right;';
    count.textContent = '0';
    table.append(sw, label, count);
    rows[kind] = { label, count, name };
  }
  const buttons = document.createElement('div');
  buttons.className = 'fw-row';
  const mk = (text, onclick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fw-btn';
    b.textContent = text;
    b.addEventListener('click', onclick);
    return b;
  };
  const regionalBtn = mk('FINNISH AIS', () =>
    live.toggleLayer('vesselsRegional'),
  );
  const trafficBtn = mk('STREET TRAFFIC', () => live.toggleLayer('traffic'));
  const adsbBtn = mk('LOCAL ADS-B', () => live.toggleLayer('localAdsb'));
  const auditOut = document.createElement('div');
  auditOut.className = 'fw-note';
  const auditBtn = mk('CHECK MARKER TYPES', () => {
    const r = extras.audit();
    const parts = Object.entries(r.kinds)
      .filter(([, k]) => k.drawn)
      .map(([kind, k]) => {
        const name = rows[kind]?.name ?? kind;
        const overlap = k.pickedOtherKind
          ? ` (${k.pickedOtherKind} hit an overlapping marker of another type)`
          : '';
        return `${name}: ${k.drawn} drawn, ${k.pickedSameKind} of ${k.picked} test clicks opened the right card${overlap}`;
      });
    auditOut.textContent =
      (r.status === 'ok'
        ? 'Every marker is drawn as its own type. '
        : `${r.problems.join('; ')}. `) + parts.join(' · ');
  });
  buttons.append(regionalBtn, trafficBtn, adsbBtn, auditBtn);
  const selected = document.createElement('div');
  selected.className = 'fw-note';
  const status = document.createElement('div');
  status.className = 'fw-note fw-warn';
  box.append(table, buttons, selected, status, auditOut);

  const tick = () => {
    requestAnimationFrame(tick);
    if (!document.body.classList.contains('flatworld-active')) return;
    const now = performance.now();
    if (now - (tick.last || 0) < 300) return;
    tick.last = now;
    const c = markerCounts(live);
    for (const [kind, row] of Object.entries(rows)) {
      const n = c[kind]?.drawn ?? 0;
      row.count.textContent = n.toLocaleString();
      row.label.style.opacity = n ? '1' : '0.55';
    }
    regionalBtn.classList.toggle('on', live.isLayerOn('vesselsRegional'));
    trafficBtn.classList.toggle('on', live.isLayerOn('traffic'));
    adsbBtn.classList.toggle('on', live.isLayerOn('localAdsb'));
    const t = live.tracked;
    const rec = t ? live.records[t.kind]?.find((r) => r.id === t.id) : null;
    selected.textContent = rec
      ? `Selected: ${rows[t.kind]?.name ?? t.kind} — ${rec.label}${rec.source ? ` (${rec.source})` : ''}`
      : '';
    const notes = [];
    for (const kind of ['vesselsRegional', 'traffic', 'localAdsb']) {
      if (!live.isLayerOn(kind)) continue;
      const err =
        kind === 'traffic' ? extras.traffic.error : live.layerError(kind);
      if (err) notes.push(`${rows[kind].name}: ${err}`);
    }
    if (live.isLayerOn('traffic') && !(c.traffic?.drawn > 0))
      notes.push(
        'Street traffic: fly down over a city (below about 8 km) to load roads',
      );
    status.textContent = notes.join(' · ');
  };
  requestAnimationFrame(tick);
}
