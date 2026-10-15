/**
 * Globe markers in the flat world: the hidden globe's own entities, re-drawn through the
 * projection.
 *
 * Nearby sites (OpenStreetMap installations found by SEARCH NEARBY SITES) and space missions
 * (launch pads, ascent trajectories, orbits, payloads) are Cesium entities on the globe. This
 * mirrors every showing entity of those data sources into the flat scene once a second: points
 * with their globe colour and name, and polylines as lines, both at true height (times the flat
 * world's relief exaggeration, as the live layers are). A click on a mirrored site or launch
 * selects it through the globe layer that owns it.
 */
import * as THREE from 'three';
import * as Cesium from 'cesium';

/** Globe data sources to mirror, with how a click selects one of their entities. */
export const MIRRORED_SOURCES = {
  'military-installations': { label: 'Site', color: '#ffb84d' },
  'rocket-launches': { label: 'Launch', color: '#ff7a59' },
};
const MAX_LABELS = 80;
const scratchCarto = new Cesium.Cartographic();

function cssColor(c, fallback) {
  if (!c || !Number.isFinite(c.red)) return fallback;
  return `rgb(${Math.round(c.red * 255)}, ${Math.round(c.green * 255)}, ${Math.round(c.blue * 255)})`;
}

export class GlobeEntityMirror {
  constructor({ viewer, frame, dataManager }) {
    this.viewer = viewer;
    this.frame = frame;
    this.dataManager = dataManager;
    this.enabled = true;
    this.items = [];
    this.timer = 1;
    this.group = new THREE.Group();
    this.group.name = 'flatworld-globe-entities';
    this.pointGeometry = new THREE.BufferGeometry();
    this.points = new THREE.Points(
      this.pointGeometry,
      new THREE.PointsMaterial({
        size: 9,
        sizeAttenuation: false,
        vertexColors: true,
        depthTest: false,
        transparent: true,
        fog: false,
      }),
    );
    this.points.renderOrder = 21;
    this.points.frustumCulled = false;
    this.lineGeometry = new THREE.BufferGeometry();
    this.lines = new THREE.LineSegments(
      this.lineGeometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        fog: false,
      }),
    );
    this.lines.renderOrder = 20;
    this.lines.frustumCulled = false;
    this.group.add(this.lines, this.points);
  }

  attach(view) {
    this.view = view;
    view.scene.add(this.group);
    this.labelHost = document.createElement('div');
    this.labelHost.className = 'fw-globe-labels';
    view.host.appendChild(this.labelHost);
    this.labelPool = [];
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    this.group.visible = this.enabled;
    this.labelHost.hidden = !this.enabled;
    this.timer = 1;
  }

  _sources() {
    const out = [];
    const ds = this.viewer.dataSources;
    for (let i = 0; i < ds.length; i += 1) {
      const d = ds.get(i);
      const meta = MIRRORED_SOURCES[d.name];
      if (meta && d.show) out.push({ d, meta });
    }
    return out;
  }

  _toWorld(cartesian, e, onGround) {
    const c = Cesium.Cartographic.fromCartesian(
      cartesian,
      Cesium.Ellipsoid.WGS84,
      scratchCarto,
    );
    if (!c) return null;
    const lat = Cesium.Math.toDegrees(c.latitude);
    const lon = Cesium.Math.toDegrees(c.longitude);
    const w = this.frame.geodeticToWorld(lat, lon);
    if (!w) return null;
    const ground = this.view.chunks.heightAt(w.x, w.y) ?? 0;
    const h = onGround
      ? ground + 60 * e
      : Math.max(ground + 60 * e, (c.height || 0) * e);
    return { x: w.x, y: w.y, h, lat, lon };
  }

  /** Name for a space-mission entity (`rocket-<part>:<launch id>[:n]`), from the mission roster. */
  _launchName(id) {
    const m = /^rocket-([a-z-]+):([^:]+)/.exec(id);
    if (!m) return '';
    const row = this._roster?.get(m[2]);
    const vehicle =
      row?.querySelector('strong')?.textContent?.trim() || 'MISSION';
    const part = {
      launch: 'PAD',
      satellite: 'PAYLOAD',
      vehicle: 'VEHICLE',
      'recovery-end': 'RECOVERY',
    }[m[1]];
    return part ? `${vehicle} · ${part}` : '';
  }

  /** Rebuild the mirrored points and lines from the globe's entities. */
  _rebuild() {
    const view = this.view;
    const e = view.chunks.exaggeration;
    const time = Cesium.JulianDate.now();
    const focus = view.getFocus();
    const origin = { x: focus.x, y: focus.y };
    this.group.position.set(origin.x, 0, -origin.y);
    this._roster = new Map(
      [...document.querySelectorAll('.space-mission-roster-item')].map((b) => [
        b.dataset.missionRosterId,
        b,
      ]),
    );
    const items = [];
    const pos = [];
    const col = [];
    const lpos = [];
    const lcol = [];
    const color = new THREE.Color();
    for (const { d, meta } of this._sources()) {
      for (const entity of d.entities.values) {
        if (!entity.isShowing) continue;
        const poly = entity.polyline;
        if (poly && poly.show?.getValue(time) !== false) {
          const positions = poly.positions?.getValue(time);
          if (Array.isArray(positions) && positions.length > 1) {
            const clamp = poly.clampToGround?.getValue(time) === true;
            color.setStyle(
              cssColor(
                poly.material?.color?.getValue?.(time) ??
                  poly.material?.getValue?.(time)?.color,
                meta.color,
              ),
            );
            let prev = null;
            const step = Math.max(1, Math.floor(positions.length / 400));
            for (let i = 0; i < positions.length; i += step) {
              const p = this._toWorld(positions[i], e, clamp);
              if (p && prev) {
                lpos.push(
                  prev.x - origin.x,
                  prev.h,
                  -(prev.y - origin.y),
                  p.x - origin.x,
                  p.h,
                  -(p.y - origin.y),
                );
                lcol.push(color.r, color.g, color.b, color.r, color.g, color.b);
              }
              if (p) prev = p;
            }
          }
        }
        if (!entity.position || (!entity.point && !entity.billboard)) continue;
        const cart = entity.position.getValue(time);
        if (!cart) continue;
        const clamp =
          entity.point?.heightReference?.getValue?.(time) ===
            Cesium.HeightReference.CLAMP_TO_GROUND ||
          entity.billboard?.heightReference?.getValue?.(time) ===
            Cesium.HeightReference.CLAMP_TO_GROUND;
        const p = this._toWorld(cart, e, clamp);
        if (!p) continue;
        const css = cssColor(
          entity.point?.color?.getValue(time) ??
            entity.billboard?.color?.getValue(time),
          meta.color,
        );
        color.setStyle(css);
        pos.push(p.x - origin.x, p.h, -(p.y - origin.y));
        col.push(color.r, color.g, color.b);
        const name =
          entity.name ||
          entity.gevLabelModel?.title ||
          entity.label?.text?.getValue?.(time) ||
          this._launchName(String(entity.id)) ||
          '';
        items.push({
          source: d.name,
          meta,
          entity,
          name: String(name).slice(0, 40),
          css,
          world: new THREE.Vector3(p.x, p.h, -p.y),
          lat: p.lat,
          lon: p.lon,
        });
      }
    }
    this.pointGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(pos, 3),
    );
    this.pointGeometry.setAttribute(
      'color',
      new THREE.Float32BufferAttribute(col, 3),
    );
    this.lineGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(lpos, 3),
    );
    this.lineGeometry.setAttribute(
      'color',
      new THREE.Float32BufferAttribute(lcol, 3),
    );
    this.items = items;
  }

  update(dt, view) {
    if (!this.enabled) return;
    this.timer += dt;
    if (this.timer > 1) {
      this.timer = 0;
      try {
        this._rebuild();
      } catch (error) {
        console.warn('[FlatWorld] globe marker mirror failed', error);
      }
    }
    this._placeLabels(view);
  }

  _placeLabels(view) {
    const rect = view.canvas;
    const w = rect.clientWidth;
    const h = rect.clientHeight;
    const shown = [];
    for (const it of this.items) {
      if (!it.name) continue;
      const s = view.worldToScreen(it.world);
      it.screen = s;
      if (!s || s.x < 0 || s.y < 0 || s.x > w || s.y > h) continue;
      shown.push(it);
      if (shown.length >= MAX_LABELS) break;
    }
    while (this.labelPool.length < shown.length) {
      const el = document.createElement('div');
      el.className = 'fw-globe-label';
      this.labelHost.appendChild(el);
      this.labelPool.push(el);
    }
    this.labelPool.forEach((el, i) => {
      const it = shown[i];
      if (!it) {
        el.style.display = 'none';
        return;
      }
      el.style.display = '';
      if (el.textContent !== it.name) el.textContent = it.name;
      el.style.setProperty('--fw-accent', it.css);
      el.style.transform = `translate(${Math.round(it.screen.x)}px, ${Math.round(it.screen.y)}px)`;
    });
  }

  /** Mirrored marker under a screen point (client coordinates), or null. */
  nearest(clientX, clientY, radiusPx = 12) {
    if (!this.enabled || !this.view) return null;
    const r = this.view.canvas.getBoundingClientRect();
    const x = clientX - r.left;
    const y = clientY - r.top;
    let best = null;
    let bestD = radiusPx;
    for (const it of this.items) {
      const s = it.screen ?? this.view.worldToScreen(it.world);
      if (!s) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestD) {
        bestD = d;
        best = it;
      }
    }
    return best;
  }

  /** Select a mirrored marker through the globe layer that owns it. */
  select(item) {
    if (!item) return false;
    const id = String(item.entity.id);
    if (item.source === 'military-installations') {
      const mod = this.dataManager?.layers?.get?.(item.source)?.module;
      const recId = item.entity.installationId || id;
      try {
        return mod?.focusById?.(recId) !== false;
      } catch {
        return false;
      }
    }
    if (item.source === 'rocket-launches') {
      const launchId = id.split(':').slice(1).join(':');
      const row = [
        ...document.querySelectorAll('.space-mission-roster-item'),
      ].find((b) => b.dataset.missionRosterId === launchId);
      if (row) {
        row.click();
        return true;
      }
      this.viewer.selectedEntity = item.entity;
      return true;
    }
    return false;
  }

  destroy() {
    this.group.removeFromParent();
    this.labelHost?.remove();
  }
}
