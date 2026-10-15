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
import { routePlausible } from '../../data/routePlausible.js';
import { TRAIL_COLOR, TRAIL_MAX_POINTS } from '../../layers/flights/policy.js';

const MILITARY_TRAIL = 0xffb800;

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
    // Further legs through fuel / layover stops (created as needed).
    this.extraLegs = [];
    this.legs = [];
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
      // The globe's trail: cyan #00d4ff (amber for military), 2.5 px, 85 % opacity.
      new LineMaterial({
        color: new THREE.Color(TRAIL_COLOR),
        linewidth: 2.5,
        transparent: true,
        opacity: 0.85,
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
    let stops = [];
    // The app's route endpoint by callsign (adsbdb + hexdb, keyless, cached on the server): it
    // also lists fuel / layover stops, which the globe's own route record does not carry.
    const rec = this.live._find(t.kind, t.id);
    const callsign = String(info?.callsign || rec?.callsign || rec?.label || '')
      .trim()
      .toUpperCase();
    const looked = callsign ? this._lookup(callsign) : null;
    if (looked === 'pending' && (!origin || !destination))
      return { tracked: true, pending: true };
    if (looked && looked !== 'pending')
      ({ origin, destination, stops } = looked);
    // Test hook: a route forced onto the selected plane (see forceRoute).
    if (this.forced?.key === `${t.kind}:${t.id}`)
      ({ origin, destination, stops } = this.forced.route);
    // The globe's plausibility check: a route the plane is not plausibly flying (wrong leg of a
    // reused callsign) is not drawn. With stops, plausible on any leg counts.
    else if (origin && destination && rec) {
      const pts = [origin, ...(stops || []), destination];
      let ok = false;
      for (let i = 0; i < pts.length - 1 && !ok; i++)
        ok = routePlausible({
          latDeg: rec.lat,
          lonDeg: rec.lon,
          altitudeM: rec.altitudeM ?? null,
          verticalRateMps: rec.verticalRateMps ?? null,
          origin: pts[i],
          destination: pts[i + 1],
        });
      if (!ok) return { tracked: true, implausible: true };
    }
    return {
      tracked: true,
      callsign: info?.callsign || '',
      origin,
      destination,
      stops: stops || [],
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
        const stops = (j?.stops || []).map(airport).filter(Boolean);
        this.cache.set(
          callsign,
          j?.found && o && d ? { origin: o, destination: d, stops } : null,
        );
      })
      .catch(() => this.cache.set(callsign, null))
      .finally(() => (this.checkTimer = 1));
    return 'pending';
  }

  /**
   * Test hook: draw `route` ({origin, destination, stops}, each {lat, lon, code, name}) for the
   * selected plane, e.g. window.__flatWorld.flightPath.forceRoute(await (await
   * fetch('/api/adsbdb/route/QFA9')).json()). forceRoute(null) clears it.
   */
  forceRoute(route) {
    const t = this.live.tracked;
    this.forced =
      route && t
        ? {
            key: `${t.kind}:${t.id}`,
            route: {
              origin: airport(route.origin),
              destination: airport(route.destination),
              stops: (route.stops || []).map(airport).filter(Boolean),
            },
          }
        : null;
    this.key = '';
    this.checkTimer = 1;
  }

  _clear(status) {
    if (this.result) this.routes.clear();
    for (const l of this.extraLegs) l.clear();
    this.legs = [];
    this.result = null;
    this.ends = null;
    this.status = status;
    if (this.labels) this.labels.innerHTML = '';
  }

  update(dt, view) {
    this.routes.update(dt, view);
    for (const l of this.extraLegs) l.update(dt, view);
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
    if (r.implausible) {
      if (this.key !== 'implausible')
        this._clear(
          'The route database lists a route this plane is not plausibly flying (the globe hides it too). Green: the track it has flown.',
        );
      this.key = 'implausible';
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
    // One leg per hop: origin → each fuel / layover stop → destination.
    const airports = [r.origin, ...(r.stops || []), r.destination];
    const key = airports.map((a) => `${a.lat},${a.lon}`).join('>');
    if (key === this.key) return;
    this.key = key;
    this._clear('');
    const layers = [this.routes];
    while (this.extraLegs.length < airports.length - 2) {
      const l = new RouteLayer({ frame: this.frame });
      l.attach(this.view);
      this.extraLegs.push(l);
    }
    layers.push(...this.extraLegs);
    this.legs = [];
    for (let i = 0; i < airports.length - 1; i++) {
      const a = airports[i];
      const b = airports[i + 1];
      const res = layers[i].measureGeodetic([a.lat, a.lon], [b.lat, b.lon]);
      this.legs.push({ a, b, res });
    }
    this.result = this.legs[0].res;
    this.ends = { origin: r.origin, destination: r.destination };
    // Real-world distances first; the map-scale length of the straight line is secondary.
    const sum = (f) => this.legs.reduce((t, l) => t + (f(l.res) || 0), 0);
    const geo = sum((x) => x.geodesic?.distanceM);
    const flown = sum((x) => x.flatPathOnEarth?.groundLengthM);
    const map = sum((x) => x.flat.distanceM);
    const path = airports.map((a) => a.code || '?').join(' → ');
    const stopsNote = r.stops?.length
      ? `${r.stops.length} stop${r.stops.length > 1 ? 's' : ''}: ${r.stops.map((a) => a.code || a.name).join(', ')}`
      : 'stops: not in route data';
    const legsNote =
      this.legs.length > 1
        ? ` · legs ${this.legs.map((l) => `${l.a.code}→${l.b.code} ${km(l.res.geodesic?.distanceM)}`).join(', ')}`
        : '';
    this.status = `${path} (${stopsNote}) · real shortest route ${km(geo)} total (cyan) · straight on flat map ${km(flown)} real, ${km(map)} on map scale (amber)${legsNote}`;
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
      this.trailLine.material.color.set(
        t?.kind === 'military' ? MILITARY_TRAIL : TRAIL_COLOR,
      );
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
      if (pts.length > TRAIL_MAX_POINTS) pts.shift();
    }
    if (pts.length < 1) return;
    // The flown track from takeoff (the same history the globe draws), then the positions seen
    // since selection, ending at the plane. Camera-relative (float32 on the GPU).
    // At most TRAIL_MAX_POINTS vertices in all, as the globe: the history is thinned to fit.
    let hist = this._historyPoints(view);
    const room = Math.max(TRAIL_MAX_POINTS - pts.length, 2);
    if (hist.length > room) {
      const step = hist.length / room;
      const thin = [];
      for (let i = 0; i < room; i++) thin.push(hist[Math.floor(i * step)]);
      thin[thin.length - 1] = hist[hist.length - 1];
      hist = thin;
    }
    const all = [...hist, ...pts];
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
    // Rebuilt every few seconds as finer terrain (the floor) loads.
    const hb = this.trail.historyBuilt;
    if (hb?.e === e && performance.now() - hb.at < 5000) return hb.pts;
    const pts = [];
    for (const w of h) {
      const p = this.frame.geodeticToWorld(w.lat, w.lon);
      // Heights are above sea level here (no geoid step needed in the flat frame), floored at
      // the rendered terrain so a low or missing barometric altitude never dives underground.
      const ground = p ? (view.chunks.heightAt(p.x, p.y) ?? 0) : 0;
      if (p)
        pts.push(
          new THREE.Vector3(
            p.x,
            Math.max(Math.max(w.altM, 0) * e, ground + 5),
            -p.y,
          ),
        );
    }
    this.trail.historyBuilt = { e, pts, at: performance.now() };
    return pts;
  }

  _buildLabels() {
    const esc = (t) =>
      t.replace(
        /[&<>]/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c],
      );
    const html = [];
    this.labelAnchors = [];
    const legs = this.legs;
    const airports = [legs[0].a, ...legs.map((l) => l.b)];
    airports.forEach((a, i) => {
      const role = i === 0 ? '' : i === airports.length - 1 ? '' : ' · STOP';
      html.push(
        `<div class="fw-route-label end">${esc(`${a.code || 'AIRPORT'}${a.name ? ` · ${a.name}` : ''}${role}`)}</div>`,
      );
      this.labelAnchors.push({
        leg: Math.max(i - 1, 0),
        at: i === 0 ? 'a' : 'b',
      });
    });
    legs.forEach((l, i) => {
      const res = l.res;
      const ground = res.flatPathOnEarth?.groundLengthM;
      const prefix = legs.length > 1 ? `${l.a.code}→${l.b.code} · ` : '';
      html.push(
        `<div class="fw-route-label geo">${esc(`${prefix}REAL SHORTEST ROUTE · ${km(res.geodesic?.distanceM)}`)}</div>`,
      );
      this.labelAnchors.push({ leg: i, at: 'geo' });
      html.push(
        `<div class="fw-route-label flat">${esc(`${prefix}STRAIGHT ON FLAT MAP · ${Number.isFinite(ground) ? `${km(ground)} real (${km(res.flat.distanceM)} on map scale)` : `${km(res.flat.distanceM)} on map scale`}`)}</div>`,
      );
      this.labelAnchors.push({ leg: i, at: 'flat' });
    });
    this.labels.innerHTML = html.join('');
  }

  _screen(view, p) {
    const h = view.chunks.heightAt(p.x, p.y) ?? 0;
    return view.worldToScreen(new THREE.Vector3(p.x, h, -p.y));
  }

  _placeLabels(view) {
    if (!this.legs?.length || !this.labels.children.length) return;
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    [...this.labels.children].forEach((el, i) => {
      const spec = this.labelAnchors?.[i];
      const res = spec && this.legs[spec.leg]?.res;
      let anchor = null;
      if (res) {
        const f = res.flat.points;
        const g = res.geodesic?.plane || [];
        anchor =
          spec.at === 'a'
            ? f[0]
            : spec.at === 'b'
              ? f[1]
              : spec.at === 'geo'
                ? g.length
                  ? g[Math.floor(g.length / 2)]
                  : null
                : mid(f[0], f[1]);
      }
      const p = anchor && this._screen(view, anchor);
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
    for (const l of this.extraLegs) l.destroy();
    this.labels?.remove();
  }
}
