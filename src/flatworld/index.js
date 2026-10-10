/**
 * Flat World mode for God's Eye View: a North-Pole-centred azimuthal-equidistant 3D world with a
 * deterministic procedural ice domain beyond the South-Pole circle.
 *
 * Mounted after the standalone application starts. It reads the existing viewer and data manager
 * and never modifies the globe's renderer, layers or sources.
 */
import * as THREE from 'three';
import { FlatWorldView } from './render/flatWorldView.js';
import { FlatWorldMode } from './ui/flatWorldMode.js';
import { LiveOverlay } from './overlays/liveOverlay.js';
import { VectorLines } from './overlays/vectorLines.js';
import { IceEnvironment } from './ice/iceEnvironment.js';
import { createWorldFrame, DOMAIN_GPS, DOMAIN_ICE } from './projection/domains.js';
import { allAttributions } from './sources/catalog.js';
import { installStyles } from './ui/styles.js';
import { createPanel } from './ui/panel.js';

export function mountFlatWorld({ viewer, dataManager }) {
  installStyles();
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

  const mode = new FlatWorldMode({
    viewer,
    view,
    onChange: (active) => panel.setActive(active),
  });

  const panel = createPanel({ view, mode, live, vectors, ice, frame, attributions: allAttributions() });

  // Picking: click selects a live object to track; hover reports the domain under the cursor.
  const raycaster = new THREE.Raycaster();
  let down = null;
  view.canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY };
  });
  view.canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
    const rect = view.canvas.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1),
      view.camera,
    );
    const rec = live.pick(raycaster);
    if (rec) {
      live.track(rec.kind, rec.id);
      panel.showTracked(rec);
      return;
    }
    const p = view.pick(e.clientX, e.clientY);
    panel.onGroundClick?.(p, e);
  });
  let hoverPending = false;
  view.canvas.addEventListener('pointermove', (e) => {
    if (hoverPending) return;
    hoverPending = true;
    requestAnimationFrame(() => {
      hoverPending = false;
      panel.showCursor(view.pick(e.clientX, e.clientY));
    });
  });

  const api = {
    view,
    mode,
    live,
    vectors,
    ice,
    frame,
    panel,
    enter: () => mode.enter(),
    exit: () => mode.exit(),
    toggle: () => mode.toggle(),
    diagnostics: () => view.diagnostics(),
    verifyLive: () => live.verify(),
    domains: { DOMAIN_GPS, DOMAIN_ICE },
  };
  window.__flatWorld = api;
  // Deep link: #...&fw=1 opens straight into the flat world.
  if (new URLSearchParams(location.search).get("fw") === "1") setTimeout(() => mode.enter(), 0);
  return api;
}
