/**
 * Sky model switch for the flat world. One model is attached at a time:
 *
 * - `original`: the horizon sun and real day/night light of FlatWorldView (the owner's restored
 *   default since 27 October 2026); no extra sky layer.
 * - `spec`: the sun-and-moon model of research/sun-moon-spec.md (SkyBodies, with its coil /
 *   constant / Rowbotham heights and the celestial ring).
 * - `dome`: the TikTok video's model (DomeSky): 3,000-mile sun and moon, stars on a 3,100-mile
 *   dome, curved light rays.
 *
 * The choice is kept in localStorage and can be set with `?sky=original|spec|dome`.
 */
import { SkyBodies } from './skyBodies.js';
import { DomeSky } from './domeSky.js';
import { FlatCelestialRing } from '../overlays/celestialRingFlat.js';

export const SKY_MODELS = [
  { id: 'original', label: 'Original horizon sun (real sky)' },
  { id: 'spec', label: 'Sun & moon model (spec: coil heights)' },
  { id: 'dome', label: 'Dome model from the video (3,000 mi sun)' },
];
const KEY = 'gev.flatworld.skymodel.v1';

export function initialSkyModel(search = globalThis.location?.search ?? '') {
  const ids = SKY_MODELS.map((m) => m.id);
  const fromUrl = new URLSearchParams(search).get('sky');
  if (ids.includes(fromUrl)) return fromUrl;
  try {
    const saved = globalThis.localStorage?.getItem(KEY);
    if (ids.includes(saved)) return saved;
  } catch {
    /* private mode */
  }
  return 'original';
}

export class SkyModelSwitch {
  constructor({ view, frame }) {
    this.view = view;
    this.frame = frame;
    this.layers = [];
    this.id = null;
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  set(id) {
    if (!SKY_MODELS.some((m) => m.id === id) || id === this.id) return;
    for (const layer of this.layers) this.view.removeLayer(layer);
    this.layers = [];
    if (id === 'spec') {
      const sky = new SkyBodies({ frame: this.frame });
      this.layers.push(sky, new FlatCelestialRing({ frame: this.frame, sky }));
    } else if (id === 'dome') {
      this.layers.push(new DomeSky({ frame: this.frame }));
    }
    for (const layer of this.layers) this.view.addLayer(layer);
    this.id = id;
    try {
      globalThis.localStorage?.setItem(KEY, id);
    } catch {
      /* private mode */
    }
    for (const fn of this.listeners) fn(id);
  }
}
