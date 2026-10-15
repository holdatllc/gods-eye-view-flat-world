/**
 * The globe's screen overlays in the flat world: the detection overlay (brackets, callouts,
 * cards on #world-overlay-root, with its density/fade/opacity sliders) and map annotations.
 * Both normally re-project on the paused globe's render; here they are given a projector through
 * the flat camera and painted on every flat frame. Behind the DETECTION OVERLAY switch.
 */
import * as THREE from 'three';
import * as Cesium from 'cesium';
import {
  setWorldOverlayProjector,
  renderWorldOverlayFrame,
} from '../../overlays/worldOverlay.js';
import {
  setFlatProjector,
  setFlatWorldShown,
  tickFlatFrame,
} from '../../overlays/flatProjection.js';

const scratchCarto = new Cesium.Cartographic();

export class OverlayBridge {
  constructor({ frame, live }) {
    this.frame = frame;
    this.live = live;
    this.recordIds = new Map();
    this.recordLists = [];
    this.enabled = true;
    this.active = false;
    this.v = new THREE.Vector3();
    const self = this;
    this.projector = {
      /**
       * ECEF position → CSS pixels in `out`; false when off screen or behind the camera. An
       * aircraft (`object.sourceId` = ICAO hex) snaps to where the flat map draws it, since the
       * paused globe's copy of its position is not advanced.
       */
      project(position, out, object) {
        const rec = object?.sourceId ? self._record(object.sourceId) : null;
        if (rec?.world) return self._screenWorld(rec.world, rec.drawnHeightM, out);
        const c = Cesium.Cartographic.fromCartesian(
          position,
          Cesium.Ellipsoid.WGS84,
          scratchCarto,
        );
        if (!c) return false;
        return self._screen(
          Cesium.Math.toDegrees(c.latitude),
          Cesium.Math.toDegrees(c.longitude),
          c.height,
          out,
        );
      },
      /** Geodetic → CSS pixels, on the flat terrain when no height is given. */
      projectGeodetic(lon, lat, height) {
        const out = { x: 0, y: 0 };
        return self._screen(lat, lon, height, out) ? out : null;
      },
    };
  }

  attach(view) {
    this.view = view;
  }

  /** The flat map's live record for an id (flights and military), indexed when the lists change. */
  _record(id) {
    const recs = this.live?.records;
    if (!recs) return null;
    const lists = [recs.flights, recs.military];
    if (lists.some((l, i) => l !== this.recordLists[i])) {
      this.recordLists = lists;
      this.recordIds.clear();
      for (const list of lists)
        for (const r of list || []) this.recordIds.set(String(r.id), r);
    }
    return this.recordIds.get(String(id)) || null;
  }

  _screenWorld(w, heightM, out) {
    const view = this.view;
    const e = view.chunks.exaggeration;
    const p = this.v.set(w.x, (heightM || 0) * e, -w.y).project(view.camera);
    if (!(p.z > -1 && p.z < 1)) return false;
    out.x = ((p.x + 1) / 2) * view.canvas.clientWidth;
    out.y = ((1 - p.y) / 2) * view.canvas.clientHeight;
    return Number.isFinite(out.x) && Number.isFinite(out.y);
  }

  _screen(lat, lon, height, out) {
    const view = this.view;
    const w = this.frame.geodeticToWorld(lat, lon);
    if (!w) return false;
    const e = view.chunks.exaggeration;
    const ground = view.chunks.heightAt(w.x, w.y) ?? 0;
    const h = Number.isFinite(height) ? Math.max(ground, height * e) : ground;
    const p = this.v.set(w.x, h, -w.y).project(view.camera);
    if (!(p.z > -1 && p.z < 1)) return false;
    out.x = ((p.x + 1) / 2) * view.canvas.clientWidth;
    out.y = ((1 - p.y) / 2) * view.canvas.clientHeight;
    return Number.isFinite(out.x) && Number.isFinite(out.y);
  }

  _apply() {
    const on = this.active && this.enabled;
    document.body.classList.toggle('fw-detection', on);
    setWorldOverlayProjector(on ? this.projector : null);
    setFlatProjector(on ? this.projector : null);
  }

  setActive(active) {
    this.active = Boolean(active);
    setFlatWorldShown(this.active);
    this._apply();
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    this._apply();
  }

  update() {
    if (!this.active || !this.enabled) return;
    try {
      renderWorldOverlayFrame();
    } catch (error) {
      console.warn('[FlatWorld] detection overlay frame failed', error);
    }
    tickFlatFrame();
  }
}
