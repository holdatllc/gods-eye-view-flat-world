const CSS = `
#flatworld-root { position: absolute; inset: 0; pointer-events: none; }
/* Only the 3D canvas takes the mouse; the names canvas on top of it must let wheel, drag and
   clicks through (it covered the whole view and swallowed scrolling). */
#flatworld-root canvas.flatworld-canvas { pointer-events: auto; }
#flatworld-root canvas.fw-live-labels { pointer-events: none; }
body.flatworld-active #flatworld-root { pointer-events: auto; }
body.flatworld-active:not(.fw-detection) #world-overlay-root,
body.flatworld-active:not(.fw-detection) #world-overlay-actions,
body.flatworld-active #orbit-indicator,
body.flatworld-active #cesium-credits,
body.flatworld-active #safe-frame-overlay,
body.flatworld-active #cockpit-cloud-effects,
body.flatworld-active #first-run-launcher,
body.flatworld-active:not(.fw-intel-hud) #intel-hud { display: none !important; }
/* The cockpit HUD shows in the flat world only while the cockpit is open (flown by flatCockpit.js). */
body.flatworld-active:not(.cockpit-mode) #cockpit-hud { display: none !important; }
body.flatworld-active.cockpit-mode .fw-panel,
body.flatworld-active.cockpit-mode .fw-card,
body.flatworld-active.cockpit-mode .fw-route-labels,
body.flatworld-active.cockpit-mode .fw-sky-panel,
body.flatworld-active.cockpit-mode .fw-sky-corner,
body.flatworld-active.cockpit-mode .fw-sky-cards,
body.flatworld-active.cockpit-mode .fw-wall-label,
body.flatworld-active.cockpit-mode .fw-credits { display: none !important; }
/* Globe markers mirrored into the flat world (nearby sites, space missions). */
.fw-globe-labels { position: absolute; left: 0; top: 0; pointer-events: none; z-index: 3; }
.fw-globe-labels[hidden], body:not(.flatworld-active) .fw-globe-labels, body.cockpit-mode .fw-globe-labels { display: none; }
.fw-globe-label { position: absolute; left: 0; top: 0; margin: -7px 0 0 9px; white-space: nowrap;
  font: 600 10px ui-monospace, 'SF Mono', Menlo, monospace; color: #fff; padding: 1px 5px; border-radius: 3px;
  background: rgba(4, 14, 20, 0.78); border-left: 2px solid var(--fw-accent, #ffb84d); }
/* Visual-preset overlays on the flat canvas (the filter itself is set on the canvas). */
.fw-preset-overlay { position: absolute; inset: 0; pointer-events: none; z-index: 1; }
body:not(.flatworld-active) .fw-preset-overlay { display: none; }
.fw-preset-overlay[data-look='scanlines'] { background: repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.22) 0 1px, transparent 1px 3px); }
.fw-preset-overlay[data-look='tube'] { background: radial-gradient(ellipse at center, transparent 55%, rgba(0, 0, 0, 0.85) 100%); }
.fw-preset-overlay[data-look='haze'] { background: radial-gradient(ellipse at center, rgba(255, 255, 255, 0.08), rgba(235, 245, 255, 0.28)); }
/* Exit from the cockpit in the flat world; BACK TO GLOBE also stays reachable. */
.fw-cockpit-exit { display: none; position: fixed; top: 18px; left: 50%; transform: translateX(-50%); z-index: 200;
  font: 700 12px ui-monospace, 'SF Mono', Menlo, monospace; letter-spacing: 0.12em; color: #fff; cursor: pointer;
  background: rgba(120, 20, 20, 0.85); border: 1px solid #ff8a8a; border-radius: 18px; padding: 8px 16px; }
body.flatworld-active.cockpit-mode .fw-cockpit-exit { display: block; }
body.flatworld-active.cockpit-mode .fw-toggle { display: flex; top: 60px; z-index: 200; }
/* Scope vignette over the flat canvas (same keyhole as the globe's #scope-mask). */
.fw-scope { position: absolute; left: 0; top: 0; pointer-events: none; z-index: 1; }
body:not(.flatworld-active) .fw-scope, body.cockpit-mode .fw-scope { display: none; }
/* The sky panel, its corner note and cards belong to the flat world only. */
body:not(.flatworld-active) .fw-sky-panel,
body:not(.flatworld-active) .fw-sky-corner,
body:not(.flatworld-active) .fw-sky-cards { display: none !important; }
/* Flight-path labels (great circle vs flat straight line). */
.fw-route-labels { position: absolute; left: 0; top: 0; pointer-events: none; z-index: 3; }
body:not(.flatworld-active) .fw-route-labels { display: none; }
.fw-route-label { position: absolute; left: 0; top: 0; white-space: nowrap; margin: -9px 0 0 8px;
  font: 600 10px ui-monospace, 'SF Mono', Menlo, monospace; letter-spacing: 0.06em; padding: 2px 6px; border-radius: 3px;
  background: rgba(4, 14, 20, 0.82); color: #fff; border: 1px solid rgba(255, 255, 255, 0.3); }
.fw-route-label.geo { color: #bff4ff; border-color: #39e1ff; }
.fw-route-label.flat { color: #ffe2a8; border-color: #ffc14d; }
.fw-card-actions { display: flex; flex-wrap: wrap; gap: 4px; }
.fw-card-note { margin-top: 5px; color: #ffcf7a; font-size: 10px; }
.fw-card-note[hidden] { display: none; }
/* Names of live objects (canvas) and the selected object's card. */
.fw-live-labels { position: absolute; left: 0; top: 0; pointer-events: none; }
body:not(.flatworld-active) .fw-live-labels, body:not(.flatworld-active) .fw-card { display: none; }
.fw-card { position: absolute; left: 0; top: 0; z-index: 4; min-width: 190px; max-width: 280px; pointer-events: auto;
  font: 11px/1.45 ui-monospace, 'SF Mono', Menlo, monospace; color: #d6f3fb; background: rgba(4, 14, 20, 0.9);
  border: 1px solid rgba(57, 225, 255, 0.35); border-left: 3px solid var(--fw-accent, #39e1ff); border-radius: 6px;
  padding: 7px 9px 8px; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45); }
.fw-card[hidden] { display: none; }
.fw-card-head { display: flex; align-items: flex-start; gap: 8px; }
.fw-card-title { flex: 1; font-weight: 700; color: #fff; letter-spacing: 0.05em; word-break: break-word; }
.fw-card-x { background: none; border: 0; color: #8fd8ea; cursor: pointer; font: inherit; padding: 0 2px; }
.fw-card-x:hover { color: #fff; }
.fw-card-line { white-space: pre-wrap; }
.fw-card-line.dim { color: #7fb6c6; font-size: 10px; }
.fw-card-actions { margin-top: 6px; }
.fw-card-follow { font: 600 10px ui-monospace, 'SF Mono', Menlo, monospace; letter-spacing: 0.08em; color: #bff4ff;
  background: rgba(57, 225, 255, 0.08); border: 1px solid rgba(57, 225, 255, 0.4); border-radius: 4px; padding: 3px 8px; cursor: pointer; }
.fw-card-follow:hover { border-color: #39e1ff; color: #fff; }
.fw-toggle { position: fixed; top: 102px; left: 50%; transform: translateX(-50%); z-index: 60;
  font: 600 11px ui-monospace, 'SF Mono', Menlo, monospace; letter-spacing: 0.14em; color: #bff4ff;
  background: rgba(6, 18, 26, 0.82); border: 1px solid rgba(57, 225, 255, 0.5); border-radius: 18px;
  padding: 7px 14px 7px 10px; cursor: pointer; display: flex; align-items: center; gap: 8px; backdrop-filter: blur(6px); }
.fw-toggle:hover { border-color: #39e1ff; color: #fff; }
/* Upstream chrome-free modes (clean view, recordings, cockpit) hide the flat-world button too. */
body.ui-clean-view .fw-toggle, body.recording-mode .fw-toggle, body.cockpit-mode .fw-toggle { display: none; }
/* CLEAN UI (v) in the flat world: the flat panel, sky panel and cards, credits and the globe's
   side panels go too, as on the globe. */
body.flatworld-active.ui-clean-view .fw-panel,
body.flatworld-active.ui-clean-view .fw-sky-panel,
body.flatworld-active.ui-clean-view .fw-sky-corner,
body.flatworld-active.ui-clean-view .fw-sky-cards,
body.flatworld-active.ui-clean-view .fw-credits,
body.flatworld-active.ui-clean-view #left-panel-stack { display: none !important; }
@media (max-width: 720px) {
  .fw-toggle { top: auto; bottom: 132px; left: 12px; transform: none; z-index: 70; }
  .fw-panel { width: calc(100vw - 28px); max-height: 45vh; top: auto; bottom: 180px; }
}
/* Globe-only controls that have no meaning in the flat world. */
body.flatworld-active #view-switcher { display: none !important; }
.fw-credits { position: absolute; right: 12px; bottom: 54px; max-width: min(520px, calc(100vw - 330px)); z-index: 2;
  font: 9px/1.35 ui-monospace, 'SF Mono', Menlo, monospace; color: #9fc3cf; background: rgba(4, 14, 20, 0.62);
  padding: 3px 7px; border-radius: 4px; pointer-events: auto; text-align: right; }
.fw-credits a { color: #bfe9f5; text-decoration: none; }
.fw-credits a:hover { text-decoration: underline; }
body:not(.flatworld-active) .fw-credits { display: none; }
.fw-subtitle { margin: 8px 0 3px; font-size: 10px; letter-spacing: 0.16em; color: #39e1ff; }
.fw-toggle .fw-disc { width: 16px; height: 16px; border-radius: 50%;
  background: radial-gradient(circle, #0c3f5c 0 30%, #2a8f6a 31% 55%, #e8f4ff 56% 100%); box-shadow: 0 0 6px #39e1ff88; }
.fw-panel { position: fixed; left: 14px; top: 96px; width: 286px; max-height: calc(100vh - 190px); overflow: auto; z-index: 55;
  font: 11px/1.45 ui-monospace, 'SF Mono', Menlo, monospace; color: #cfeef7; background: rgba(4, 14, 20, 0.86);
  border: 1px solid rgba(57, 225, 255, 0.35); border-radius: 10px; padding: 10px 12px; display: none; backdrop-filter: blur(8px); }
body.flatworld-active .fw-panel { display: block; }
/* The intel HUD's left corners (summary, MGRS) sit beside the flat panel, not under it. */
body.flatworld-active:not(.ui-clean-view) #intel-hud .hud-top-left,
body.flatworld-active:not(.ui-clean-view) #intel-hud .hud-bottom-left { transform: translateX(300px); }
body:not(.flatworld-active) .fw-celestial-ring { display: none; }
/* The detection surface lives in the hidden globe container; show it over the flat map. */
body.flatworld-active.fw-detection #world-overlay-detection-surface { visibility: visible; }
/* DATA LAYERS / SCENES stay usable in flat (GLOBE LAYERS); the flat panel sits beside them. */
body.flatworld-active:not(.fw-globe-panels) #left-panel-stack { display: none !important; }
body.flatworld-active.fw-globe-panels #left-panel-stack { left: 312px !important; right: auto !important; }
.fw-panel h3 { margin: 10px 0 5px; font-size: 10px; letter-spacing: 0.16em; color: #39e1ff; font-weight: 600; }
.fw-panel h3:first-child { margin-top: 0; }
.fw-panel h3.fw-section-title { cursor: pointer; user-select: none; }
.fw-panel h3.fw-section-title::after { content: ' ▾'; color: #4d8fa0; }
.fw-section.collapsed > h3::after { content: ' ▸'; }
.fw-section.collapsed > :not(h3) { display: none !important; }
.fw-row { display: flex; gap: 5px; flex-wrap: wrap; margin: 3px 0; }
.fw-btn { font: inherit; color: #cfeef7; background: rgba(57, 225, 255, 0.08); border: 1px solid rgba(57, 225, 255, 0.3);
  border-radius: 5px; padding: 4px 7px; cursor: pointer; }
.fw-btn:hover { border-color: #39e1ff; color: #fff; }
.fw-btn.on { background: rgba(57, 225, 255, 0.28); color: #fff; border-color: #39e1ff; }
.fw-btn.fw-sky-model { width: 100%; }
.fw-sky-model option { background: #0b1626; color: #cfeef7; }
.fw-kv { display: grid; grid-template-columns: 92px 1fr; gap: 1px 6px; }
.fw-kv b { color: #7fb8c8; font-weight: 400; }
.fw-tag { display: inline-block; padding: 0 5px; border-radius: 3px; font-weight: 700; letter-spacing: 0.08em; }
.fw-tag.gps { background: #0f5f3c; color: #b9ffd9; }
.fw-tag.ice { background: #23477a; color: #d6e8ff; }
.fw-panel input[type=range] { width: 100%; accent-color: #39e1ff; }
.fw-note { color: #84a8b4; font-size: 10px; }
.fw-attrib { color: #6f909b; font-size: 9px; margin-top: 8px; }
.fw-route-table td { padding: 1px 4px; }
.fw-warn { color: #ffcf6b; }
`;

export function installStyles() {
  if (document.getElementById('flatworld-styles')) return;
  const style = document.createElement('style');
  style.id = 'flatworld-styles';
  style.textContent = CSS;
  document.head.appendChild(style);
}
