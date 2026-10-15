/**
 * Flat-world projection hook for globe screen overlays (annotations and the like).
 *
 * While the flat world is shown the Cesium globe is paused, so overlays that re-project on the
 * globe's postRender would freeze where the hidden camera last was. The flat world registers a
 * projector here (`projectGeodetic(lon, lat, height) -> {x, y} | null`, CSS pixels) and calls
 * `tickFlatFrame()` once per flat frame; overlays use the projector when one is set and redraw
 * on the tick.
 */
let projector = null;
const listeners = new Set();

export function setFlatProjector(next) {
  projector = next || null;
  for (const fn of listeners) fn(true);
}

export function getFlatProjector() {
  return projector;
}

/** Subscribe to flat frames; returns an unsubscribe function. */
export function onFlatFrame(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function tickFlatFrame() {
  if (!projector) return;
  for (const fn of listeners) {
    try {
      fn(false);
    } catch (error) {
      console.warn('[FlatWorld] overlay frame failed', error);
    }
  }
}

// Flat world: the view a share link should carry ({lat, lon, alt, heading, pitch} of an
// equivalent globe camera) while the flat world is shown, or null.
let shareView = null;

export function setFlatShareView(fn) {
  shareView = typeof fn === 'function' ? fn : null;
}

export function getFlatShareView() {
  try {
    return shareView?.() ?? null;
  } catch {
    return null;
  }
}
