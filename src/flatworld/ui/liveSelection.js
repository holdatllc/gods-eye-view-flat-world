/**
 * Selecting live objects in the flat world through the globe's own layers.
 *
 * A click in the flat world selects the object with the same layer call the globe uses
 * (`trackById` / `selectById`), so the app's shared selection — the Context panel, Contacts,
 * voice "the selected one" and the globe's readout card — follows the flat world, and leaving
 * the flat world while following an object keeps following it on the globe. Entering the flat
 * world while the globe follows an object picks it up here as well.
 */
import {
  satelliteClassColor,
  satelliteClassLabel,
} from '../../data/satelliteClass.js';

/** Globe tracked-entity id prefix (`gevTrackedId`) for each flat-world kind. */
const GLOBE_PREFIX = {
  flights: 'flights',
  military: 'military',
  satellites: 'satellites',
};
const ISS_NORAD = '25544';

function fmtAltitude(m) {
  if (!Number.isFinite(m)) return null;
  return Math.abs(m) >= 100000
    ? `${Math.round(m / 1000).toLocaleString('en-US')} km`
    : `${Math.round(m).toLocaleString('en-US')} m`;
}

export function createLiveSelection({ viewer, live, mode }) {
  const globeTracked = () => viewer.trackedEntity?.gevTrackedId || '';

  /** Whether the globe layer currently has this object selected. */
  function globeHas(kind, id) {
    if (kind === 'vessels') {
      try {
        return (
          String(live.layerModule(kind)?.getSelectedInfo?.()?.mmsi ?? '') ===
          String(id)
        );
      } catch {
        return false;
      }
    }
    const prefix = GLOBE_PREFIX[kind];
    return Boolean(prefix) && globeTracked() === `${prefix}:${id}`;
  }

  function globeSelect(rec) {
    const mod = live.layerModule(rec.kind);
    try {
      if (rec.kind === 'vessels') mod?.selectById?.(rec.id);
      else mod?.trackById?.(rec.id, { origin: 'user' });
    } catch (error) {
      console.warn('[FlatWorld] globe selection failed', error);
    }
    // Selecting must not move the flat world: the hidden globe camera is not a navigation
    // request here.
    viewer.camera.cancelFlight?.();
    mode.markGlobeSynced?.();
  }

  function globeRelease(kind, id) {
    if (!globeHas(kind, id)) return;
    const mod = live.layerModule(kind);
    try {
      if (kind === 'vessels') mod?.clearSelection?.();
      else mod?.stopTracking?.({ origin: 'user' });
    } catch (error) {
      console.warn('[FlatWorld] globe deselection failed', error);
    }
    mode.markGlobeSynced?.();
  }

  function select(rec) {
    if (!rec) return;
    live.track(rec.kind, rec.id);
    globeSelect(rec);
  }

  function deselect() {
    const t = live.tracked;
    if (!t) return;
    live.stopTracking();
    globeRelease(t.kind, t.id);
  }

  /**
   * Card text. Aircraft use the globe's own readout text (callsign, flight level, speed,
   * airline, type, route) when the globe layer has the same aircraft selected.
   */
  function describe(rec) {
    if (rec.kind === 'satellites') {
      const isIss = String(rec.id) === ISS_NORAD;
      return {
        title: rec.label,
        accent: rec.classColor || satelliteClassColor(rec.group),
        lines: [
          satelliteClassLabel(rec.group, { isIss }),
          [fmtAltitude(rec.altitudeM), `NORAD ${rec.id}`]
            .filter(Boolean)
            .join(' · '),
          Number.isFinite(rec.speedMps)
            ? `${(rec.speedMps / 1000).toFixed(2)} km/s`
            : null,
        ].filter(Boolean),
      };
    }
    const model = globeHas(rec.kind, rec.id)
      ? viewer.trackedEntity?.gevLabelModel
      : null;
    if (model?.title)
      return {
        title: model.title,
        lines: [...(model.details || [])],
        accent: model.accent,
      };
    const speedKt = Number.isFinite(rec.speedMps)
      ? `${Math.round(rec.speedMps * 1.943844)} kt`
      : null;
    const heading = Number.isFinite(rec.heading)
      ? `${Math.round(rec.heading)}°`
      : null;
    if (rec.kind === 'vessels')
      return {
        title: rec.label,
        lines: [
          `MMSI ${rec.id}`,
          [speedKt, heading].filter(Boolean).join(' · '),
        ].filter(Boolean),
      };
    return {
      title: rec.label,
      lines: [
        rec.onGround
          ? 'On the ground'
          : [fmtAltitude(rec.altitudeM), speedKt, heading]
              .filter(Boolean)
              .join(' · '),
        `ICAO ${String(rec.id).toUpperCase()}`,
      ].filter(Boolean),
    };
  }

  // Following the globe's selection into the flat world on entry.
  let adopt = null;
  function adoptGlobeTracking() {
    const [prefix, ...rest] = globeTracked().split(':');
    const kind = Object.keys(GLOBE_PREFIX).find(
      (k) => GLOBE_PREFIX[k] === prefix,
    );
    adopt = kind && rest.length ? { kind, id: rest.join(':'), since: Date.now() } : null;
  }
  /** Per-frame: start following the adopted object once its first fix has arrived. */
  function update() {
    if (!adopt) return;
    if (Date.now() - adopt.since > 15000) {
      adopt = null;
      return;
    }
    if (live._find(adopt.kind, adopt.id)) {
      live.track(adopt.kind, adopt.id);
      adopt = null;
    }
  }

  /**
   * Before leaving: an object still followed stays followed on the globe; a selection the user
   * stopped following is released so the globe camera does not jump to it.
   */
  function beforeExit() {
    adopt = null;
    const t = live.tracked;
    if (t && !live.following) globeRelease(t.kind, t.id);
  }

  return {
    select,
    deselect,
    describe,
    adoptGlobeTracking,
    beforeExit,
    update,
    globeHas,
  };
}
