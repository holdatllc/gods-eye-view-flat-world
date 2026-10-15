/**
 * The globe's cockpit, flown in the flat world.
 *
 * The cockpit (HUD, instruments, context window, PREVIOUS / NEXT) is the globe's own controller;
 * it normally runs from the hidden Cesium scene's preUpdate, which never fires while the flat
 * world is shown. This drives that controller once per flat frame and puts the flat camera in
 * the selected aircraft's seat: at its drawn position, looking along the cockpit's (slewed)
 * heading, so the same instruments read over the flat world.
 */
import * as THREE from 'three';
import { headingToYaw } from '../render/controls.js';
import { COCKPIT_VIEW_PITCH_DEG } from '../../ui/cockpitPresentation.js';

const AIRCRAFT = new Set(['flights', 'military']);
/** Eye point this far ahead of the drawn aircraft (metres, flat frame), so its own mesh is behind. */
const EYE_AHEAD_M = 40;
const UP = new THREE.Vector3(0, 1, 0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createFlatCockpit({ viewer, view, live, mode }) {
  const coordinator = () => viewer.gevCockpit ?? null;
  const controller = () => coordinator()?.cockpitView ?? null;
  let wasActive = false;
  const fwd = new THREE.Vector3();
  const eye = new THREE.Vector3();

  const active = () => Boolean(mode.active && controller()?.active);

  /** The aircraft the cockpit is in (NEXT / PREVIOUS can change it without a flat click). */
  function seatRecord() {
    const id = String(controller()?.trackedEntity?.gevTrackedId || '');
    const [kind, ...rest] = id.split(':');
    if (AIRCRAFT.has(kind) && rest.length) {
      const rec = live._find(kind, rest.join(':'));
      if (rec) return rec;
    }
    const t = live.tracked;
    return t ? live._find(t.kind, t.id) : null;
  }

  /**
   * Enter the cockpit of an aircraft. Contacts must be open for the cockpit (as on the globe),
   * so it is opened first when it is not.
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async function enter(rec) {
    if (!rec || !AIRCRAFT.has(rec.kind))
      return { ok: false, error: 'The cockpit is for aircraft only' };
    const c = coordinator();
    if (!c) return { ok: false, error: 'Cockpit unavailable' };
    const contacts = document.getElementById('global-context-flights-btn');
    if (contacts && contacts.getAttribute('aria-selected') !== 'true')
      contacts.click();
    let result = null;
    for (let i = 0; i < 20; i += 1) {
      result = c.controlCockpit('enter', {
        selectedTarget: { layerId: rec.kind, id: rec.id },
      });
      if (result?.ok) break;
      if (!/contacts/i.test(result?.error || '')) break;
      await sleep(200);
    }
    viewer.camera.cancelFlight?.();
    mode.markGlobeSynced?.();
    return { ok: Boolean(result?.ok), error: result?.error };
  }

  function exit() {
    const v = controller();
    if (v?.active) v.exit?.({ restoreTracking: true });
  }

  function onEnter() {
    const c = view.controls;
    c.animation = null;
    live.releaseFollow();
    c.setMode('fly');
    c.enabled = false;
  }

  function onExit() {
    const c = view.controls;
    c.enabled = mode.active;
    c.setMode('orbit');
    mode.markGlobeSynced?.();
    if (live.tracked) live.follow();
  }

  /** Per flat frame. */
  function update() {
    const v = controller();
    if (!mode.active || !v) return;
    // The globe's preUpdate does not run while the flat world is shown: run the cockpit's frame
    // (entry chip, HUD, context window, and its hidden-globe camera) from here instead.
    try {
      v.update();
    } catch (error) {
      console.warn('[FlatWorld] cockpit update failed', error);
    }
    const on = Boolean(v.active);
    if (on !== wasActive) {
      wasActive = on;
      if (on) onEnter();
      else onExit();
    }
    if (!on) return;
    // The cockpit moves the hidden globe camera every frame; that is not a navigation request.
    mode.markGlobeSynced?.();
    const rec = seatRecord();
    if (!rec?.drawn || !rec.world) return;
    const heading = Number.isFinite(v.heading) ? v.heading : rec.heading || 0;
    const yaw = headingToYaw(heading, rec.world.x, rec.world.y);
    const pitch = (COCKPIT_VIEW_PITCH_DEG * Math.PI) / 180;
    const cp = Math.cos(pitch);
    fwd.set(Math.cos(yaw) * cp, Math.sin(pitch), -Math.sin(yaw) * cp);
    eye.copy(rec.drawn).addScaledVector(fwd, EYE_AHEAD_M);
    const c = view.controls;
    c.position.copy(eye);
    c.lookYaw = yaw;
    c.lookPitch = pitch;
    const cam = view.camera;
    cam.position.copy(eye);
    cam.up.copy(UP);
    cam.lookAt(eye.clone().add(fwd));
    cam.updateMatrixWorld();
  }

  /** Leaving the flat world while in the cockpit: leave the cockpit first. */
  function beforeExit() {
    if (active()) exit();
    if (wasActive) {
      wasActive = false;
      view.controls.setMode('orbit');
    }
  }

  return {
    enter,
    exit,
    update,
    active,
    beforeExit,
    isAircraft: (rec) => AIRCRAFT.has(rec?.kind),
  };
}
