/**
 * The selected aircraft's flight path in the flat world.
 *
 * When the globe's route lookup (adsbdb, by callsign) knows where the selected flight is going,
 * this draws both routes between its origin and destination airports, each labelled with its
 * length: the real-world great circle (cyan, curved on the disc) and the flat map's straight line
 * (amber). Off by switch; no route data means nothing is drawn and the card says so.
 */
import * as THREE from 'three';
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
    this.trailLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: 0x7dff9b,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
        fog: false,
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
    if (!this.selection.globeHas(t.kind, t.id)) return { tracked: true };
    let info = null;
    try {
      info = this.live.layerModule(t.kind)?.getTrackedInfo?.() ?? null;
    } catch {
      info = null;
    }
    const origin = airport(info?.route?.origin);
    const destination = airport(info?.route?.destination);
    return {
      tracked: true,
      callsign: info?.callsign || '',
      origin,
      destination,
    };
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
    if (!r.origin || !r.destination) {
      if (this.key !== 'none')
        this._clear(
          'No route data for this flight (the route database does not list it). Green: the track it has flown since you selected it.',
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
    this.status = `${r.origin.code || 'ORIGIN'} → ${r.destination.code || 'DESTINATION'} · globe ${km(geo)} · flat map ${km(res.flat.distanceM)}`;
    this._buildLabels();
  }

  /** Record and draw the selected aircraft's flown track (green). */
  _updateTrail(view) {
    const t = this.live.tracked;
    const rec =
      t && AIRCRAFT.has(t.kind) ? this.live._find(t.kind, t.id) : null;
    const key = rec ? `${t.kind}:${t.id}` : null;
    if (key !== this.trail.id) this.trail = { id: key, points: [], at: 0 };
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
    // Camera-relative positions (float32 on the GPU), ending at the plane's current position.
    const o = pts[0];
    const arr = new Float32Array((pts.length + 1) * 3);
    pts.forEach((p, i) => arr.set([p.x - o.x, p.y - o.y, p.z - o.z], i * 3));
    arr.set(
      [rec.drawn.x - o.x, rec.drawn.y - o.y, rec.drawn.z - o.z],
      pts.length * 3,
    );
    this.trailLine.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(arr, 3),
    );
    this.trailLine.position.copy(o);
    this.trailLine.visible = true;
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
      mk('geo', `GLOBE ROUTE (great circle) · ${km(res.geodesic?.distanceM)}`),
      mk(
        'flat',
        `FLAT MAP STRAIGHT LINE · ${km(res.flat.distanceM)}${Number.isFinite(ground) ? ` (${km(ground)} on the globe)` : ''}`,
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
