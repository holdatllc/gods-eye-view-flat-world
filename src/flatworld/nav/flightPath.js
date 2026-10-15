/**
 * The selected aircraft's flight path in the flat world.
 *
 * When the globe's route lookup (adsbdb, by callsign) knows where the selected flight is going,
 * this draws both routes between its origin and destination airports, each labelled with its
 * length: the real-world great circle (cyan, curved on the disc) and the flat map's straight line
 * (amber). Off by switch; no route data means nothing is drawn and the card says so.
 */
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { RouteLayer } from './routeLayer.js';

const AIRCRAFT = new Set(['flights', 'military']);

function km(m) {
  return Number.isFinite(m)
    ? `${Math.round(m / 1000).toLocaleString('en-US')} km`
    : '—';
}

function airport(p) {
  if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return null;
  return {
    lat: p.lat,
    lon: p.lon,
    code: p.code || p.iata || p.icao || '',
    name: p.name || '',
  };
}

export class FlightPath {
  constructor({ frame, live, selection }) {
    this.frame = frame;
    this.live = live;
    this.selection = selection;
    this.routes = new RouteLayer({ frame });
    this.enabled = true;
    this.key = '';
    this.status = '';
    this.result = null;
    this.ends = null;
    this.checkTimer = 0;
    // The track flown since the plane was selected (drawn whether or not a route is known).
    this.trail = { id: null, points: [] };
    this.trailLine = new Line2(
      new LineGeometry(),
      new LineMaterial({
        color: 0x7dff9b,
        linewidth: 3,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
      }),
    );
    this.trailLine.renderOrder = 22;
    this.trailLine.frustumCulled = false;
    this.trailLine.visible = false;
  }

  attach(view) {
    this.view = view;
    this.routes.attach(view);
    view.scene.add(this.trailLine);
    this.labels = document.createElement('div');
    this.labels.className = 'fw-route-labels';
    view.host.appendChild(this.labels);
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    if (!this.enabled) {
      this._clear('');
      this.trailLine.visible = false;
    }
    this.key = '';
  }

  /** Route of the selected aircraft as the globe layer reports it, or null. */
  _route() {
    const t = this.live.tracked;
    if (!t || !AIRCRAFT.has(t.kind)) return { tracked: false };
    let info = null;
    if (this.selection.globeHas(t.kind, t.id)) {
      try {
        info = this.live.layerModule(t.kind)?.getTrackedInfo?.() ?? null;
      } catch {
        info = null;
      }
    }
    let origin = airport(info?.route?.origin);
    let destination = airport(info?.route?.destination);
    // The globe's own lookup only runs for its tracked plane and only after a while; ask the
    // app's route endpoint (adsbdb, keyless) directly by callsign, once per callsign.
    if (!origin || !destination) {
      const rec = this.live._find(t.kind, t.id);
      const callsign = String(
        info?.callsign || rec?.callsign || rec?.label || '',
      )
        .trim()
        .toUpperCase();
      const looked = callsign ? this._lookup(callsign) : null;
      if (looked === 'pending') return { tracked: true, pending: true };
      if (looked) ({ origin, destination } = looked);
    }
    return {
      tracked: true,
      callsign: info?.callsign || '',
      origin,
      destination,
    };
  }

