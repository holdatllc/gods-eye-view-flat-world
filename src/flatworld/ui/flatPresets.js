/**
 * The globe's visual presets (VISUAL PRESETS dock, and the cockpit's vision modes) applied to
 * the flat world.
 *
 * On the globe each preset is a Cesium post-process stage; the flat world is a separate WebGL
 * canvas, so here each preset is an equivalent CSS filter on that canvas plus, for the sensor
 * looks, a scanline or tube-vignette overlay. Follows the app's own `gev:style-change` and
 * `gev:vision-change` events, so picking a preset anywhere applies it here too.
 */

/** CSS look for each globe style id. */
export const FLAT_PRESETS = {
  normal: { filter: '' },
  retro: {
    filter:
      'grayscale(1) sepia(1) hue-rotate(55deg) saturate(3.2) contrast(1.25) brightness(0.95)',
    overlay: 'scanlines',
  },
  surveillance: {
    filter:
      'grayscale(1) brightness(1.35) contrast(1.35) sepia(1) hue-rotate(65deg) saturate(4.5)',
    overlay: 'tube',
  },
  nvg: {
    filter:
      'grayscale(1) brightness(1.35) contrast(1.35) sepia(1) hue-rotate(65deg) saturate(4.5)',
    overlay: 'tube',
  },
  // White-hot base; the globe's FLIR sliders refine it (see thermalFilter).
  thermal: {
    filter: 'grayscale(1) brightness(1.55) contrast(1.6)',
    overlay: 'scanlines',
  },
  anime: { filter: 'saturate(1.9) contrast(1.15) brightness(1.06)' },
  noir: { filter: 'grayscale(1) contrast(1.65) brightness(0.9)' },
  snow: {
    filter: 'saturate(0.35) brightness(1.22) contrast(0.88) hue-rotate(-12deg)',
    overlay: 'haze',
  },
};

/**
 * FLIR look from the globe thermal stage's own sliders (Sensitivity, Bloom, WHOT/BHOT, Ironbow).
 * The flat map's photo is visible light, so heat is approximated by brightness: lifted and
 * contrasted so terrain reads like the globe's thermal view rather than near-black.
 */
export function thermalFilter(u = {}) {
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  const sens = num(u.sensitivity, 0.75);
  const glow = num(u.bloom, 0.65);
  const parts = [
    'grayscale(1)',
    // Gentle enough that the dark night-side photo is not stretched into bands.
    `brightness(${(1.1 + sens * 0.45 + glow * 0.1).toFixed(2)})`,
    `contrast(${(1.05 + sens * 0.35).toFixed(2)})`,
  ];
  if (num(u.mode, 0) >= 0.5) parts.push('invert(1)');
  if (num(u.palette, 0) >= 0.5)
    parts.push('sepia(1)', 'saturate(5)', 'hue-rotate(-28deg)');
  return parts.join(' ');
}

/** Globe post-process stage by name (the thermal, sharpen and bloom stages), or null. */
function stageNamed(viewer, name) {
  const stages = viewer?.scene?.postProcessStages;
  if (!stages) return null;
  if (name === 'bloom') return stages.bloom || null;
  for (let i = 0; i < stages.length; i += 1) {
    const st = stages.get(i);
    if (st?.name === name) return st;
  }
  return null;
}

/**
 * SVG filters for the globe's SHARPEN, BLOOM and FLIR pixelation on the flat canvas: one filter
 * per quantised setting, created on first use. A new id per setting (rather than editing one
 * filter's attributes) is what makes WebKit re-render when a slider moves.
 */
function svgFilter(kind, level) {
  const id = `fw-${kind}-${level}`;
  if (document.getElementById(id)) return `url(#${id})`;
  let svg = document.getElementById('fw-post-filters');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'fw-post-filters';
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    document.body.appendChild(svg);
  }
  let body = '';
  if (kind === 'sharpen') {
    const a = level / 20; // 0.05 … 1.05
    body = `<feConvolveMatrix order="3" preserveAlpha="true"
      kernelMatrix="0 ${-a} 0 ${-a} ${1 + 4 * a} ${-a} 0 ${-a} 0"/>`;
  } else if (kind === 'bloom') {
    const slope = (0.6 + (level / 20) * 2.4).toFixed(2);
    body = `<feColorMatrix in="SourceGraphic" type="matrix" result="bright"
        values="1 0 0 0 -0.55  0 1 0 0 -0.55  0 0 1 0 -0.55  0 0 0 1 0"/>
      <feGaussianBlur in="bright" stdDeviation="7" result="glow"/>
      <feComponentTransfer in="glow" result="glowA">
        <feFuncR type="linear" slope="${slope}"/>
        <feFuncG type="linear" slope="${slope}"/>
        <feFuncB type="linear" slope="${slope}"/>
      </feComponentTransfer>
      <feBlend in="SourceGraphic" in2="glowA" mode="screen"/>`;
  } else if (kind === 'pixelate') {
    // Mosaic: sample one pixel per block, then grow it over the block.
    const p = level;
    body = `<feFlood x="${Math.floor(p / 2)}" y="${Math.floor(p / 2)}" width="1" height="1"/>
      <feComposite width="${p}" height="${p}"/>
      <feTile result="grid"/>
      <feComposite in="SourceGraphic" in2="grid" operator="in"/>
      <feMorphology operator="dilate" radius="${Math.floor(p / 2)}"/>`;
  }
  const f = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
  f.id = id;
  f.setAttribute('color-interpolation-filters', 'sRGB');
  f.setAttribute('x', '0');
  f.setAttribute('y', '0');
  f.setAttribute('width', '100%');
  f.setAttribute('height', '100%');
  f.innerHTML = body;
  svg.appendChild(f);
  return `url(#${id})`;
}

