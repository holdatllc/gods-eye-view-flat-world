/**
 * Flat World mode for God's Eye View: a North-Pole-centred azimuthal-equidistant 3D world with a
 * deterministic procedural ice domain beyond the South-Pole circle.
 *
 * Mounted after the standalone application starts. Only the FLAT WORLD button is created up
 * front: the renderer, workers and layers are built the first time the flat world is opened, so
 * a globe-only session pays nothing. It reads the existing viewer and data manager and never
 * modifies the globe's renderer, layers or sources.
 */
import * as THREE from 'three';
import { FlatWorldView } from './render/flatWorldView.js';
import { FlatWorldMode } from './ui/flatWorldMode.js';
import { LiveOverlay } from './overlays/liveOverlay.js';
import { LiveLabels } from './overlays/liveLabels.js';
import { VectorLines } from './overlays/vectorLines.js';
import { IceEnvironment } from './ice/iceEnvironment.js';
import { RouteLayer } from './nav/routeLayer.js';
import { BuildingsLayer } from './buildings/buildingsLayer.js';
import { SkyBodies } from './sky/skyBodies.js';
import { WallLayer } from './wall/wallLayer.js';
import {
  createWorldFrame,
  DOMAIN_GPS,
  DOMAIN_ICE,
} from './projection/domains.js';
import { allAttributions, attributionHtml } from './sources/catalog.js';
import { installLiveExtras } from './overlays/liveExtras.js';
import { installStyles } from './ui/styles.js';
import { createPanel } from './ui/panel.js';
import { createLiveSelection } from './ui/liveSelection.js';
import { createFlatCockpit } from './ui/flatCockpit.js';
import { FlightPath } from './nav/flightPath.js';
import { GlobeEntityMirror } from './overlays/globeEntities.js';
import { createFlatPresets } from './ui/flatPresets.js';

function createToggle() {
  const toggle = document.createElement('button');
  toggle.className = 'fw-toggle';
  toggle.type = 'button';
  toggle.title = 'Switch between the globe and the flat world';
  toggle.innerHTML =
    '<span class="fw-disc"></span><span class="fw-toggle-label">FLAT WORLD</span>';
  document.body.appendChild(toggle);
  return toggle;
}

/** Wait until the globe camera has stopped moving (e.g. a share link's restore flight). */
function whenCameraSettles(viewer, { maxMs = 9000, quietMs = 600 } = {}) {
  return new Promise((resolve) => {
    const start = performance.now();
    let last = viewer.camera.positionWC.clone();
    let quietSince = performance.now();
    const check = () => {
      const p = viewer.camera.positionWC;
      const moved = Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z);
      last = p.clone();
      const now = performance.now();
      if (moved > 0.5) quietSince = now;
      if (now - quietSince >= quietMs || now - start >= maxMs) resolve();
      else setTimeout(check, 150);
    };
    setTimeout(check, 150);
  });
}

