/**
 * The globe toolbar's TILT and NORTH-UP buttons in the flat world. They move the paused globe's
 * camera, which the flat world does not follow for orientation; while the flat world is shown
 * they turn the flat camera instead (capture phase, ahead of the globe's own handlers).
 */
export function installFlatToolbar({ view, mode }) {
  const orient = ({ headingDeg, pitchDeg }) => {
    const f = view.getFocus();
    if (f.domain?.domain !== 'gps') return;
    view.lookAtGeodetic({
      lat: f.domain.lat,
      lon: f.domain.lon,
      range:
        view.controls.mode === 'orbit'
          ? view.controls.distance
          : Math.max(f.altitude, 200),
      headingDeg: headingDeg ?? f.heading,
      pitchDeg: pitchDeg ?? f.pitchDeg,
      animate: true,
    });
  };
  const bind = (id, action) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener(
      'click',
      (e) => {
        if (!mode.active) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        action();
      },
      { capture: true },
    );
  };
  // Tilt: top-down ⇄ a 45° oblique view, as the globe's button does.
  bind('tilt-map-view', () => {
    const f = view.getFocus();
    orient({ pitchDeg: f.pitchDeg < -70 ? -45 : -90 });
  });
  bind('north-up-view', () => orient({ headingDeg: 0 }));
}
