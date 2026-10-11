/**
 * Flat World control panel: mode switch, camera systems, live layers, readouts and bookmarks.
 * Route measurement and environment controls register into the same panel (see nav/ and ice/).
 */
import { DOMAIN_GPS } from '../projection/domains.js';
import { headingToYaw } from '../render/controls.js';
import { ROUTE_PRESETS } from '../nav/routeLayer.js';

const BOOKMARK_KEY = 'gev.flatworld.bookmarks.v1';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

export function fmtDistance(m) {
  if (!Number.isFinite(m)) return '—';
  if (Math.abs(m) >= 1e5)
    return `${(m / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })} km`;
  if (Math.abs(m) >= 1000) return `${(m / 1000).toFixed(2)} km`;
  return `${m.toFixed(1)} m`;
}

export function fmtLatLon(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(5)}°${ns} ${Math.abs(lon).toFixed(5)}°${ew}`;
}

export function createPanel({
  view,
  mode,
  live,
  vectors,
  ice,
  routes,
  buildings,
  frame,
  attributions,
}) {
  const toggle = el(
    'button',
    {
      class: 'fw-toggle',
      type: 'button',
      title: 'Switch between the globe and the flat world',
      onclick: () => mode.toggle(),
    },
    el('span', { class: 'fw-disc' }),
    el('span', { class: 'fw-toggle-label' }, 'FLAT WORLD'),
  );
  document.body.appendChild(toggle);

  const panel = el('div', {
    class: 'fw-panel',
    role: 'region',
    'aria-label': 'Flat world controls',
  });
  document.body.appendChild(panel);
  const sections = {};
  const collapsedKey = 'gev.flatworld.collapsed.v1';
  let collapsed = {};
  try {
    collapsed = JSON.parse(
      localStorage.getItem(collapsedKey) || '{"ice":true,"environment":true}',
    );
  } catch {
    collapsed = { ice: true, environment: true };
  }
  const section = (id, title) => {
    const heading = el(
      'h3',
      { role: 'button', tabindex: '0', title: 'Show or hide' },
      title,
    );
    const box = el('div', { class: `fw-section fw-${id}` }, heading);
    const toggleSection = () => {
      box.classList.toggle('collapsed');
      collapsed[id] = box.classList.contains('collapsed');
      try {
        localStorage.setItem(collapsedKey, JSON.stringify(collapsed));
      } catch {
        /* private mode */
      }
    };
    heading.addEventListener('click', toggleSection);
    heading.addEventListener(
      'keydown',
      (e) => (e.key === 'Enter' || e.key === ' ') && toggleSection(),
    );
    if (collapsed[id]) box.classList.add('collapsed');
    panel.appendChild(box);
    sections[id] = box;
    return box;
  };

  // ---- Camera ------------------------------------------------------------------------------
  const cam = section('camera', 'CAMERA');
  const modeButtons = {};
  const modeRow = el('div', { class: 'fw-row' });
  for (const [id, label] of [
    ['orbit', 'ORBIT'],
    ['fly', 'FLY'],
    ['walk', 'WALK'],
  ]) {
    modeButtons[id] = el(
      'button',
      {
        class: 'fw-btn',
        type: 'button',
        onclick: () => view.controls.setMode(id),
      },
      label,
    );
    modeRow.append(modeButtons[id]);
  }
  cam.append(
    modeRow,
    el(
      'div',
      { class: 'fw-row' },
      el(
        'button',
        { class: 'fw-btn', type: 'button', onclick: () => view.overview() },
        'WHOLE DISC',
      ),
      el(
        'button',
        { class: 'fw-btn', type: 'button', onclick: () => goNorthPole() },
        'NORTH POLE',
      ),
      el(
        'button',
        { class: 'fw-btn', type: 'button', onclick: () => goIceFrontier() },
        'ICE FRONTIER →',
      ),
    ),
    el(
      'div',
      { class: 'fw-note' },
      'Drag: pan · right-drag/shift: rotate · wheel: zoom · dbl-click: dive. Fly/Walk: WASD, Q/E, shift, drag to look.',
    ),
  );
  const exLabel = el('span', {}, '1×');
  const exSlider = el('input', {
    type: 'range',
    min: '0',
    max: '100',
    value: '0',
  });
  const exValue = (v) =>
    [1, 1.5, 2, 3, 5, 8, 12, 20, 35, 60, 100][Math.round((v / 100) * 10)];
  exSlider.addEventListener('input', () => {
    const e = exValue(Number(exSlider.value));
    exLabel.textContent = `${e}×`;
    view.chunks.setExaggeration(e, view.chunks.drain);
  });
  const drainBtn = el(
    'button',
    { class: 'fw-btn', type: 'button' },
    'DRAIN OCEANS',
  );
  drainBtn.addEventListener('click', () => {
    const drain = view.chunks.drain ? 0 : 1;
    view.chunks.setExaggeration(view.chunks.exaggeration, drain);
    drainBtn.classList.toggle('on', Boolean(drain));
  });
  const distBtn = el(
    'button',
    { class: 'fw-btn', type: 'button' },
    'DISTORTION',
  );
  distBtn.addEventListener('click', () => {
    const u = view.chunks.material.uniforms.uDistortion;
    u.value = u.value ? 0 : 1;
    distBtn.classList.toggle('on', Boolean(u.value));
  });
  const domainBtn = el(
    'button',
    { class: 'fw-btn', type: 'button' },
    'SHOW DOMAINS',
  );
  domainBtn.addEventListener('click', () => {
    const u = view.chunks.material.uniforms.uDomainTint;
    u.value = u.value ? 0 : 1;
    domainBtn.classList.toggle('on', Boolean(u.value));
  });
  const coastBtn = el(
    'button',
    { class: 'fw-btn on', type: 'button' },
    'COASTLINES',
  );
  coastBtn.addEventListener('click', () => {
    vectors.showCoast = !vectors.showCoast;
    coastBtn.classList.toggle('on', vectors.showCoast);
  });
  const gridBtn = el(
    'button',
    { class: 'fw-btn', type: 'button' },
    'GLEASON GRID',
  );
  gridBtn.addEventListener('click', () => {
    vectors.showGrid = !vectors.showGrid;
    gridBtn.classList.toggle('on', vectors.showGrid);
  });
  const buildingsBtn = el(
    'button',
    { class: 'fw-btn on', type: 'button' },
    '3D BUILDINGS',
  );
  buildingsBtn.addEventListener('click', () => {
    buildings.enabled = !buildings.enabled;
    buildingsBtn.classList.toggle('on', buildings.enabled);
  });
  cam.append(
    el('div', { class: 'fw-kv' }, el('b', {}, 'Relief'), exLabel),
    exSlider,
    el(
      'div',
      { class: 'fw-row' },
      drainBtn,
      distBtn,
      domainBtn,
      coastBtn,
      gridBtn,
      buildingsBtn,
    ),
  );

  // ---- Sun and time ----------------------------------------------------------------------
  const env = section('environment', 'SUN & TIME');
  const timeLabel = el('span', {}, 'live');
  const timeSlider = el('input', {
    type: 'range',
    min: '-720',
    max: '720',
    value: '0',
    step: '10',
  });
  const applyTime = () => {
    const minutes = Number(timeSlider.value);
    view.time.offsetMinutes = minutes;
    timeLabel.textContent =
      minutes === 0
        ? 'live (real sun)'
        : `${minutes > 0 ? '+' : ''}${(minutes / 60).toFixed(1)} h from now`;
  };
  timeSlider.addEventListener('input', applyTime);
  const iceSkyBtn = el(
    'button',
    { class: 'fw-btn', type: 'button' },
    'ICE: SOUTH-POLE SKY',
  );
  iceSkyBtn.addEventListener('click', () => {
    view.time.iceSky = view.time.iceSky === 'fixed' ? 'pole' : 'fixed';
    iceSkyBtn.textContent =
      view.time.iceSky === 'fixed'
        ? 'ICE: FIXED LOW SUN'
        : 'ICE: SOUTH-POLE SKY';
  });
  env.append(
    el('div', { class: 'fw-kv' }, el('b', {}, 'Sun time'), timeLabel),
    timeSlider,
    el('div', { class: 'fw-row' }, iceSkyBtn),
    el(
      'div',
      { class: 'fw-note' },
      "Real-world terrain is lit by the true sun for the chosen time. The hypothetical ice shares the South Pole's sky, or a fixed low sun.",
    ),
  );

  // ---- Hypothetical ice world --------------------------------------------------------------
  const iceBox = section('ice', 'ICE WORLD (HYPOTHETICAL)');
  const iceParams = { ...ice.field.params };
  const slider = (label, key, min, max, step, fmt = (v) => v) => {
    const value = el('span', {}, String(fmt(iceParams[key])));
    const input = el('input', {
      type: 'range',
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(iceParams[key]),
    });
    input.addEventListener('input', () => {
      iceParams[key] = Number(input.value);
      value.textContent = String(fmt(iceParams[key]));
    });
    input.addEventListener('change', () => applyIce());
    iceBox.append(
      el('div', { class: 'fw-kv' }, el('b', {}, label), value),
      input,
    );
  };
  const applyIce = () => {
    view.chunks.configure({ iceParams });
    ice.setIceParams(iceParams);
  };
  const seedInput = el('input', {
    type: 'number',
    value: String(iceParams.seed),
    style: 'width:90px',
  });
  seedInput.addEventListener('change', () => {
    iceParams.seed = Math.floor(Number(seedInput.value) || 0);
    applyIce();
  });
  iceBox.append(
    el('div', { class: 'fw-kv' }, el('b', {}, 'World seed'), seedInput),
  );
  slider('Mountains', 'mountainAmplitudeM', 0, 7000, 100, (v) => `${v} m`);
  slider('Ranges', 'rangeCoverage', 0, 1, 0.05);
  slider('Glaciers', 'glacierAmount', 0, 1, 0.05);
  slider('Ice cliffs', 'cliffAmount', 0, 1, 0.05);
  slider('Crevasses', 'crevasseDensity', 0, 1, 0.05);
  slider('Snow fill', 'snowFill', 0, 1, 0.05);
  const w = ice.weather;
  const weatherBtn = el(
    'button',
    { class: 'fw-btn on', type: 'button' },
    'POLAR WEATHER',
  );
  weatherBtn.addEventListener('click', () => {
    w.enabled = !w.enabled;
    weatherBtn.classList.toggle('on', w.enabled);
  });
  const caveBtn = el(
    'button',
    { class: 'fw-btn on', type: 'button' },
    'ICE CAVES',
  );
  caveBtn.addEventListener('click', () => {
    ice.cavesEnabled = !ice.cavesEnabled;
    caveBtn.classList.toggle('on', ice.cavesEnabled);
  });
  const snowSlider = el('input', {
    type: 'range',
    min: '0',
    max: '1',
    step: '0.05',
    value: String(w.intensity),
  });
  snowSlider.addEventListener(
    'input',
    () => (w.intensity = Number(snowSlider.value)),
  );
  const whiteSlider = el('input', {
    type: 'range',
    min: '0',
    max: '1',
    step: '0.05',
    value: String(w.whiteout),
  });
  whiteSlider.addEventListener(
    'input',
    () => (w.whiteout = Number(whiteSlider.value)),
  );
  const windSlider = el('input', {
    type: 'range',
    min: '0',
    max: '40',
    step: '1',
    value: String(w.windSpeed),
  });
  windSlider.addEventListener(
    'input',
    () => (w.windSpeed = Number(windSlider.value)),
  );
  iceBox.append(
    el(
      'div',
      { class: 'fw-row' },
      weatherBtn,
      caveBtn,
      el(
        'button',
        { class: 'fw-btn', type: 'button', onclick: () => goVista() },
        'FIND DRAMATIC TERRAIN',
      ),
    ),
    el('div', { class: 'fw-kv' }, el('b', {}, 'Snowfall'), el('span', {}, '')),
    snowSlider,
    el('div', { class: 'fw-kv' }, el('b', {}, 'Whiteout'), el('span', {}, '')),
    whiteSlider,
    el('div', { class: 'fw-kv' }, el('b', {}, 'Wind m/s'), el('span', {}, '')),
    windSlider,
    el(
      'div',
      { class: 'fw-note' },
      'Everything beyond the South-Pole circle is generated from the seed. It has local X/Y only — no latitude or longitude.',
    ),
  );

  // ---- Live layers -------------------------------------------------------------------------
  const layers = section('live', 'LIVE DATA');
  const layerButtons = {};
  const layerRow = el('div', { class: 'fw-row' });
  for (const [kind, label] of [
    ['flights', 'FLIGHTS'],
    ['military', 'MILITARY'],
    ['vessels', 'SHIPS'],
    ['satellites', 'SATELLITES'],
  ]) {
    layerButtons[kind] = el(
      'button',
      {
        class: 'fw-btn',
        type: 'button',
        onclick: () => live.toggleLayer(kind),
      },
      label,
    );
    layerRow.append(layerButtons[kind]);
  }
  const trackedBox = el('div', { class: 'fw-kv' });
  layers.append(
    layerRow,
    el(
      'div',
      { class: 'fw-note' },
      'Click an aircraft, ship or satellite to track it.',
    ),
    trackedBox,
  );

  // ---- Routes & distortion -------------------------------------------------------------------
  const routeBox = section('routes', 'ROUTES & DISTORTION');
  const measureBtn = el(
    'button',
    { class: 'fw-btn', type: 'button' },
    'MEASURE (CLICK 2 POINTS)',
  );
  measureBtn.addEventListener('click', () => {
    routes.startMeasuring();
    measureBtn.classList.add('on');
  });
  const presetSel = el(
    'select',
    { class: 'fw-btn' },
    el('option', { value: '' }, 'Preset route…'),
  );
  ROUTE_PRESETS.forEach((r, i) =>
    presetSel.append(el('option', { value: String(i) }, r.name)),
  );
  presetSel.addEventListener('change', () => {
    const r = ROUTE_PRESETS[Number(presetSel.value)];
    if (!r) return;
    routes.measureGeodetic(r.a, r.b);
    view.overview();
  });
  const tissotBtn = el(
    'button',
    { class: 'fw-btn', type: 'button' },
    'TISSOT CIRCLES',
  );
  tissotBtn.addEventListener('click', () => {
    routes.tissot.visible = !routes.tissot.visible;
    tissotBtn.classList.toggle('on', routes.tissot.visible);
  });
  const routeResult = el('div', { class: 'fw-kv' });
  routeBox.append(
    el(
      'div',
      { class: 'fw-row' },
      measureBtn,
      el(
        'button',
        { class: 'fw-btn', type: 'button', onclick: () => routes.clear() },
        'CLEAR',
      ),
    ),
    el('div', { class: 'fw-row' }, presetSel, tissotBtn),
    routeResult,
    el(
      'div',
      { class: 'fw-note' },
      "Cyan: real-world geodesic (shortest path on the Earth). Amber: straight line on this flat map (shortest path across the disc). Pink circles: true 500 km circles; their stretching is the projection's distortion. DISTORTION colours the map by east–west stretch.",
    ),
  );
  routes.onResult = (r) => {
    measureBtn.classList.remove('on');
    if (!r) {
      routeResult.replaceChildren();
      return;
    }
    const rows = [];
    if (r.geodesic) {
      const pct = (r.comparison.flatOverGeodesic - 1) * 100;
      rows.push(
        ['Geodesic (real)', `${fmtDistance(r.geodesic.distanceM)}`],
        ['Flat straight', `${fmtDistance(r.flat.distanceM)} on map`],
        [
          'Difference',
          `${r.comparison.flatMinusGeodesicM >= 0 ? '+' : ''}${fmtDistance(r.comparison.flatMinusGeodesicM)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`,
        ],
        [
          'Flat line walked',
          `${fmtDistance(r.flatPathOnEarth.groundLengthM)} on Earth`,
        ],
        ['Geodesic on map', `${fmtDistance(r.geodesic.lengthOnMapM)} (curved)`],
        [
          'Initial bearing',
          `${((r.geodesic.initialAzimuthDeg + 360) % 360).toFixed(1)}°`,
        ],
      );
    } else {
      rows.push(
        ['Flat distance', fmtDistance(r.flat.distanceM)],
        ['Geodesic', 'n/a — hypothetical ice'],
        ['', r.note],
      );
    }
    kv(routeResult, rows);
  };

  // ---- Position readout ------------------------------------------------------------------
  const readout = section('readout', 'POSITION');
  const focusBox = el('div', { class: 'fw-kv' });
  const cursorBox = el('div', { class: 'fw-kv' });
  readout.append(focusBox, el('h3', {}, 'UNDER CURSOR'), cursorBox);

  // ---- Bookmarks ---------------------------------------------------------------------------
  const marks = section('bookmarks', 'SAVED LOCATIONS');
  const markList = el('div', { class: 'fw-row' });
  marks.append(
    el(
      'div',
      { class: 'fw-row' },
      el(
        'button',
        { class: 'fw-btn', type: 'button', onclick: () => saveBookmark() },
        'SAVE HERE',
      ),
      el(
        'button',
        { class: 'fw-btn', type: 'button', onclick: () => returnToLastReal() },
        'RETURN TO LAST REAL PLACE',
      ),
    ),
    markList,
  );

  const attrib = el(
    'div',
    { class: 'fw-attrib' },
    ...attributions.map((a) => el('div', {}, a)),
    el(
      'div',
      {},
      'Projection: north-polar azimuthal equidistant (WGS84), Gleason 1892 layout. Beyond the South-Pole circle the ice is procedurally generated and hypothetical.',
    ),
  );
  panel.appendChild(attrib);

  // ---- Behaviour ---------------------------------------------------------------------------
  function goNorthPole() {
    view.lookAtPlane({ x: 0, y: 0, range: 2.5e6, pitch: 1.2, animate: true });
  }

  function goVista() {
    const f = view.getFocus();
    let x = f.x;
    let y = f.y;
    if (frame.domainAt(x, y) !== 'ice') {
      const ang = Math.hypot(x, y) < 1 ? 0 : Math.atan2(y, x);
      x = Math.cos(ang) * (frame.boundaryRadius + 600000);
      y = Math.sin(ang) * (frame.boundaryRadius + 600000);
    }
    const v = ice.findVista(x, y);
    if (!v) return;
    view.lookAtPlane({
      x: v.target.x,
      y: v.target.y,
      range: 16000,
      pitch: 0.18,
      yaw: v.yaw,
      animate: true,
    });
  }

  function goIceFrontier() {
    const f = view.getFocus();
    let ang = Math.atan2(f.y, f.x);
    if (Math.hypot(f.x, f.y) < 1) ang = 0;
    const r = frame.boundaryRadius + 180000;
    view.lookAtPlane({
      x: Math.cos(ang) * r,
      y: Math.sin(ang) * r,
      range: 60000,
      pitch: 0.35,
      yaw: ang,
      animate: true,
    });
  }

  function loadMarks() {
    try {
      return JSON.parse(localStorage.getItem(BOOKMARK_KEY) || '[]');
    } catch {
      return [];
    }
  }
  function storeMarks(list) {
    try {
      localStorage.setItem(BOOKMARK_KEY, JSON.stringify(list.slice(-12)));
    } catch {
      /* private mode */
    }
  }
  let lastReal = null;
  function saveBookmark() {
    const f = view.getFocus();
    const c = view.controls;
    const mark =
      f.domain.domain === DOMAIN_GPS
        ? {
            kind: 'gps',
            lat: f.domain.lat,
            lon: f.domain.lon,
            range: c.distance,
            heading: f.heading,
            pitch: c.pitch,
            name: fmtLatLon(f.domain.lat, f.domain.lon),
          }
        : {
            kind: 'ice',
            iceX: f.x,
            iceY: f.y,
            range: c.distance,
            yaw: c.yaw,
            pitch: c.pitch,
            name: `ICE ${(f.x / 1000).toFixed(0)}, ${(f.y / 1000).toFixed(0)} km`,
          };
    const list = loadMarks();
    list.push(mark);
    storeMarks(list);
    renderMarks();
  }
  function goMark(m) {
    if (m.kind === 'gps') {
      const w = frame.geodeticToWorld(m.lat, m.lon);
      view.lookAtPlane({
        x: w.x,
        y: w.y,
        range: m.range,
        pitch: m.pitch,
        yaw: headingToYaw(m.heading, w.x, w.y),
        animate: true,
      });
    } else {
      view.lookAtPlane({
        x: m.iceX,
        y: m.iceY,
        range: m.range,
        pitch: m.pitch,
        yaw: m.yaw,
        animate: true,
      });
    }
  }
  function returnToLastReal() {
    const list = loadMarks().filter((m) => m.kind === 'gps');
    const target = lastReal || list[list.length - 1];
    if (target) goMark(target);
    else view.overview();
  }
  function renderMarks() {
    markList.replaceChildren(
      ...loadMarks()
        .slice(-8)
        .reverse()
        .map((m) =>
          el(
            'button',
            { class: 'fw-btn', type: 'button', onclick: () => goMark(m) },
            m.name,
          ),
        ),
    );
  }
  renderMarks();

  function kv(box, rows) {
    box.replaceChildren(
      ...rows.flatMap(([k, v]) => [
        el('b', {}, k),
        typeof v === 'string' ? el('span', {}, v) : v,
      ]),
    );
  }

  function domainTag(d) {
    return el(
      'span',
      { class: `fw-tag ${d}` },
      d === DOMAIN_GPS ? 'REAL · GPS' : 'HYPOTHETICAL ICE',
    );
  }

  function describe(d, x, y) {
    if (!d) return [['—', 'no terrain under cursor']];
    if (d.domain === DOMAIN_GPS) {
      const k = frame.projection.scaleFactors(d.lat).k;
      return [
        ['Domain', domainTag('gps')],
        ['Lat / Lon', fmtLatLon(d.lat, d.lon)],
        ['Elevation', `${Math.round(d.height)} m`],
        ['From N. Pole', fmtDistance(Math.hypot(x, y))],
        ['Scale k', `${k.toFixed(3)} (E–W stretch)`],
      ];
    }
    return [
      ['Domain', domainTag('ice')],
      [
        'Ice X / Y',
        `${(d.iceX / 1000).toFixed(3)}, ${(d.iceY / 1000).toFixed(3)} km`,
      ],
      ['Elevation', `${Math.round(d.z)} m (procedural)`],
      ['Beyond pole', fmtDistance(d.distanceBeyondPole)],
      ['Lat / Lon', 'none — not real geography'],
    ];
  }

  let lastFocusUpdate = 0;
  function tick() {
    requestAnimationFrame(tick);
    if (!mode.active) return;
    const now = performance.now();
    if (now - lastFocusUpdate < 250) return;
    lastFocusUpdate = now;
    const f = view.focus;
    if (f) {
      if (f.domain.domain === DOMAIN_GPS)
        lastReal = {
          kind: 'gps',
          lat: f.domain.lat,
          lon: f.domain.lon,
          range: view.controls.distance,
          heading: f.heading,
          pitch: view.controls.pitch,
        };
      kv(focusBox, [
        ...describe(f.domain, f.x, f.y),
        ['Altitude', fmtDistance(f.altitude)],
        ['Heading', `${f.heading.toFixed(1)}°`],
      ]);
    }
    for (const [m, b] of Object.entries(modeButtons))
      b.classList.toggle('on', view.controls.mode === m);
    for (const [k, b] of Object.entries(layerButtons)) {
      b.classList.toggle('on', live.isLayerOn(k));
      b.textContent =
        `${b.textContent.split(' ')[0]} ${live.records[k]?.length ? live.records[k].length : ''}`.trim();
    }
  }
  requestAnimationFrame(tick);

  const api = {
    element: panel,
    toggle,
    section,
    sections,
    setActive(active) {
      toggle.querySelector('.fw-toggle-label').textContent = active
        ? 'BACK TO GLOBE'
        : 'FLAT WORLD';
    },
    showCursor(p) {
      kv(cursorBox, p ? describe(p.domain, p.x, p.y) : describe(null));
    },
    showTracked(rec) {
      kv(trackedBox, [
        ['Tracking', rec.label],
        ['Source', `${rec.lat.toFixed(5)}, ${rec.lon.toFixed(5)}`],
        ['Altitude', `${Math.round(rec.altitudeM)} m`],
        [
          '',
          el(
            'button',
            {
              class: 'fw-btn',
              type: 'button',
              onclick: () => {
                live.stopTracking();
                trackedBox.replaceChildren();
              },
            },
            'STOP TRACKING',
          ),
        ],
      ]);
    },
    onGroundClick: null,
  };
  return api;
}