export function mountFlatWorld({ viewer, dataManager }) {
  installStyles();
  const toggle = createToggle();
  let world = null;

  function build() {
    if (world) return world;
    const host = document.createElement('div');
    host.id = 'flatworld-root';
    viewer.container.insertAdjacentElement('afterend', host);

    const frame = createWorldFrame();
    const view = new FlatWorldView({ host, frame });
    const live = new LiveOverlay({ dataManager, frame });
    view.addLayer(live);
    const vectors = new VectorLines({ frame });
    view.addLayer(vectors);
    const ice = new IceEnvironment({ frame });
    view.addLayer(ice);
    const routes = new RouteLayer({ frame });
    view.addLayer(routes);
    const buildings = new BuildingsLayer({ frame });
    view.addLayer(buildings);
    view.addLayer(new SkyBodies({ frame }));
    const wall = new WallLayer({ frame });
    view.addLayer(wall);

    // Always-visible attribution for the data on screen (the globe's credit bar is hidden).
    const credits = document.createElement('div');
    credits.className = 'fw-credits';
    credits.innerHTML = attributionHtml();
    host.appendChild(credits);

    const mode = new FlatWorldMode({
      viewer,
      view,
      live,
      onChange: (active) => panel.setActive(active),
    });
    // Selection goes through the globe's own layers (shared Context, readout, voice).
    const selection = createLiveSelection({ viewer, live, mode });
    // The globe's cockpit, flown from the selected aircraft's seat in the flat world.
    const cockpit = createFlatCockpit({ viewer, view, live, mode });
    view.addLayer({ update: () => cockpit.update() });
    // Always-visible way out of the cockpit, back to the flat map (Esc does the same).
    const cockpitExit = document.createElement('button');
    cockpitExit.type = 'button';
    cockpitExit.className = 'fw-cockpit-exit';
    cockpitExit.textContent = '✕ EXIT COCKPIT';
    cockpitExit.addEventListener('click', () => cockpit.exit());
    document.body.appendChild(cockpitExit);
    mode.globeCameraHeld = () => cockpit.active();
    // The selected flight's route: the globe's great circle and the flat map's straight line.
    const flightPath = new FlightPath({ frame, live, selection });
    view.addLayer(flightPath);
    // Nearby sites and space missions: the globe's own markers, drawn through the projection.
    const globeMarkers = new GlobeEntityMirror({ viewer, frame, dataManager });
    view.addLayer(globeMarkers);
    // VISUAL PRESETS and cockpit vision modes, as filters on the flat canvas.
    const presets = createFlatPresets({ view, viewer });
    // Flat mode shows every tracked satellite (~11,500, Starlink included) at true height by
    // default: the layer is switched on, and the full catalogue applied whenever the layer is on
    // (also when it is switched on later, from any control) unless ALL SATELLITES was switched
    // off here. The globe's own catalogue and on/off state come back on exit.
    let globeSatCatalog = null;
    let satsTurnedOn = false;
    let layersTurnedOn = [];
    let satCheckAt = 0;
    function applySatelliteDefault() {
      if (!mode.active || !live.isLayerOn('satellites')) return;
      if (live.satelliteUserCatalog === 'core') return;
      const current = live.satelliteCatalog();
      if (!current || current === 'dense') return;
      globeSatCatalog ??= current;
      live.setSatelliteCatalog('dense');
    }
    view.addLayer({
      update: () => {
        const now = performance.now();
        if (now - satCheckAt < 1000) return;
        satCheckAt = now;
        applySatelliteDefault();
      },
    });
    mode.afterEnter = () => {
      selection.adoptGlobeTracking();
      live.satelliteUserCatalog = null;
      globeSatCatalog = null;
      satsTurnedOn = false;
      if (!live.isLayerOn('satellites')) {
        live.toggleLayer('satellites');
        satsTurnedOn = true;
      }
      // Live aircraft are on in the flat world (the cockpit needs both flight layers); a fresh
      // browser starts the globe with them off. Restored on exit.
      layersTurnedOn = ['flights', 'military'].filter(
        (k) => !live.isLayerOn(k),
      );
      for (const k of layersTurnedOn) live.toggleLayer(k);
      applySatelliteDefault();
    };
    mode.beforeExit = () => {
      cockpit.beforeExit();
      selection.beforeExit();
      if (globeSatCatalog && live.satelliteCatalog() === 'dense')
        live.setSatelliteCatalog(globeSatCatalog);
      if (satsTurnedOn && live.isLayerOn('satellites'))
        live.toggleLayer('satellites');
      for (const k of layersTurnedOn)
        if (live.isLayerOn(k)) live.toggleLayer(k);
      layersTurnedOn = [];
      globeSatCatalog = null;
      satsTurnedOn = false;
    };
    // Names, hover and click targets for every live object, and the selected object's card.
    const labels = new LiveLabels({
      live,
      describe: selection.describe,
      onClose: () => selection.deselect(),
      actions: (rec) => {
        const list = [
          {
            label: 'FLY TO',
            title:
              'Fly the camera to it and stop there (FOLLOW keeps the camera on it)',
            onClick: () => {
              const r = live._find(rec.kind, rec.id) || rec;
              const w = frame.geodeticToWorld(r.lat, r.lon);
              if (!w) return;
              live.releaseFollow();
              view.lookAtPlane({
                x: w.x,
                y: w.y,
                range: Math.max(
                  r.altitudeM * view.chunks.exaggeration * 3,
                  6000,
                ),
                pitch: 0.6,
                animate: true,
              });
            },
          },
        ];
        if (cockpit.isAircraft(rec)) {
          list.push({
            label: 'COCKPIT',
            title:
              "Sit in this aircraft's cockpit (the globe's cockpit, over the flat world)",
            onClick: () => {
              labels.setNote('Opening the cockpit…');
              cockpit
                .enter(rec)
                .then((res) =>
                  labels.setNote(
                    res.ok ? '' : res.error || 'The cockpit could not open',
                  ),
                );
            },
          });
          list.push({
            label: flightPath.enabled ? 'FLIGHT PATH: ON' : 'FLIGHT PATH: OFF',
            title:
              "Draw this flight's route: the globe's great circle and the flat map's straight line",
            onClick: () => flightPath.setEnabled(!flightPath.enabled),
          });
        }
        return list;
      },
    });
    view.addLayer(labels);
    view.addLayer({ update: () => selection.update() });
    // Moving the camera yourself stops following (it would otherwise snap back); the selection
    // and its card stay until you deselect.
    view.controls.onUserInput = () => live.releaseFollow();

    const panel = createPanel({
      view,
      mode,
      live,
      vectors,
      ice,
      routes,
      buildings,
      frame,
      attributions: allAttributions(),
      toggle,
      selection,
      labels,
      flightPath,
      globeMarkers,
      presets,
    });

    // Picking: a click selects the aircraft, ship or satellite nearest the cursor (every drawn
    // dot is a target, however small), adds a route point while measuring, or deselects when it
    // lands on empty ground — as on the globe.
    const raycaster = new THREE.Raycaster();
    const hitRadius = (e) => (e.pointerType === 'touch' ? 24 : 14);
    let down = null;
    view.canvas.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY };
    });
    view.canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4)
        return;
      if (cockpit.active()) return;
      if (routes.measuring) {
        const p = view.pick(e.clientX, e.clientY);
        if (p) routes.addPoint(p);
        return;
      }
      let rec = labels.nearest(e.clientX, e.clientY, hitRadius(e));
      if (!rec) {
        const rect = view.canvas.getBoundingClientRect();
        raycaster.setFromCamera(
          new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1,
          ),
          view.camera,
        );
        rec = live.pick(raycaster);
      }
      if (rec) {
        selection.select(rec);
        panel.showTracked(rec);
        return;
      }
      const marker = globeMarkers.nearest(e.clientX, e.clientY, hitRadius(e));
      if (marker) {
        if (live.tracked) selection.deselect();
        globeMarkers.select(marker);
      } else if (live.tracked) selection.deselect();
    });
    let hoverPending = false;
    view.canvas.addEventListener('pointermove', (e) => {
      if (hoverPending) return;
      hoverPending = true;
      requestAnimationFrame(() => {
        hoverPending = false;
        const rec =
          e.buttons === 0 && !routes.measuring
            ? labels.nearest(e.clientX, e.clientY, hitRadius(e))
            : null;
        labels.setHover(rec);
        view.canvas.style.cursor = rec ? 'pointer' : '';
        panel.showCursor(view.pick(e.clientX, e.clientY));
      });
    });
    view.canvas.addEventListener('pointerleave', () => labels.setHover(null));
    // Esc deselects (the globe's own layers also clear their tracking on Esc).
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && cockpit.active()) {
        cockpit.exit();
        return;
      }
      if (
        e.key === 'Escape' &&
        mode.active &&
        live.tracked &&
        !cockpit.active()
      )
        selection.deselect();
    });

    installLiveExtras({ live, panel, host });
    world = {
      view,
      mode,
      live,
      labels,
      selection,
      vectors,
      ice,
      routes,
      buildings,
      wall,
      frame,
      panel,
      cockpit,
      flightPath,
      globeMarkers,
      presets,
    };
    Object.assign(api, world, {
      diagnostics: () => view.diagnostics(),
      verifyLive: () => live.verify(),
    });
    return world;
  }

  const api = {
    // Placeholder until the world is built on first use (replaced by the real mode).
    mode: { active: false },
    enter: () => build().mode.enter(),
    exit: () => world?.mode.exit(),
    toggle: () => build().mode.toggle(),
    domains: { DOMAIN_GPS, DOMAIN_ICE },
    get built() {
      return Boolean(world);
    },
  };
  toggle.addEventListener('click', () => api.toggle());
  window.__flatWorld = api;

  // Deep link ?fw=1: consume the parameter (so later share links don't carry it) and open the
  // flat world once any shared-view camera restore has finished.
  const params = new URLSearchParams(location.search);
  if (params.get('fw') === '1') {
    params.delete('fw');
    const search = params.toString();
    history.replaceState(
      history.state,
      '',
      `${location.pathname}${search ? `?${search}` : ''}${location.hash}`,
    );
    whenCameraSettles(viewer).then(() => api.enter());
  }
  return api;
}
