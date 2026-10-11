# Flat World (north-polar azimuthal equidistant) mode

A second, separately rendered view of God's Eye View: the Earth laid out on a North-Pole-centred
azimuthal-equidistant disc in the layout of the 1892 Gleason map, in full 3D (terrain, bathymetry,
buildings, live aircraft and satellites), surrounded by an endless, deterministic, procedurally
generated ice world beyond the South-Pole circle.

This is a map projection, not a claim about the shape of the Earth. Every real position is placed by
a verified projection of its true WGS84 coordinates, every real distance can be compared with the
true geodesic, and everything beyond the South-Pole circle is labelled as hypothetical.

## Using it

- **FLAT WORLD** (top centre) switches from the globe; **BACK TO GLOBE** returns. Open straight into
  it with `?fw=1`.
- Camera: **ORBIT** (drag pan, right-drag/shift rotate, wheel zoom to cursor, double-click dive),
  **FLY** (WASD, Q/E, Shift, drag to look, wheel = speed), **WALK** (eye height 1.7 m, terrain
  following). **WHOLE DISC**, **NORTH POLE**, **ICE FRONTIER →**, **FIND DRAMATIC TERRAIN**.
- **Relief** exaggerates terrain; **DRAIN OCEANS** shows ETOPO bathymetry; **DISTORTION** colours the
  east–west stretch; **SHOW DOMAINS** tints the hypothetical ice; **COASTLINES**; **GLEASON GRID**
  (24 meridians every 15°, tropics, polar circles).
- **SUN & TIME**: real sun for now ± 12 h (day/night terminator, city lights at night). Ice sky: the
  South Pole's real sky (default, continuous across the circle) or a fixed low sun.
- **ICE WORLD**: seed, mountains, range coverage, glaciers, ice cliffs, crevasses, snow fill, polar
  weather (snowfall, whiteout, wind), ice caves.
- **ROUTES & DISTORTION**: click two points, or choose a preset, to compare the real-world geodesic
  (cyan) with the straight line across the flat map (amber); Tissot circles show true 500 km circles.
- **LIVE DATA**: flights, military aircraft, ships (needs `AISSTREAM_API_KEY`), satellites; click
  one to track it (satellites show their ground track and orbit).
- **SAVED LOCATIONS**: bookmark real places (lat/lon) or ice places (local X/Y);
  **RETURN TO LAST REAL PLACE** brings you back from the ice.

## Behaviour worth knowing

- **Built on first use.** Until FLAT WORLD is opened, only the button exists: no second WebGL
  context, workers or downloads. `?fw=1` opens it after any shared-view restore has finished and
  is removed from the address bar so later share links open the globe normally.
- **Globe navigation still works.** Location search, city pills, voice commands and the reset
  buttons move the (hidden) globe camera; the flat world follows them to the same place.
- **Globe shortcuts are paused** while the flat world is shown, so FLY/WALK keys (Space, D, …) do
  not trigger the globe's push-to-talk or detection-mode cycling.
- **Live aircraft are drawn between their two latest real fixes**, one feed interval behind real
  time, so every drawn position is traceable to source fixes. The globe extrapolates ahead
  instead, so the same aircraft can sit a few kilometres apart in the two views. Steps that are
  implausible for the reported course and speed (stale, out-of-order or cross-feed fixes) snap to
  the latest fix rather than animating backwards. Grounded aircraft sit on the terrain.
- **Heights:** terrain heights are orthometric (above sea level); aircraft use their reported
  barometric altitude, which is also referenced to sea level. The globe renders aircraft at
  ellipsoidal heights, so heights differ by the geoid undulation (tens of metres).
- **Satellites are drawn at their real height** (400 km for the ISS, 36,000 km for geostationary
  satellites). Seen from far above the North Pole, perspective places high orbits outside the
  disc on screen; their ground points are always inside it. LIVE DATA → SATELLITES: GROUND POINT
  draws them on the point beneath each satellite instead.
- **Ships** need `AISSTREAM_API_KEY`; without it the panel says so.
- **Shadows** are switched off more than ~30,000 km from the disc centre (float32 shadow-map
  precision); terrain shading continues.
- **Data status** in the panel reports missing or failing tiles; chunks built during a temporary
  outage are rebuilt automatically.

Developer handle: `window.__flatWorld` (`enter`, `exit`, `view`, `frame`, `live`, `routes`, `ice`,
`diagnostics()`, `verifyLive()`).

## Architecture

