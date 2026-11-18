/**
 * Flat-world clicks handed to the globe's own click handlers.
 *
 * Globe layers (CCTV, bikeshare, transit, directions, radio, ...) select, open their cards and
 * fly the camera from Cesium LEFT_CLICK handlers that pick the globe scene. The globe is paused
 * and hidden in the flat world, so a click on a mirrored marker, or on the map while a globe
 * tool holds the pointer (DIRECTIONS "click map" for A/B, ...), is replayed on the hidden globe
 * canvas with the scene's pick answers pointed at what the flat world hit: the marker, and the
 * flat terrain's ground position. The camera moves the layers make are followed by the flat
 * world as before.
 */
import * as Cesium from 'cesium';

export function createGlobeClicks({ viewer }) {
  const scene = viewer.scene;

  /** Run `fn` with scene.pick/drillPick/pickPosition and the ground picks answering for us. */
  function withPicks(picked, ground, fn) {
    const saved = {
      pick: scene.pick,
      drillPick: scene.drillPick,
      pickPosition: scene.pickPosition,
      pickEllipsoid: viewer.camera.pickEllipsoid,
      globePick: scene.globe?.pick,
    };
    scene.pick = () => picked;
    scene.drillPick = () => (picked ? [picked] : []);
    scene.pickPosition = (pos, result) =>
      ground ? Cesium.Cartesian3.clone(ground, result) : undefined;
    viewer.camera.pickEllipsoid = (pos, ell, result) =>
      ground ? Cesium.Cartesian3.clone(ground, result) : undefined;
    if (scene.globe)
      scene.globe.pick = (ray, sc, result) =>
        ground ? Cesium.Cartesian3.clone(ground, result) : undefined;
    try {
      fn();
    } finally {
      scene.pick = saved.pick;
      scene.drillPick = saved.drillPick;
      scene.pickPosition = saved.pickPosition;
      viewer.camera.pickEllipsoid = saved.pickEllipsoid;
      if (scene.globe) scene.globe.pick = saved.globePick;
    }
  }

  /**
   * Replay a click at client (x, y) on the globe. `target` is the mirrored Cesium entity or
   * primitive (billboard/point) under it, or null; `geo` the flat ground point {lat, lon, height}.
   */
  function click(clientX, clientY, target, geo) {
    const canvas = scene.canvas;
    let picked;
    if (target instanceof Cesium.Entity)
      picked = { id: target, primitive: null };
    else if (target)
      picked = {
        primitive: target,
        id: target.id,
        collection:
          target._billboardCollection || target._pointPrimitiveCollection,
      };
    const ground = geo
      ? Cesium.Cartesian3.fromDegrees(geo.lon, geo.lat, geo.height || 0)
      : null;
    const init = {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    };
    withPicks(picked, ground, () => {
      canvas.dispatchEvent(
        new PointerEvent('pointerdown', { ...init, buttons: 1 }),
      );
      canvas.dispatchEvent(
        new PointerEvent('pointerup', { ...init, buttons: 0 }),
      );
    });
    return true;
  }

  return { click };
}
