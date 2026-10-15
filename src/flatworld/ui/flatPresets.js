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
  thermal: {
    filter: 'grayscale(1) contrast(1.9) brightness(1.1)',
    overlay: 'scanlines',
  },
  anime: { filter: 'saturate(1.9) contrast(1.15) brightness(1.06)' },
  noir: { filter: 'grayscale(1) contrast(1.65) brightness(0.9)' },
  snow: {
    filter: 'saturate(0.35) brightness(1.22) contrast(0.88) hue-rotate(-12deg)',
    overlay: 'haze',
  },
};

export function createFlatPresets({ view, viewer }) {
  const overlay = document.createElement('div');
  overlay.className = 'fw-preset-overlay';
  view.canvas.insertAdjacentElement('afterend', overlay);
  const state = { enabled: true, style: 'normal' };

  function apply() {
    const look =
      (state.enabled && FLAT_PRESETS[state.style]) || FLAT_PRESETS.normal;
    view.canvas.style.filter = look.filter || '';
    overlay.dataset.look = look.overlay || '';
  }

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
  };
}
