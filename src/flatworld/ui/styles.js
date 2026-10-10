const CSS = `
#flatworld-root { position: absolute; inset: 0; pointer-events: none; }
#flatworld-root canvas { pointer-events: auto; }
body.flatworld-active #flatworld-root { pointer-events: auto; }
body.flatworld-active #world-overlay-root,
body.flatworld-active #world-overlay-actions,
body.flatworld-active #orbit-indicator,
body.flatworld-active #cesium-credits,
body.flatworld-active #safe-frame-overlay,
body.flatworld-active #cockpit-cloud-effects,
body.flatworld-active #first-run-launcher { display: none !important; }
.flatworld-labels { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.flatworld-label { position: absolute; left: 0; top: 0; font: 600 11px/1.3 ui-monospace, 'SF Mono', Menlo, monospace;
  color: #e9fbff; background: rgba(4, 16, 24, 0.78); border: 1px solid rgba(57, 225, 255, 0.55);
  padding: 3px 7px; border-radius: 4px; white-space: nowrap; letter-spacing: 0.04em; }
.flatworld-label span { display: block; font-weight: 400; color: #8fd8ea; font-size: 10px; }
.fw-toggle { position: fixed; top: 58px; left: 50%; transform: translateX(-50%); z-index: 60;
  font: 600 11px ui-monospace, 'SF Mono', Menlo, monospace; letter-spacing: 0.14em; color: #bff4ff;
  background: rgba(6, 18, 26, 0.82); border: 1px solid rgba(57, 225, 255, 0.5); border-radius: 18px;
  padding: 7px 14px 7px 10px; cursor: pointer; display: flex; align-items: center; gap: 8px; backdrop-filter: blur(6px); }
.fw-toggle:hover { border-color: #39e1ff; color: #fff; }
.fw-toggle .fw-disc { width: 16px; height: 16px; border-radius: 50%;
  background: radial-gradient(circle, #0c3f5c 0 30%, #2a8f6a 31% 55%, #e8f4ff 56% 100%); box-shadow: 0 0 6px #39e1ff88; }
.fw-panel { position: fixed; left: 14px; top: 96px; width: 286px; max-height: calc(100vh - 190px); overflow: auto; z-index: 55;
  font: 11px/1.45 ui-monospace, 'SF Mono', Menlo, monospace; color: #cfeef7; background: rgba(4, 14, 20, 0.86);
  border: 1px solid rgba(57, 225, 255, 0.35); border-radius: 10px; padding: 10px 12px; display: none; backdrop-filter: blur(8px); }
body.flatworld-active .fw-panel { display: block; }
body.flatworld-active #left-panel-stack { display: none !important; }
.fw-panel h3 { margin: 10px 0 5px; font-size: 10px; letter-spacing: 0.16em; color: #39e1ff; font-weight: 600; }
.fw-panel h3:first-child { margin-top: 0; }
.fw-row { display: flex; gap: 5px; flex-wrap: wrap; margin: 3px 0; }
.fw-btn { font: inherit; color: #cfeef7; background: rgba(57, 225, 255, 0.08); border: 1px solid rgba(57, 225, 255, 0.3);
  border-radius: 5px; padding: 4px 7px; cursor: pointer; }
.fw-btn:hover { border-color: #39e1ff; color: #fff; }
.fw-btn.on { background: rgba(57, 225, 255, 0.28); color: #fff; border-color: #39e1ff; }
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
