/**
 * The globe's round "scope" vignette (DISPLAY → SCOPE) over the flat world.
 *
 * The globe paints its keyhole mask on a canvas inside the Cesium container, which is hidden
 * while the flat world is shown. This paints the same keyhole (same geometry, feather and
 * outside darkness, same SCOPE switch and FEATHER slider) above the flat canvas.
 */
import {
  getScopeMaskFeather,
  isScopeMaskEnabled,
  scopeMaskGeometry,
  getScopeTerminusAlpha,
} from '../../scopeMask.js';

export function createFlatScope({ view, mode }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'fw-scope';
  canvas.setAttribute('aria-hidden', 'true');
  view.canvas.insertAdjacentElement('afterend', canvas);
  let signature = '';

  function draw() {
    if (!mode.active) return;
    const w = view.canvas.clientWidth;
    const h = view.canvas.clientHeight;
    const on = isScopeMaskEnabled();
    const feather = getScopeMaskFeather();
    const sig = `${w}x${h}|${on}|${feather}|${getScopeTerminusAlpha()}`;
    if (sig === signature) return;
    signature = sig;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!on) return;
    const geo = scopeMaskGeometry(w, h, feather);
    if (!geo) return;
    const dark = `rgba(0, 0, 0, ${getScopeTerminusAlpha()})`;
    const inner = Math.min(geo.innerR, geo.outerR - 0.5);
    const g = ctx.createRadialGradient(
      geo.centerX,
      geo.centerY,
      inner,
      geo.centerX,
      geo.centerY,
      geo.outerR,
    );
    g.addColorStop(0, 'rgba(0, 0, 0, 0)');
    g.addColorStop(1, dark);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  // Cheap: repaints only when the size, SCOPE switch or feather changed.
  const timer = setInterval(draw, 250);
  window.addEventListener('resize', draw);
  return {
    draw,
    destroy() {
      clearInterval(timer);
      canvas.remove();
    },
  };
}