export function createFlatPresets({ view, viewer }) {
  const overlay = document.createElement('div');
  overlay.className = 'fw-preset-overlay';
  view.canvas.insertAdjacentElement('afterend', overlay);
  const state = { enabled: true, style: 'normal' };

  function apply() {
    const look =
      (state.enabled && FLAT_PRESETS[state.style]) || FLAT_PRESETS.normal;
    const parts = [];
    if (state.enabled && state.style === 'thermal') {
      const st = stageNamed(viewer, 'godsEyeView_thermal');
      parts.push(thermalFilter(st?.uniforms));
      // FLIR Pixelation (1 = none … 6): CSS-pixel blocks of that size.
      const px = Math.round(Number(st?.uniforms?.pixelation) || 1);
      if (px >= 2) parts.push(svgFilter('pixelate', Math.min(px, 12)));
    } else if (look.filter) parts.push(look.filter);
    // The globe's SHARPEN and BLOOM switches and intensities.
    const sharpen = stageNamed(viewer, 'godsEyeView_sharpen');
    if (state.enabled && sharpen?.enabled) {
      const a =
        Math.min(Math.max(Number(sharpen.uniforms?.amount) || 1, 0.1), 2.1) *
        0.5;
      parts.push(svgFilter('sharpen', Math.max(1, Math.round(a * 20))));
    }
    const bloom = stageNamed(viewer, 'bloom');
    if (state.enabled && bloom?.enabled) {
      const eased = Math.min(
        Math.max(
          ((Number(bloom.uniforms?.brightness) || -0.5) + 0.5) / 0.36,
          0,
        ),
        1,
      );
      parts.push(svgFilter('bloom', Math.round(eased * 20)));
    }
    const filter = parts.join(' ');
    if (view.canvas.style.filter !== filter) view.canvas.style.filter = filter;
    overlay.dataset.look = look.overlay || '';
  }
  // The globe's sliders and switches change stage uniforms without events: follow them.
  let lastKey = '';
  setInterval(() => {
    if (!document.body.classList.contains('flatworld-active')) return;
    const t = stageNamed(viewer, 'godsEyeView_thermal')?.uniforms;
    const sh = stageNamed(viewer, 'godsEyeView_sharpen');
    const bl = stageNamed(viewer, 'bloom');
    const key = JSON.stringify([
      state.style,
      t && [t.sensitivity, t.bloom, t.mode, t.palette, t.pixelation],
      sh && [sh.enabled, sh.uniforms?.amount],
      bl && [bl.enabled, bl.uniforms?.brightness],
    ]);
    if (key === lastKey) return;
    lastKey = key;
    apply();
  }, 400);

  function setStyle(style) {
    const id = { optical: 'normal', crt: 'retro' }[style] || style;
    state.style = FLAT_PRESETS[id] ? id : 'normal';
    apply();
  }

  // The map's preset, and the cockpit's vision mode (which overrides it while flying).
  window.addEventListener('gev:style-change', (e) => {
    if (!document.body.classList.contains('cockpit-mode'))
      setStyle(e.detail?.style);
  });
  window.addEventListener('gev:vision-change', (e) =>
    setStyle(e.detail?.style),
  );
  try {
    setStyle(viewer.gevCockpit?.activeStyle || 'normal');
  } catch {
    setStyle('normal');
  }

  return {
    get enabled() {
      return state.enabled;
    },
    get style() {
      return state.style;
    },
    setEnabled(on) {
      state.enabled = Boolean(on);
      apply();
    },
    setStyle,
    /**
     * Sensor looks see in the dark: FLIR reads heat, so the night side is lit fully; night
     * vision amplifies what light there is. Runs after the sun and sky set the night level.
     */
    update() {
      if (!state.enabled) return;
      const u = view.chunks?.material?.uniforms;
      if (!u?.uNightLevel) return;
      if (state.style === 'thermal') {
        u.uNightLevel.value = 1;
        if (u.uNightLights) u.uNightLights.value = 0;
      } else if (state.style === 'surveillance' || state.style === 'nvg')
        u.uNightLevel.value = Math.max(u.uNightLevel.value, 0.6);
    },
  };
}
