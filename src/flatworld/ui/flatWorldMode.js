/**
 * Globe ⇄ flat-world switching. The Cesium globe is hidden and paused, never destroyed or
 * reconfigured; leaving the flat world restores it. While the flat world is shown, the hidden globe
 * camera follows the flat-world focus (GPS domain only) so the existing live feeds keep querying
 * the region being viewed.
 */
import * as Cesium from 'cesium';
import { DOMAIN_GPS } from '../projection/domains.js';

export class FlatWorldMode {
  constructor({ viewer, view, live = null, onChange = () => {} }) {
    this.viewer = viewer;
    this.view = view;
    this.live = live;
    this.onChange = onChange;
    this.active = false;
    this.savedGlobe = null;
    this.entryFocus = null;
    this.syncTimer = null;
    this._onVisibility = () => {
      if (this.active) this.viewer.useDefaultRenderLoop = false;
    };
    document.addEventListener('visibilitychange', this._onVisibility);
  }

  /** Current globe camera, as a restorable view and as a geodetic focus. */
  readGlobe() {
    const camera = this.viewer.camera;
    const scene = this.viewer.scene;
    const saved = {
      destination: Cesium.Cartesian3.clone(camera.positionWC),
      orientation: { heading: camera.heading, pitch: camera.pitch, roll: camera.roll },
    };
    const canvas = scene.canvas;
    const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    let focus = null;
    const hit = camera.pickEllipsoid(center, scene.globe.ellipsoid);
    const carto = camera.positionCartographic;
    if (hit) {
      const c = Cesium.Cartographic.fromCartesian(hit);
      focus = {
        lat: Cesium.Math.toDegrees(c.latitude),
        lon: Cesium.Math.toDegrees(c.longitude),
        range: Cesium.Cartesian3.distance(camera.positionWC, hit),
      };
    } else {
      focus = {
        lat: Cesium.Math.toDegrees(carto.latitude),
        lon: Cesium.Math.toDegrees(carto.longitude),
        range: Math.max(carto.height, 1000),
      };
    }
    return {
      saved,
      focus: {
        ...focus,
        headingDeg: Cesium.Math.toDegrees(camera.heading),
        pitchDeg: Cesium.Math.toDegrees(camera.pitch),
        cameraLat: Cesium.Math.toDegrees(carto.latitude),
        cameraLon: Cesium.Math.toDegrees(carto.longitude),
        cameraHeight: carto.height,
      },
    };
  }

  enter() {
    if (this.active) return;
    // A globe camera flight in progress must not resume underneath us (review D2), and tracking
    // from an earlier flat-world session must not pull the camera away (review D1).
    this.viewer.camera.cancelFlight?.();
    this.live?.stopTracking();
    const globe = this.readGlobe();
    this.savedGlobe = globe.saved;
    const pitch = Math.min(globe.focus.pitchDeg, -5);
    // Large ranges start from the whole-disc overview so the layout is immediately readable.
    const range = Math.min(globe.focus.range, 5.4e7);
    this.view.lookAtGeodetic({ ...globe.focus, range, pitchDeg: pitch });
    const c0 = this.view.controls;
    this.entryFocus = { lat: globe.focus.lat, lon: globe.focus.lon, range, yaw: c0.yaw, pitch: c0.pitch, mode: c0.mode };
    this.viewer.useDefaultRenderLoop = false;
    this.viewer.container.style.visibility = 'hidden';
    document.body.classList.add('flatworld-active');
    this.view.setActive(true);
    this.active = true;
    this.syncTimer = setInterval(() => this.syncHiddenGlobe(), 2000);
    this.onChange(true);
  }

  /** Keep the hidden globe camera over the flat-world focus so live feeds query this region. */
  syncHiddenGlobe() {
    const f = this.view.focus;
    if (!f || f.domain.domain !== DOMAIN_GPS) return;
    const height = Math.min(Math.max(f.altitude, 2000), 2.0e7);
    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(f.domain.lon, f.domain.lat, height),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  }

  /**
   * Leave the flat world. If the user moved within the GPS domain, the globe opens over the same
   * place with the same heading, pitch and range; otherwise (no movement, or a position in the
   * hypothetical ice domain, which has no GPS position) the globe returns to its exact saved view.
   */
  exit() {
    if (!this.active) return;
    clearInterval(this.syncTimer);
    this.live?.stopTracking();
    this.viewer.camera.cancelFlight?.();
    const f = this.view.getFocus();
    const camera = this.viewer.camera;
    const c = this.view.controls;
    let synced = false;
    const eye = this.view.camera.position;
    const eyeDomain = this.view.frame.worldToDomain(eye.x, -eye.z);
    if (c.mode !== 'orbit' && eyeDomain.domain === DOMAIN_GPS) {
      // Fly/walk: put the globe camera at the same eye point, looking the same way (review D9).
      const e = this.view.chunks.exaggeration;
      const ground = this.view.chunks.heightAt(eye.x, -eye.z) ?? 0;
      const height = Math.max((eye.y - ground) + ground / e, 2);
      camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(eyeDomain.lon, eyeDomain.lat, height),
        orientation: {
          heading: Cesium.Math.toRadians(f.heading),
          pitch: Cesium.Math.toRadians(f.pitchDeg),
          roll: 0,
        },
      });
      synced = true;
    } else if (f.domain.domain === DOMAIN_GPS && this.entryFocus) {
      const moved =
        Math.abs(f.domain.lat - this.entryFocus.lat) > 1e-5 ||
        Math.abs(f.domain.lon - this.entryFocus.lon) > 1e-5 ||
        Math.abs(c.distance - this.entryFocus.range) > 1 ||
        Math.abs(c.yaw - this.entryFocus.yaw) > 1e-6 ||
        Math.abs(c.pitch - this.entryFocus.pitch) > 1e-6 ||
        c.mode !== this.entryFocus.mode;
      if (moved) {
        const e = this.view.chunks.exaggeration;
        const target = Cesium.Cartesian3.fromDegrees(f.domain.lon, f.domain.lat, (f.ground || 0) / e);
        const range = Math.max(c.mode === 'orbit' ? c.distance : f.altitude, 50);
        camera.lookAt(
          target,
          new Cesium.HeadingPitchRange(
            Cesium.Math.toRadians(f.heading),
            Cesium.Math.toRadians(Math.min(f.pitchDeg, -1)),
            Math.min(range, 3e7),
          ),
        );
        camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
        synced = true;
      }
    }
    if (!synced && this.savedGlobe) camera.setView(this.savedGlobe);
    this.view.setActive(false);
    // Free most of the flat-world terrain cache while the globe is shown (review D12).
    this.view.chunks.trim?.(6);
    this.viewer.container.style.visibility = '';
    this.viewer.useDefaultRenderLoop = !document.hidden;
    document.body.classList.remove('flatworld-active');
    this.viewer.scene.requestRender();
    this.active = false;
    this.onChange(false);
    return { synced };
  }

  toggle() {
    return this.active ? this.exit() : this.enter();
  }

  destroy() {
    if (this.active) this.exit();
    document.removeEventListener('visibilitychange', this._onVisibility);
  }
}