  /** Route by callsign from /api/adsbdb/route: the route, null (none), or 'pending'. */
  _lookup(callsign) {
    this.cache ??= new Map();
    if (!/^[A-Z0-9]{3,8}$/.test(callsign)) return null;
    if (this.cache.has(callsign)) return this.cache.get(callsign);
    this.cache.set(callsign, 'pending');
    fetch(`/api/adsbdb/route/${encodeURIComponent(callsign)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const o = airport(j?.origin);
        const d = airport(j?.destination);
        this.cache.set(
          callsign,
          j?.found && o && d ? { origin: o, destination: d } : null,
        );
      })
      .catch(() => this.cache.set(callsign, null))
      .finally(() => (this.checkTimer = 1));
    return 'pending';
  }

  _clear(status) {
    if (this.result) this.routes.clear();
    this.result = null;
    this.ends = null;
    this.status = status;
    if (this.labels) this.labels.innerHTML = '';
  }

  update(dt, view) {
    this.routes.update(dt, view);
    // A new selection: drop the previous plane's route at once, then look up the new one.
    const sel = this.live.tracked
      ? `${this.live.tracked.kind}:${this.live.tracked.id}`
      : '';
    if (sel !== this.selKey) {
      this.selKey = sel;
      this._clear(sel ? 'Looking up the route…' : '');
      this.key = '';
      this.checkTimer = 1;
    }
    this.checkTimer += dt;
    if (this.checkTimer > 1) {
      this.checkTimer = 0;
      if (this.enabled) this._refresh();
    }
    if (this.enabled) this._updateTrail(view);
    this._placeLabels(view);
  }

  _refresh() {
    const r = this._route();
    if (!r.tracked) {
      if (this.key) this._clear('');
      this.key = '';
      return;
    }
    if (r.pending) {
      if (this.key !== 'pending') this._clear('Looking up the route…');
      this.key = 'pending';
      return;
    }
    if (!r.origin || !r.destination) {
      if (this.key !== 'none')
        this._clear(
          'No route data for this flight (the route database does not list it). Green: the track it has flown.',
        );
      this.key = 'none';
      return;
    }
    const key = `${r.origin.lat},${r.origin.lon}>${r.destination.lat},${r.destination.lon}`;
    if (key === this.key) return;
    this.key = key;
    this.routes.clear();
    const res = this.routes.measureGeodetic(
      [r.origin.lat, r.origin.lon],
      [r.destination.lat, r.destination.lon],
    );
    this.result = res;
    this.ends = { origin: r.origin, destination: r.destination };
    const geo = res.geodesic?.distanceM;
    // Real-world distances first; the map-scale length of the straight line is secondary.
    const flown = res.flatPathOnEarth?.groundLengthM;
    this.status = `${r.origin.code || 'ORIGIN'} → ${r.destination.code || 'DESTINATION'} · real shortest route ${km(geo)} (cyan) · straight on flat map ${km(flown)} real, ${km(res.flat.distanceM)} on map scale (amber)`;
    this._buildLabels();
  }

  /** Record and draw the selected aircraft's flown track (green). */
  _updateTrail(view) {
    const t = this.live.tracked;
    const rec =
      t && AIRCRAFT.has(t.kind) ? this.live._find(t.kind, t.id) : null;
    const key = rec ? `${t.kind}:${t.id}` : null;
    if (key !== this.trail.id) {
      this.trail = { id: key, points: [], at: 0, history: [] };
      if (rec) this._fetchHistory(t.kind, t.id, key);
    }
    if (!rec?.drawn) {
      this.trailLine.visible = false;
      return;
    }
    const pts = this.trail.points;
    const last = pts[pts.length - 1];
    const now = performance.now();
    if (
      !last ||
      (now - this.trail.at > 2000 && last.distanceTo(rec.drawn) > 50)
    ) {
      pts.push(rec.drawn.clone());
      this.trail.at = now;
      if (pts.length > 2000) pts.shift();
    }
    if (pts.length < 1) return;
    // The flown track from takeoff (the same history the globe draws), then the positions seen
    // since selection, ending at the plane. Camera-relative (float32 on the GPU).
    const all = [...this._historyPoints(view), ...pts];
    const o = all[0];
    const arr = new Float32Array((all.length + 1) * 3);
    all.forEach((p, i) => arr.set([p.x - o.x, p.y - o.y, p.z - o.z], i * 3));
    arr.set(
      [rec.drawn.x - o.x, rec.drawn.y - o.y, rec.drawn.z - o.z],
      all.length * 3,
    );
    // A fresh geometry when the vertex count changes (Line2 buffers are sized on first use).
    if (this.trailLine.userData.n !== all.length + 1) {
      this.trailLine.geometry.dispose();
      this.trailLine.geometry = new LineGeometry();
      this.trailLine.userData.n = all.length + 1;
    }
    this.trailLine.geometry.setPositions(arr);
    view.renderer.getSize(this.trailLine.material.resolution);
    this.trailLine.position.copy(o);
    this.trailLine.visible = true;
  }

  /**
   * The aircraft's track since takeoff from the app's own track endpoints (OpenSky /tracks for
   * flights, the readsb trace for military), as the globe's trail backfill uses.
   */
  _fetchHistory(kind, id, key) {
    const url =
      kind === 'military'
        ? `/api/military/track?hex=${encodeURIComponent(id)}`
        : `/api/flights/track?icao24=${encodeURIComponent(id)}`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j || this.trail.id !== key) return;
        const rows = Array.isArray(j.path)
          ? j.path
          : Array.isArray(j.trace)
            ? j.trace
            : [];
        const feet = kind === 'military' && !Array.isArray(j.path);
        const history = [];
        for (const row of rows) {
          if (!Array.isArray(row)) continue;
          const lat = Number(row[1]);
          const lon = Number(row[2]);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          const alt = Number(row[3]);
          history.push({
            lat,
            lon,
            altM: Number.isFinite(alt) ? (feet ? alt * 0.3048 : alt) : 0,
          });
        }
        this.trail.history = history;
        this.trail.historyBuilt = null;
      })
      .catch(() => {});
  }

  /** History waypoints as flat-world points (rebuilt when the relief changes). */
  _historyPoints(view) {
    const h = this.trail.history;
    if (!h?.length) return [];
    const e = view.chunks.exaggeration;
    if (this.trail.historyBuilt?.e === e) return this.trail.historyBuilt.pts;
    const pts = [];
    for (const w of h) {
      const p = this.frame.geodeticToWorld(w.lat, w.lon);
      if (p) pts.push(new THREE.Vector3(p.x, Math.max(w.altM, 0) * e, -p.y));
    }
    this.trail.historyBuilt = { e, pts };
    return pts;
  }

  _buildLabels() {
    const { origin, destination } = this.ends;
    const res = this.result;
    const mk = (cls, text) =>
      `<div class="fw-route-label ${cls}">${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</div>`;
    const ground = res.flatPathOnEarth?.groundLengthM;
    this.labels.innerHTML = [
      mk(
        'end',
        `${origin.code || 'ORIGIN'}${origin.name ? ` · ${origin.name}` : ''}`,
      ),
      mk(
        'end',
        `${destination.code || 'DESTINATION'}${destination.name ? ` · ${destination.name}` : ''}`,
      ),
      mk('geo', `REAL SHORTEST ROUTE · ${km(res.geodesic?.distanceM)}`),
      mk(
        'flat',
        `STRAIGHT ON FLAT MAP · ${Number.isFinite(ground) ? `${km(ground)} real (${km(res.flat.distanceM)} on map scale)` : `${km(res.flat.distanceM)} on map scale`}`,
      ),
    ].join('');
  }

  _screen(view, p) {
    const h = view.chunks.heightAt(p.x, p.y) ?? 0;
    return view.worldToScreen(new THREE.Vector3(p.x, h, -p.y));
  }

  _placeLabels(view) {
    if (!this.result || !this.labels.children.length) return;
    const res = this.result;
    const geoPts = res.geodesic?.plane || [];
    const flatPts = res.flat.points;
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const anchors = [
      flatPts[0],
      flatPts[1],
      geoPts.length ? geoPts[Math.floor(geoPts.length / 2)] : null,
      mid(flatPts[0], flatPts[1]),
    ];
    [...this.labels.children].forEach((el, i) => {
      const p = anchors[i] && this._screen(view, anchors[i]);
      if (!p) {
        el.style.display = 'none';
        return;
      }
      el.style.display = '';
      el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
    });
  }

  destroy() {
    this.routes.destroy();
    this.labels?.remove();
  }
}