```
src/flatworld/
  projection/aeqd.js       exact ellipsoidal polar AEQD, forward/inverse, scale factors
  projection/domains.js    display frame (Gleason 90° rotation) and the GPS / ice domain split
  sources/catalog.js       keyless imagery/elevation/vector sources and attributions
  sources/tileSchemes.js   web-mercator and geographic tilings, terrarium decoding
  sources/sampler.js       bounded tile cache, parent fallback, bilinear sampling
  terrain/chunkBuilder.js  builds one chunk: heights, normals, domain, sun vectors, texture
  terrain/chunkWorker.js   worker wrapper (bounded fetch concurrency, timeouts)
  terrain/chunkManager.js  unbounded quadtree LOD, prefetch, priorities, bounded GPU cache
  render/flatWorldView.js  the polar rendering adapter (three.js, log depth, sky, sun, fog)
  render/terrainMaterial.js per-fragment true sun, night lights, water, distortion overlay
  render/controls.js       orbit / fly / walk cameras with terrain collision
  render/sun.js            solar ephemeris
  overlays/liveOverlay.js  aircraft, ships, satellites from the app's own layers
  overlays/vectorLines.js  Natural Earth coastlines/borders, graticule, rim
  nav/routes.js            GeographicLib geodesic vs flat chord comparison
  nav/routeLayer.js        route drawing, Tissot indicatrices
  ice/iceField.js          deterministic ice terrain and materials (seeded, float64)
  ice/iceEnvironment.js    polar weather, ice caves, dramatic-vista finder
  buildings/*              OpenStreetMap buildings and roads (OpenFreeMap vector tiles)
  ui/*                     mode switch, panel, styles
server/providers/flatworldData.js    serves local tiles at /flatworld-data (read-only, no traversal)
```

**Polar rendering adapter.** CesiumJS's scene modes (3D, 2D, Columbus) cannot show an
azimuthal-equidistant disc with 3D terrain, so the flat world is a separate three.js renderer in its
own canvas. The Cesium viewer is hidden and paused while the flat world is shown (never destroyed or
reconfigured) and its camera is kept over the flat-world focus so the existing live feeds keep
querying the right region. Leaving restores the exact saved globe view, or opens the globe over the
place you moved to.

**Reprojection, not a texture.** The disc is an unbounded quadtree of chunks (level 0 = 67,108 km
tiles on an infinite grid, down to level 19 ≈ 128 m). Each chunk is built in a worker: every vertex
and texel is inverse-projected to lat/lon and sampled from the source tiles at the zoom matching its
ground resolution, so there is no single whole-Earth texture and no seam at the antimeridian. Chunks
straddling the South-Pole circle classify each sample individually.

**Precision.** Projection math is float64 in JS. Chunk meshes use chunk-local float32 vertices;
three.js composes model-view matrices in float64, so close-up rendering is stable anywhere on the
disc or out in the ice. Instanced overlays use a floating origin. A logarithmic depth buffer covers
centimetres to tens of thousands of kilometres.

**Two domains.** `domains.js` has one boundary rule (`BOUNDARY_TOLERANCE_M`): a plane point more
than 1 µm beyond the South-Pole circle is in the ice domain and gets local X/Y only; inside, it
inverts to its exact WGS84 position. The ice field rises from the real ETOPO 2022 surface height at
90° S (2,832 m) over 250 km and shares the South Pole's real sky by default, so the circle is
invisible when crossed.

## Ice wall (hypothetical)

`src/flatworld/wall/` draws a continuous ice wall on the outer circle of the mapped world
(`frame.boundaryRadius`, about 20,004 km from the North Pole). It is a model feature, not data:
it has no GPS coordinates, and Antarctica's real coast and shelf fronts stay at their true
projected positions.

- Height: baseline 50 m, deterministic variation 20 to 85 m along the rim, hard cap 100 m, and
  low inlets that ramp almost to sea level. The foot sits on the 2,832 m plateau surface.
- Look: cream face with strata, vertical cracks and sea caves in sapphire blue, a snow cornice,
  and a low mist skirt at the base.
- Visibility: beyond 2 km from the wall the height is exaggerated with camera distance
  (E = 1 + (d - 2 km) / 2 km, capped at 12,000), and an on-screen label states the factor and the
  true height. Closer than 2 km it is true scale.
- Sources behind the height choice are listed in `WALL_SOURCES` (`wallModel.js`): Ross 1841,
  the modern Ross Ice Shelf front, iceberg freeboard, Shackleton, Scott, and the physical limit.
- Unit tests: `node --test src/flatworld/wall/wallModel.test.mjs`.

## Verification

- `npm test` includes the flat-world unit tests (projection, domains, chunk builder, routes).
- `tools/flatworld/verify_aeqd.py` (in this repo) compares the projection with PROJ 9.8 over
  1.3 M points (forward 9.3e-9 m, inverse 1.1e-13°) and checks the domain split adversarially.
- `tools/flatworld/ice_determinism.mjs` hashes ice chunks; two runs must match.
- `tools/flatworld/build_etopo_tiles.py` and `tools/flatworld/mirror_gibs.py` rebuild the local
  data (see `tools/flatworld/README.md`).
- `scripts/flatworld-shot.mjs <spec.json>` drives Chrome for browser evidence (see
  `program/evidence/*/*.json` in the program folder).
