/**
 * Flat World control panel: camera systems, sun and time, the hypothetical ice world, live layers,
 * routes and distortion, position readouts, bookmarks, data status and attribution.
 */
import { DOMAIN_GPS } from '../projection/domains.js';
import { headingToYaw } from '../render/controls.js';
import { ROUTE_PRESETS } from '../nav/routeLayer.js';

const BOOKMARK_KEY = 'gev.flatworld.bookmarks.v1';
const MAX_SEED = 2147483647;

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

/** East–west stretch of the projection, readable even where it grows without bound. */
export function fmtScale(k) {
  if (!Number.isFinite(k)) return '∞ (the South Pole is the whole rim)';
  if (k >= 1000)
    return `${Math.round(k).toLocaleString()}× — near the rim the map stretches without limit`;
  return `${k.toFixed(3)} (E–W stretch)`;
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
  toggle,
  selection,
  labels,
  flightPath = null,
  globeMarkers = null,
  presets = null,
}) {
  /** Smooth mode: satellites re-placed 10×/s and a lighter pixel ratio on high-DPI screens. */
  function applySmooth(on) {
    live.smooth = on;
    view.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, on ? 1.5 : 2),
    );
    view.resize();
  }
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
      {
        role: 'button',
        tabindex: '0',
        title: 'Show or hide',
        class: 'fw-section-title',
      },
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
    heading.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleSection();
      }
    });
    if (collapsed[id]) box.classList.add('collapsed');
    panel.appendChild(box);
    sections[id] = box;
    return box;
  };
  const button = (label, onclick, on = false) =>
    el(
      'button',
      { class: on ? 'fw-btn on' : 'fw-btn', type: 'button', onclick },
      label,
    );
  const rangeRow = (label, input, valueText) => {
    const value = el('span', {}, valueText);
    return {
      row: el('div', { class: 'fw-kv' }, el('b', {}, label), value),
      value,
      input,
    };
  };

  // Navigation buttons end tracking, so the camera goes where the user asked.
  const navigate = (fn) => () => {
    live.stopTracking();
    fn();
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
    modeButtons[id] = button(label, () => view.controls.setMode(id));
    modeRow.append(modeButtons[id]);
  }
  cam.append(
    modeRow,
    el(
      'div',
      { class: 'fw-row' },
      button(
        'WHOLE DISC',
        navigate(() => view.overview()),
      ),
      button(
        'NORTH POLE',
        navigate(() => goNorthPole()),
      ),
      button(
        'ICE FRONTIER →',
        navigate(() => goIceFrontier()),
      ),
    ),
    el(
      'div',
      { class: 'fw-note' },
      'Drag: pan · right-drag/shift: rotate · wheel: zoom · dbl-click: dive. Fly/Walk: WASD, Q/E, Shift, drag to look. While the flat world is shown, the globe’s keyboard shortcuts are paused.',
    ),
  );
  const exSlider = el('input', {
    type: 'range',
    min: '0',
    max: '100',
    value: '0',
  });
  const ex = rangeRow('Relief', exSlider, '1×');
  const exValue = (v) =>
    [1, 1.5, 2, 3, 5, 8, 12, 20, 35, 60, 100][Math.round((v / 100) * 10)];
  exSlider.addEventListener('input', () => {
    const e = exValue(Number(exSlider.value));
    ex.value.textContent = `${e}×`;
    view.chunks.setExaggeration(e, view.chunks.drain);
  });
  const drainBtn = button('DRAIN OCEANS', () => {
    const drain = view.chunks.drain ? 0 : 1;
    view.chunks.setExaggeration(view.chunks.exaggeration, drain);
    drainBtn.classList.toggle('on', Boolean(drain));
  });
  const distBtn = button('DISTORTION', () => {
    const u = view.chunks.material.uniforms.uDistortion;
    u.value = u.value ? 0 : 1;
    distBtn.classList.toggle('on', Boolean(u.value));
  });
  const domainBtn = button('SHOW DOMAINS', () => {
    const u = view.chunks.material.uniforms.uDomainTint;
    u.value = u.value ? 0 : 1;
    domainBtn.classList.toggle('on', Boolean(u.value));
  });
  const coastBtn = button(
    'COASTLINES',
    () => {
      vectors.showCoast = !vectors.showCoast;
      coastBtn.classList.toggle('on', vectors.showCoast);
    },
    true,
  );
  const gridBtn = button('GLEASON GRID', () => {
    vectors.showGrid = !vectors.showGrid;
    gridBtn.classList.toggle('on', vectors.showGrid);
  });
  const buildingsBtn = button(
    '3D BUILDINGS',
    () => {
      buildings.enabled = !buildings.enabled;
      buildingsBtn.classList.toggle('on', buildings.enabled);
    },
    buildings.enabled,
  );
  const farBtn = button(
    'FAR BUILDINGS',
    () => {
      buildings.far = !buildings.far;
      farBtn.classList.toggle('on', buildings.far);
    },
    buildings.far,
  );
  farBtn.title =
    'Tall and very large OpenStreetMap buildings (real heights) out to about 32 km, and from up to 80 km altitude';
  const bridgeBtn = button(
    'BRIDGES',
    () => {
      buildings.bridges = !buildings.bridges;
      bridgeBtn.classList.toggle('on', buildings.bridges);
    },
    buildings.bridges,
  );
  bridgeBtn.title =
    'Lift OpenStreetMap bridge decks 6 m per bridge layer above the ground or water (deck heights are estimated; the data has none)';
  const treesBtn = button(
    'TREES',
    () => {
      buildings.trees = !buildings.trees;
      treesBtn.classList.toggle('on', buildings.trees);
    },
    buildings.trees,
  );
  treesBtn.title =
    'Trees inside OpenStreetMap woods and parks within about 3.5 km. The areas are real; individual tree positions and sizes are generated.';
  cam.append(
    ex.row,
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
      farBtn,
      bridgeBtn,
      treesBtn,
    ),
  );

  // ---- Sun and time ----------------------------------------------------------------------
  const env = section('environment', 'SUN & TIME');
  const timeSlider = el('input', {
    type: 'range',
    min: '-720',
    max: '720',
    value: '0',
    step: '10',
  });
  const time = rangeRow('Sun time', timeSlider, 'live (real sun)');
  timeSlider.addEventListener('input', () => {
    const minutes = Number(timeSlider.value);
    view.time.offsetMinutes = minutes;
    time.value.textContent =
      minutes === 0
        ? 'live (real sun)'
        : `${minutes > 0 ? '+' : ''}${(minutes / 60).toFixed(1)} h from now`;
  });
  const iceSkyBtn = button('ICE: SOUTH-POLE SKY', () => {
    view.time.iceSky = view.time.iceSky === 'fixed' ? 'pole' : 'fixed';
    iceSkyBtn.textContent =
      view.time.iceSky === 'fixed'
        ? 'ICE: FIXED LOW SUN'
        : 'ICE: SOUTH-POLE SKY';
  });
  env.append(
    time.row,
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
  const iceInputs = {};
  const slider = (label, key, min, max, step, fmt = (v) => v) => {
    const input = el('input', {
      type: 'range',
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(iceParams[key]),
    });
    const r = rangeRow(label, input, String(fmt(iceParams[key])));
    input.addEventListener('input', () => {
      iceParams[key] = Number(input.value);
      r.value.textContent = String(fmt(iceParams[key]));
    });
    input.addEventListener('change', () => applyIce());
    iceInputs[key] = { input, value: r.value, fmt };
    iceBox.append(r.row, input);
  };
  const applyIce = () => {
    view.chunks.configure({ iceParams });
    ice.setIceParams(iceParams);
  };
  const seedInput = el('input', {
    type: 'number',
    min: '0',
    max: String(MAX_SEED),
    step: '1',
    value: String(iceParams.seed),
    style: 'width:110px',
  });
  seedInput.addEventListener('change', () => {
    // Seeds are 32-bit integers; anything else is clamped so two different inputs never
    // silently alias to the same world.
    const v = Math.floor(Number(seedInput.value));
    iceParams.seed = Number.isFinite(v)
      ? Math.min(Math.max(v, 0), MAX_SEED)
      : 0;
    seedInput.value = String(iceParams.seed);
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
  const weatherBtn = button(
    'POLAR WEATHER',
    () => {
      w.enabled = !w.enabled;
      weatherBtn.classList.toggle('on', w.enabled);
    },
    w.enabled,
  );
  const caveBtn = button(
    'ICE CAVES',
    () => {
      ice.cavesEnabled = !ice.cavesEnabled;
      caveBtn.classList.toggle('on', ice.cavesEnabled);
    },
    ice.cavesEnabled,
  );
  const weatherSlider = (label, key, min, max, step, fmt) => {
    const input = el('input', {
      type: 'range',
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(w[key]),
    });
    const r = rangeRow(label, input, fmt(w[key]));
    input.addEventListener('input', () => {
      w[key] = Number(input.value);
      r.value.textContent = fmt(w[key]);
    });
    return [r.row, input];
  };
  iceBox.append(
    el(
      'div',
      { class: 'fw-row' },
      weatherBtn,
      caveBtn,
      button(
        'FIND DRAMATIC TERRAIN',
        navigate(() => goVista()),
      ),
    ),
    ...weatherSlider(
      'Snowfall',
      'intensity',
      0,
      1,
      0.05,
      (v) => `${Math.round(v * 100)}%`,
    ),
    ...weatherSlider(
      'Whiteout',
      'whiteout',
      0,
      1,
      0.05,
      (v) => `${Math.round(v * 100)}%`,
    ),
    ...weatherSlider('Wind', 'windSpeed', 0, 40, 1, (v) => `${v} m/s`),
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
    layerButtons[kind] = button(label, () => {
      const turningOn = !live.isLayerOn(kind);
      live.toggleLayer(kind);
      // Satellites open with the full catalogue (all ~11,500, Starlink included), as asked.
      if (kind === 'satellites' && turningOn) live.setSatelliteCatalog('dense');
    });
    layerButtons[kind].dataset.label = label;
    layerRow.append(layerButtons[kind]);
  }
  const satGroundBtn = button('SATELLITES: TRUE HEIGHT', () => {
    live.satelliteGroundPoints = !live.satelliteGroundPoints;
    satGroundBtn.textContent = live.satelliteGroundPoints
      ? 'SATELLITES: GROUND POINT'
      : 'SATELLITES: TRUE HEIGHT';
  });
  const namesBtn = button(
    'NAMES',
    () => {
      labels.enabled = !labels.enabled;
      namesBtn.classList.toggle('on', labels.enabled);
    },
    true,
  );
  const allSatsBtn = button('ALL SATELLITES', () => {
    const next = live.satelliteCatalog() === 'dense' ? 'core' : 'dense';
    // Remembered so the flat world's all-satellites default does not switch it straight back.
    live.satelliteUserCatalog = next;
    live.setSatelliteCatalog(next);
  });
  allSatsBtn.title =
    'On: every tracked satellite including the Starlink shell (~11,500). Off: the ~830 main satellites (the globe default).';
  const layerStatus = el('div', { class: 'fw-note fw-warn' });
  const trackedBox = el('div', { class: 'fw-kv' });
  const flightPathBtn = button(
    'FLIGHT PATH',
    () => {
      flightPath?.setEnabled(!flightPath.enabled);
      flightPathBtn.classList.toggle('on', Boolean(flightPath?.enabled));
    },
    Boolean(flightPath?.enabled),
  );
  flightPathBtn.title =
    "Selected aircraft: draw its route between origin and destination airports, both ways — the globe's great circle (cyan) and the flat map's straight line (amber), each labelled with its length.";
  const flightPathNote = el('div', { class: 'fw-note' });
  const smoothBtn = button(
    'SMOOTH MODE',
    () => {
      applySmooth(!live.smooth);
      smoothBtn.classList.toggle('on', live.smooth);
    },
    true,
  );
  applySmooth(true);
  const satColoursBtn = button('SATELLITE CLASS COLOURS', () => {
    live.satelliteClassColours = !live.satelliteClassColours;
    satColoursBtn.classList.toggle('on', live.satelliteClassColours);
  });
  satColoursBtn.title =
    'Off (default): every satellite in the original pink. On: coloured by class (station, Starlink, navigation, weather, debris…) as on the globe.';
  smoothBtn.title =
    'On: satellites are re-placed 10 times a second and the picture uses a lighter pixel ratio on Retina screens, so the flat world stays smooth. Off: every frame, full sharpness.';
  const presetsBtn = button(
    'VISUAL PRESETS',
    () => {
      presets?.setEnabled(!presets.enabled);
      presetsBtn.classList.toggle('on', Boolean(presets?.enabled));
    },
    Boolean(presets?.enabled),
  );
  presetsBtn.title =
    'Apply the VISUAL PRESETS look (CRT, night vision, thermal, anime, noir, snow) and the cockpit vision modes to the flat world.';
  const intelHudBtn = button(
    'INTEL HUD',
    () => {
      document.body.classList.toggle('fw-intel-hud');
      intelHudBtn.classList.toggle(
        'on',
        document.body.classList.contains('fw-intel-hud'),
      );
    },
    true,
  );
  document.body.classList.add('fw-intel-hud');
  intelHudBtn.title =
    "Show the globe's intel HUD (time, position, MGRS, altitude) over the flat world; it reads the view centre.";
  const globeMarkersBtn = button(
    'SITES & MISSIONS',
    () => {
      globeMarkers?.setEnabled(!globeMarkers.enabled);
      globeMarkersBtn.classList.toggle('on', Boolean(globeMarkers?.enabled));
    },
    Boolean(globeMarkers?.enabled),
  );
  globeMarkersBtn.title =
    "Draw the globe's own markers here: nearby sites from Contacts (SEARCH NEARBY SITES) and the selected space mission's pad, trajectory and orbit. Click one to select it.";
  layers.append(
    layerRow,
    el('div', { class: 'fw-row' }, namesBtn, allSatsBtn),
    el('div', { class: 'fw-row' }, satGroundBtn),
    el('div', { class: 'fw-row' }, flightPathBtn, globeMarkersBtn),
    el('div', { class: 'fw-row' }, presetsBtn, intelHudBtn),
    el('div', { class: 'fw-row' }, smoothBtn, satColoursBtn),
    flightPathNote,
    layerStatus,
    el(
      'div',
      { class: 'fw-note' },
      'Click any aircraft, ship or satellite (any dot or name) to select it: its card opens and the camera follows it. Drag the map to stop following; Esc, ✕ or a click on empty ground deselects. Satellites are drawn at their real height; seen from far above, high orbits appear outside the disc by perspective.',
    ),
    trackedBox,
  );
  let trackedRec = null;
  live.onTrackingChange = (rec) => {
    trackedRec = rec;
    if (!rec) trackedBox.replaceChildren();
  };
  function renderTracked() {
    const fpText = flightPath?.enabled ? flightPath.status : '';
    if (flightPathNote.textContent !== fpText)
      flightPathNote.textContent = fpText;
    if (!trackedRec || !live.tracked) return;
    const r = trackedRec;
    const fix = r.fixes?.[r.fixes.length - 1];
    const ageS = r.lastFixMs
      ? Math.round((Date.now() - r.lastFixMs) / 1000)
      : null;
    kv(trackedBox, [
      [live.following ? 'Following' : 'Selected', r.label],
      [
        'Latest fix',
        fix ? `${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)}` : '—',
      ],
      [
        'Fix received',
        ageS === null ? '—' : `${ageS} s ago (${r.source || 'feed'})`,
      ],
      [
        'Drawn at',
        `${r.lat.toFixed(5)}, ${r.lon.toFixed(5)} (between real fixes)`,
      ],
      [
        r.kind === 'vessels' ? 'Height' : 'Altitude',
        `${Math.round(r.altitudeM)} m${r.onGround ? ' (on ground)' : ''}`,
      ],
      ['', button('DESELECT', () => selection.deselect())],
    ]);
  }

  // ---- Routes & distortion -------------------------------------------------------------------
  const routeBox = section('routes', 'ROUTES & DISTORTION');
  const measureBtn = button('MEASURE (CLICK 2 POINTS)', () => {
    routes.startMeasuring();
    measureBtn.classList.add('on');
  });
  const presetSel = el(
    'select',
    { class: 'fw-btn', 'aria-label': 'Preset route' },
    el('option', { value: '' }, 'Preset route…'),
  );
  ROUTE_PRESETS.forEach((r, i) =>
    presetSel.append(el('option', { value: String(i) }, r.name)),
  );
  presetSel.addEventListener('change', () => {
    const r = ROUTE_PRESETS[Number(presetSel.value)];
    if (!r) return;
    live.stopTracking();
    routes.measureGeodetic(r.a, r.b);
    view.overview();
    presetSel.value = '';
    presetSel.blur();
  });
  const tissotBtn = button('TISSOT CIRCLES', () => {
    routes.tissot.visible = !routes.tissot.visible;
    tissotBtn.classList.toggle('on', routes.tissot.visible);
  });
  const routeResult = el('div', { class: 'fw-kv' });
  routeBox.append(
    el(
      'div',
      { class: 'fw-row' },
      measureBtn,
      button('CLEAR', () => routes.clear()),
    ),
    el('div', { class: 'fw-row' }, presetSel, tissotBtn),
    routeResult,
    el(
      'div',
      { class: 'fw-note' },
      "Cyan: the real-world geodesic (shortest path on the Earth). Amber: the straight line on this flat map (shortest path across the disc). Pink circles: true 500 km circles; their stretching is the projection's distortion. DISTORTION colours the map by east–west stretch.",
    ),
  );
  routes.onResult = (r) => {
    measureBtn.classList.toggle('on', routes.measuring);
    if (!r) {
      routeResult.replaceChildren();
      return;
    }
    const rows = [];
    if (r.geodesic) {
      const pct = (r.comparison.flatOverGeodesic - 1) * 100;
      rows.push(
        ['Real (geodesic)', `${fmtDistance(r.geodesic.distanceM)} on Earth`],
        ['Flat-map line', `${fmtDistance(r.flat.distanceM)} on the map`],
        [
          'Flat − real',
          `${r.comparison.flatMinusGeodesicM >= 0 ? '+' : ''}${fmtDistance(r.comparison.flatMinusGeodesicM)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`,
        ],
        [
          'Flat line on Earth',
          `${fmtDistance(r.flatPathOnEarth.groundLengthM)} if travelled for real`,
        ],
        [
          'Geodesic drawn',
          r.geodesic.crossesSouthPole
            ? 'passes through the South Pole (the whole rim) — length on the map is undefined'
            : `${fmtDistance(r.geodesic.lengthOnMapM)} long on the map (curved)`,
        ],
        [
          'Start bearing',
          `${((r.geodesic.initialAzimuthDeg + 360) % 360).toFixed(1)}° from true north (real geodesic)`,
        ],
      );
    } else {
      rows.push(
        ['Flat-map line', fmtDistance(r.flat.distanceM)],
        ['Real (geodesic)', 'n/a — hypothetical ice'],
        ['', r.note],
      );
    }
    kv(routeResult, rows);
  };

  // ---- Position readout ------------------------------------------------------------------
  const readout = section('readout', 'POSITION');
  const focusBox = el('div', { class: 'fw-kv' });
  const cursorBox = el('div', { class: 'fw-kv' });
  readout.append(
    focusBox,
    el('div', { class: 'fw-subtitle' }, 'UNDER CURSOR'),
    cursorBox,
  );

  // ---- Bookmarks ---------------------------------------------------------------------------
  const marks = section('bookmarks', 'SAVED LOCATIONS');
  const markList = el('div', { class: 'fw-row' });
  marks.append(
    el(
      'div',
      { class: 'fw-row' },
      button('SAVE HERE', () => saveBookmark()),
      button(
        'RETURN TO LAST REAL PLACE',
        navigate(() => returnToLastReal()),
      ),
    ),
    markList,
  );

  // ---- Data status --------------------------------------------------------------------------
  const status = section('status', 'DATA STATUS');
  const statusBox = el('div', { class: 'fw-kv' });
  status.append(statusBox);

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

  function departToIce() {
    // Remember where the user was before heading into the hypothetical ice.
    const f = view.focus;
    if (f?.domain?.domain === DOMAIN_GPS && !view.controls.animation)
      lastReal = realMark(f);
  }

  function goVista() {
    departToIce();
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
    departToIce();
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

  /** The current camera as a bookmark, in whichever mode the user is in. */
  function cameraPose() {
    const c = view.controls;
    if (c.mode === 'orbit')
      return { mode: 'orbit', range: c.distance, pitch: c.pitch, yaw: c.yaw };
    const p = view.camera.position;
    return {
      mode: c.mode,
      eye: { x: p.x, y: -p.z, h: p.y / view.chunks.exaggeration },
      lookYaw: c.lookYaw,
      lookPitch: c.lookPitch,
    };
  }

  function realMark(f) {
    return {
      kind: 'gps',
      lat: f.domain.lat,
      lon: f.domain.lon,
      heading: f.heading,
      ...cameraPose(),
      name: fmtLatLon(f.domain.lat, f.domain.lon),
    };
  }

  function saveBookmark() {
    const f = view.getFocus();
    const mark =
      f.domain.domain === DOMAIN_GPS
        ? realMark(f)
        : {
            kind: 'ice',
            iceX: f.x,
            iceY: f.y,
            ...cameraPose(),
            // The ice is generated from these settings: keep them so the place is the same later.
            iceParams: { ...ice.field.params },
            name: `ICE ${(f.x / 1000).toFixed(0)}, ${(f.y / 1000).toFixed(0)} km`,
          };
    const list = loadMarks();
    list.push(mark);
    storeMarks(list);
    renderMarks();
  }

  function restorePose(m, x, y) {
    if (m.mode && m.mode !== 'orbit' && m.eye) {
      const c = view.controls;
      c.setMode('orbit');
      view.lookAtPlane({
        x,
        y,
        range: m.eye.h * 3 + 500,
        pitch: 0.3,
        animate: false,
      });
      c.setMode(m.mode);
      c.position.set(m.eye.x, m.eye.h * view.chunks.exaggeration, -m.eye.y);
      c.lookYaw = m.lookYaw;
      c.lookPitch = m.lookPitch;
      return;
    }
    const yaw =
      m.yaw ??
      (m.heading !== undefined ? headingToYaw(m.heading, x, y) : undefined);
    view.lookAtPlane({
      x,
      y,
      range: m.range ?? 20000,
      pitch: m.pitch ?? 0.6,
      yaw,
      animate: true,
    });
  }

  function goMark(m) {
    live.stopTracking();
    if (m.kind === 'gps') {
      const p = frame.geodeticToWorld(m.lat, m.lon);
      restorePose(m, p.x, p.y);
      return;
    }
    if (
      m.iceParams &&
      JSON.stringify(m.iceParams) !== JSON.stringify(ice.field.params)
    ) {
      Object.assign(iceParams, m.iceParams);
      seedInput.value = String(iceParams.seed);
      for (const [key, inp] of Object.entries(iceInputs)) {
        inp.input.value = String(iceParams[key]);
        inp.value.textContent = String(inp.fmt(iceParams[key]));
      }
      applyIce();
    }
    restorePose(m, m.iceX, m.iceY);
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
        .map((m) => button(m.name, () => goMark(m))),
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
        [
          'Elevation',
          Number.isFinite(d.height)
            ? `≈ ${Math.round(d.height)} m (rendered terrain)`
            : 'unknown (terrain not loaded)',
        ],
        ['From N. Pole', fmtDistance(Math.hypot(x, y))],
        ['Scale k', fmtScale(k)],
      ];
    }
    return [
      ['Domain', domainTag('ice')],
      [
        'Ice X / Y',
        `${(d.iceX / 1000).toFixed(3)}, ${(d.iceY / 1000).toFixed(3)} km`,
      ],
      ['Elevation', `≈ ${Math.round(d.z)} m (procedural)`],
      ['Beyond pole', fmtDistance(d.distanceBeyondPole)],
      ['Lat / Lon', 'none — not real geography'],
    ];
  }

  function renderStatus() {
    const s = view.chunks.stats;
    const fails = s.cache?.failuresBySource || {};
    const rows = [];
    const transient = s.cache?.transient || 0;
    rows.push([
      'Terrain chunks',
      `${view.chunks.chunks.size} loaded, ${view.chunks.pending.size} queued${s.incomplete ? `, ${s.incomplete} rebuilt after source outages` : ''}`,
    ]);
    if (transient)
      rows.push(['Tile errors', `${transient} temporary (retrying)`]);
    const missing = Object.entries(fails)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} ${n}`)
      .join(', ');
    if (missing)
      rows.push(['Missing tiles', `${missing} (coarser data shown)`]);
    const b = buildings.stats?.();
    if (b && buildings.enabled) {
      const failed = b.tilesFailed ?? 0;
      rows.push([
        'Buildings',
        `${b.tilesLoaded} tiles (${b.farTilesVisible ?? 0} far shown)${failed ? `, ${failed} failed (OpenFreeMap unreachable?)` : ''}`,
      ]);
    }
    kv(statusBox, rows);
    // Layer problems the user should see (e.g. ships without an AISStream key).
    const notes = [];
    for (const kind of ['flights', 'military', 'vessels', 'satellites']) {
      if (!live.isLayerOn(kind)) continue;
      const err = live.layerError?.(kind);
      if (err) notes.push(`${layerButtons[kind].dataset.label}: ${err}`);
    }
    layerStatus.textContent = notes.join(' · ');
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
      // Only settled real places count as "last real place" (not points passed in flight).
      if (f.domain.domain === DOMAIN_GPS && !view.controls.animation)
        lastReal = realMark(f);
      kv(focusBox, [
        ...describe(f.domain, f.x, f.y),
        ['Altitude', fmtDistance(f.altitude)],
        ['Heading', `${f.heading.toFixed(1)}°`],
      ]);
    }
    for (const [m, b] of Object.entries(modeButtons))
      b.classList.toggle('on', view.controls.mode === m);
    allSatsBtn.classList.toggle('on', live.satelliteCatalog() === 'dense');
    for (const [k, b] of Object.entries(layerButtons)) {
      b.classList.toggle('on', live.isLayerOn(k));
      const n = live.records[k]?.length;
      b.textContent = `${b.dataset.label}${n ? ` ${n}` : ''}`;
    }
    renderTracked();
    renderStatus();
  }
  requestAnimationFrame(tick);

  return {
    element: panel,
    toggle,
    section,
    sections,
    setActive(active) {
      toggle.querySelector('.fw-toggle-label').textContent = active
        ? 'BACK TO GLOBE'
        : 'FLAT WORLD';
      if (!active) trackedBox.replaceChildren();
    },
    showCursor(p) {
      kv(cursorBox, p ? describe(p.domain, p.x, p.y) : describe(null));
    },
    showTracked(rec) {
      trackedRec = rec;
      renderTracked();
    },
  };
}
