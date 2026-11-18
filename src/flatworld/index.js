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
import {
  GlobeLayerMirror,
  installGlobeLayerControls,
} from './overlays/globeLayers.js';
import { WindFlow } from './overlays/windFlow.js';
import { OverlayBridge } from './overlays/overlayBridge.js';
import {
  setFlatShareView,
  getFlatDrawSink,
  isFlatReopenPending,
} from '../overlays/flatProjection.js';
import { installFlatToolbar } from './ui/flatToolbar.js';
import { createGlobeClicks } from './ui/globeClicks.js';
import { isPointerFree } from '../data/inputOwnership.js';
import { AircraftSprites } from './overlays/aircraftSprites.js';
import { AircraftModels } from './overlays/aircraftModels.js';
import { createFlatPresets } from './ui/flatPresets.js';
import { createFlatScope } from './ui/flatScope.js';

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

/** Point `dist` metres from (lat, lon) along `bearingDeg`, on a sphere. */
function destinationPoint(lat, lon, dist, bearingDeg) {
  const R = 6371008.8;
  const d = dist / R;
  const b = (bearingDeg * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(
    Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b),
  );
  const l2 =
    l1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(p1),
      Math.cos(d) - Math.sin(p1) * Math.sin(p2),
    );
  return {
    lat: (p2 * 180) / Math.PI,
    lon: (((l2 * 180) / Math.PI + 540) % 360) - 180,
  };
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
    // The globe's aircraft icons (white silhouettes, amber military, cyan selected).
    // Close in, the nearest planes as the globe's 3D model instead of icons.
    const planeModels = new AircraftModels({ live });
    view.addLayer(planeModels);
    const planeIcons = new AircraftSprites({ live });
    view.addLayer(planeIcons);
    const vectors = new VectorLines({ frame });
    view.addLayer(vectors);
    const ice = new IceEnvironment({ frame });
    view.addLayer(ice);
    const routes = new RouteLayer({ frame });
    view.addLayer(routes);
    const buildings = new BuildingsLayer({ frame });
    view.addLayer(buildings);
    // Use the original horizon sun and local day/night lighting from FlatWorldView.
    // The later model-height sun/moon layer can obscure that sunrise/sunset sky.
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
      onChange: (active) => {
        panel.setActive(active);
        overlayBridge.setActive(active);
      },
    });
    // Selection goes through the globe's own layers (shared Context, readout, voice).
    const selection = createLiveSelection({ viewer, live, mode });
    // The globe's cockpit, flown from the selected aircraft's seat in the flat world.
    const cockpit = createFlatCockpit({ viewer, view, live, mode });
    view.addLayer({ update: () => cockpit.update() });
    // Esc in the flat cockpit = EXIT COCKPIT (keeps following the plane). Capture phase on
    // window, ahead of the globe cockpit's own Esc, which drops the selection.
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || !cockpit.active()) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        cockpit.exit();
      },
      { capture: true },
    );
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
    // DATA LAYERS / SCENES (CCTV, cables, weather, quakes, ...): the globe layers' own drawing,
    // re-drawn through the projection.
    const globeLayers = new GlobeLayerMirror({ viewer, frame, dataManager });
    view.addLayer(globeLayers);
    // WIND: the globe's forecast grid, flowing through the projection.
    const windFlow = new WindFlow({ frame, dataManager });
    view.addLayer(windFlow);
    // Detection overlay and annotations, projected through the flat camera.
    const overlayBridge = new OverlayBridge({ frame, live });
    view.addLayer(overlayBridge);
    // VISUAL PRESETS and cockpit vision modes, as filters on the flat canvas.
    const presets = createFlatPresets({ view, viewer });
    view.addLayer({ update: () => presets.update() });
    // The globe's round scope vignette, following its SCOPE switch and feather.
    const scope = createFlatScope({ view, mode });
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
      for (const k of layersTurnedOn) live.setLayer(k, true);
      applySatelliteDefault();
    };
    mode.beforeExit = () => {
      cockpit.beforeExit();
      selection.beforeExit();
      // Put the globe's layers back exactly as they were. The switches run after the catalogue change has
      // settled, which could otherwise switch the satellite layer back on.
      const off = [...(satsTurnedOn ? ['satellites'] : []), ...layersTurnedOn];
      const catalog =
        globeSatCatalog && live.satelliteCatalog() === 'dense'
          ? live.setSatelliteCatalog(globeSatCatalog)
          : null;
      // CONTACTS switches its own layer set; close it first if the cockpit opened it.
      const closedContacts = cockpit.closeContactsWeOpened();
      Promise.resolve(catalog)
        .catch(() => {})
        .then(() => new Promise((r) => setTimeout(r, closedContacts ? 800 : 0)))
        .then(() => {
          for (const k of off) live.setLayer(k, false);
        });
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
    // The flight path's status (route found, or no route data) on the selected plane's card.
    let pathNote = '';
    view.addLayer({
      update: () => {
        const note =
          flightPath.enabled && cockpit.isAircraft(live.tracked)
            ? flightPath.status
            : '';
        // Keyed by the plane too, so the same note shows again on the next plane's card.
        const key = `${live.tracked?.id ?? ''}|${note}`;
        if (key !== pathNote) {
          pathNote = key;
          labels.setNote(note);
        }
      },
    });
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
      planeIcons,
      planeModels,
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
    // DISPLAY ▸ DRAW: map clicks become the draw tool's points (lat/lon from the flat terrain).
    const drawSink = () => {
      const sink = getFlatDrawSink();
      return sink?.active() ? sink : null;
    };
    const geoAt = (e) => {
      const p = view.pick(e.clientX, e.clientY);
      const d = p?.domain;
      return d?.domain === DOMAIN_GPS
        ? {
            lat: d.lat,
            lon: d.lon,
            height: Number.isFinite(d.height) ? d.height : 0,
          }
        : null;
    };
    view.controls.drawing = () => Boolean(drawSink());
    const globeClicks = createGlobeClicks({ viewer });
    view.canvas.addEventListener('dblclick', () => drawSink()?.finish());
    view.canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4)
        return;
      if (cockpit.active()) return;
      const sink = drawSink();
      if (sink) {
        const p = geoAt(e);
        if (p) sink.click(p);
        return;
      }
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
      const layerMarker = marker
        ? null
        : globeLayers.nearest(e.clientX, e.clientY, hitRadius(e));
      if (marker) {
        if (live.tracked) selection.deselect();
        globeMarkers.select(marker);
      } else if (layerMarker) {
        if (live.tracked) selection.deselect();
        // The globe layer's own click: its selection, card and camera move.
        globeClicks.click(e.clientX, e.clientY, layerMarker.entity, geoAt(e));
      } else if (!isPointerFree()) {
        // A globe tool holds the pointer (DIRECTIONS "click map", ...): give it the map point.
        globeClicks.click(e.clientX, e.clientY, null, geoAt(e));
      } else if (live.tracked) selection.deselect();
    });
    let hoverPending = false;
    view.canvas.addEventListener('pointermove', (e) => {
      if (hoverPending) return;
      hoverPending = true;
      requestAnimationFrame(() => {
        hoverPending = false;
        const sink = e.buttons === 0 ? drawSink() : null;
        if (sink) {
          sink.move(geoAt(e));
          globeLayers.timer = Math.max(globeLayers.timer, 0.9);
        }
        const rec =
          e.buttons === 0 && !routes.measuring
            ? labels.nearest(e.clientX, e.clientY, hitRadius(e))
            : null;
        labels.setHover(rec);
        const layerHit =
          !rec && e.buttons === 0
            ? globeLayers.hover(e.clientX, e.clientY)
            : null;
        if (rec) globeLayers.hover(-1e6, -1e6);
        view.canvas.style.cursor = rec || layerHit ? 'pointer' : '';
        panel.showCursor(view.pick(e.clientX, e.clientY));
      });
    });
    view.canvas.addEventListener('pointerleave', () => labels.setHover(null));
    // Esc deselects (the globe's own layers also clear their tracking on Esc).
    window.addEventListener('keydown', (e) => {
      if (
        e.key === 'Escape' &&
        mode.active &&
        live.tracked &&
        !cockpit.active()
      )
        selection.deselect();
    });

    // Share links copied here keep the flat view (as the equivalent globe camera) and reopen flat.
    setFlatShareView(() => {
      if (!mode.active) return null;
      const f = view.getFocus();
      if (f.domain?.domain !== DOMAIN_GPS) return null;
      const range =
        view.controls.mode === 'orbit'
          ? view.controls.distance
          : Math.max(f.altitude, 50);
      const pitch = Math.min(Math.max(f.pitchDeg, -90), -5);
      const p = (-pitch * Math.PI) / 180;
      const back = range * Math.cos(p);
      const eye = destinationPoint(
        f.domain.lat,
        f.domain.lon,
        back,
        f.heading + 180,
      );
      return {
        lat: eye.lat,
        lon: eye.lon,
        alt: f.ground / view.chunks.exaggeration + range * Math.sin(p),
        heading: f.heading,
        pitch,
      };
    });
    installFlatToolbar({ view, mode });
    installLiveExtras({ live, panel, host });
    installGlobeLayerControls({
      panel,
      mirror: globeLayers,
      wind: windFlow,
      overlay: overlayBridge,
    });
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
      globeLayers,
      windFlow,
      overlayBridge,
      presets,
      scope,
      planeIcons,
      planeModels,
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
  // A share link copied in the flat world carries fw=1 in its hash: reopen the flat world there.
  const hashFlat =
    new URLSearchParams(location.hash.slice(1)).get('fw') === '1';
  if ((hashFlat || isFlatReopenPending()) && params.get('fw') !== '1')
    whenCameraSettles(viewer).then(() => api.enter());
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
