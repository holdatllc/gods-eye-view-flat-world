/**
 * Globe data layers in the flat world: every DATA LAYERS / SCENES layer the globe draws, re-drawn
 * through the flat projection.
 *
 * The globe layers keep running on the hidden globe (their own fetchers, viewport rules, colours
 * and icons). This reads what they put in the Cesium scene and draws it in the flat scene:
 * - entity data sources (earthquakes, fire perimeters, radio, dams, datacenters, cables, cyclones,
 *   ALPR, scenes, ...): points, billboards (with the globe's own icon), polylines, polygon and
 *   ellipse outlines;
 * - primitive collections a layer tagged with `gevLayerId` (CCTV, bikeshare, transit, directions);
 * - overlay imagery layers (weather radar, satellite, lightning, scene photos, recent imagery),
 *   draped tile by tile, each tile meshed in its own tiling scheme so the image bends exactly as
 *   the projection does.
 * Positions are projected once per entity (the projection never moves) and only heights are
 * refreshed; markers outside the view are culled, and lines are thinned to the view's scale.
 * Everything here is behind the GLOBE LAYERS and WEATHER & IMAGERY switches.
 */
import * as THREE from 'three';
import * as Cesium from 'cesium';

/** Data sources the flat world already draws itself, or that are not map layers. */
const SKIP_SOURCES = new Set([
  'military-installations',
  'rocket-launches',
  'TeleGeography Cable References',
]);
const SKIP_PREFIXES = ['gev-'];
const MAX_POINTS = 60000;
const MAX_LINE_VERTS = 600000;
const MAX_TILES = 220;
const scratchCarto = new Cesium.Cartographic();
const scratchColor = new Cesium.Color();

const POINT_VERT = /* glsl */ `
  attribute vec4 acolor;
  attribute float asize;
  uniform float uScale;
  varying vec4 vColor;
  void main() {
    vColor = acolor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = asize * uScale;
  }
`;
const POINT_FRAG = /* glsl */ `
  uniform sampler2D map;
  uniform float useMap;
  varying vec4 vColor;
  void main() {
    vec4 c;
    if (useMap > 0.5) {
      c = texture2D(map, vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y)) * vColor;
    } else {
      float d = length(gl_PointCoord - 0.5);
      if (d > 0.5) discard;
      float rim = smoothstep(0.34, 0.42, d);
      c = vec4(mix(vColor.rgb, vec3(0.02, 0.05, 0.07), rim * 0.75), vColor.a * smoothstep(0.5, 0.44, d));
    }
    if (c.a < 0.04) discard;
    gl_FragColor = c;
  }
`;

function skipSource(name) {
  return (
    SKIP_SOURCES.has(name) || SKIP_PREFIXES.some((p) => name?.startsWith(p))
  );
}

/** Cesium colour (or a material/property holding one) at `time`, as [r,g,b,a]. */
function rgba(value, time, fallback) {
  let c = value;
  try {
    if (c?.getValue) c = c.getValue(time, scratchColor);
    if (c && !Number.isFinite(c.red) && c.color) {
      c = c.color.getValue ? c.color.getValue(time, scratchColor) : c.color;
    }
  } catch {
    c = null;
  }
  if (c && Number.isFinite(c.red)) return [c.red, c.green, c.blue, c.alpha];
  return fallback;
}

function val(p, time, fallback) {
  if (p == null) return fallback;
  try {
    const v = p.getValue ? p.getValue(time) : p;
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function toGeo(cartesian) {
  const c = Cesium.Cartographic.fromCartesian(
    cartesian,
    Cesium.Ellipsoid.WGS84,
    scratchCarto,
  );
  if (!c) return null;
  return {
    lat: Cesium.Math.toDegrees(c.latitude),
    lon: Cesium.Math.toDegrees(c.longitude),
    h: c.height || 0,
  };
}

/** Destination point `dist` metres from (lat, lon) along `bearing` (radians), spherical. */
function destination(lat, lon, dist, bearing) {
  const R = 6371008.8;
  const d = dist / R;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(
    Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(bearing),
  );
  const l2 =
    l1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(d) * Math.cos(p1),
      Math.cos(d) - Math.sin(p1) * Math.sin(p2),
    );
  return { lat: (p2 * 180) / Math.PI, lon: (l2 * 180) / Math.PI };
}

export class GlobeLayerMirror {
  constructor({ viewer, frame, dataManager }) {
    this.viewer = viewer;
    this.frame = frame;
    this.dataManager = dataManager;
    this.enabled = true;
    this.imagery = true;
    this.mapSource = true;
    this.timer = 1;
    this.cache = new WeakMap();
    this.textures = new Map();
    this.counts = {};
    this.items = [];
    this.group = new THREE.Group();
    this.group.name = 'flatworld-globe-layers';
    this.markerGroup = new THREE.Group();
    this.lineGeometry = new THREE.BufferGeometry();
    this.lines = new THREE.LineSegments(
      this.lineGeometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        fog: false,
      }),
    );
    this.lines.renderOrder = 18;
    this.lines.frustumCulled = false;
    this.group.add(this.lines, this.markerGroup);
    this.pointBatches = new Map();
    this.drape = new THREE.Group();
    this.drape.name = 'flatworld-globe-imagery';
    this.tiles = new Map();
    this.providerIds = new WeakMap();
    this.nextProviderId = 1;
    this.lastPulse = { at: 0, moved: 0, pos: null };
  }

  attach(view) {
    this.view = view;
    view.scene.add(this.group);
    view.scene.add(this.drape);
    this.labelHost = document.createElement('div');
    this.labelHost.className = 'fw-globe-labels';
    view.host.appendChild(this.labelHost);
    this.hoverLabel = document.createElement('div');
    this.hoverLabel.className = 'fw-globe-label';
    this.hoverLabel.style.display = 'none';
    this.labelHost.appendChild(this.hoverLabel);
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    this.group.visible = this.enabled;
    if (!this.enabled) this.hoverLabel.style.display = 'none';
    this.timer = 1;
  }

  setMapSource(on) {
    this.mapSource = Boolean(on);
    this.timer = 1;
  }

  setImagery(on) {
    this.imagery = Boolean(on);
    this.timer = 1;
  }

  // ---- Hidden-globe events ----------------------------------------------------------------

  /**
   * The hidden globe does not render, so camera-driven layers (CCTV, bikeshare, transit, ALPR)
   * never hear that the view moved. Raise the camera's change and settle events when the flat
   * camera (which the hidden globe camera follows) has moved, and the scene's render events at a
   * low rate for layers that run on them.
   */
  _pulse(now) {
    const v = this.viewer;
    const cam = v.camera;
    const p = cam.positionWC;
    const pulse = this.lastPulse;
    if (!pulse.pos) pulse.pos = Cesium.Cartesian3.clone(p);
    const moved = Cesium.Cartesian3.distance(p, pulse.pos);
    const h = Math.max(cam.positionCartographic?.height || 1000, 200);
    if (moved > h * 0.05) {
      Cesium.Cartesian3.clone(p, pulse.pos);
      pulse.moved = now;
      pulse.settled = false;
      try {
        cam.changed.raiseEvent(1);
      } catch (error) {
        console.warn('[FlatWorld] camera.changed listener failed', error);
      }
    } else if (!pulse.settled && now - pulse.moved > 700) {
      pulse.settled = true;
      try {
        cam.moveEnd.raiseEvent();
      } catch (error) {
        console.warn('[FlatWorld] camera.moveEnd listener failed', error);
      }
    }
    if (now - pulse.at > 500) {
      pulse.at = now;
      const t = Cesium.JulianDate.now();
      try {
        v.scene.preRender.raiseEvent(v.scene, t);
        v.scene.postRender.raiseEvent(v.scene, t);
      } catch (error) {
        console.warn('[FlatWorld] scene render listener failed', error);
      }
    }
  }

  // ---- Geometry cache --------------------------------------------------------------------

  _world(lat, lon) {
    const w = this.frame.geodeticToWorld(lat, lon);
    return w ? { x: w.x, y: w.y } : null;
  }

  /** Projected shape of an entity, rebuilt only when the entity's definition changes. */
  _entityShape(entity, time, fallback) {
    let rec = this.cache.get(entity);
    if (rec && !rec.dirty && !rec.dynamic) return rec;
    if (!rec) {
      rec = { dirty: true };
      this.cache.set(entity, rec);
      entity.definitionChanged?.addEventListener(() => {
        rec.dirty = true;
      });
    }
    rec.dirty = false;
    rec.dynamic = entity.position && !entity.position.isConstant;
    rec.lines = [];
    rec.marker = null;
    rec.name = String(
      entity.name || val(entity.label?.text, time, '') || '',
    ).slice(0, 48);
    const addLine = (cartesians, color, clamp, closed) => {
      if (!Array.isArray(cartesians) || cartesians.length < 2) return;
      const step = Math.max(1, Math.floor(cartesians.length / 1500));
      const xy = [];
      const hs = [];
      for (let i = 0; i < cartesians.length; i += step) {
        const g = toGeo(cartesians[i]);
        const w = g && this._world(g.lat, g.lon);
        if (!w) continue;
        xy.push(w.x, w.y);
        hs.push(g.h);
      }
      if (closed && xy.length > 4) {
        xy.push(xy[0], xy[1]);
        hs.push(hs[0]);
      }
      if (xy.length >= 4)
        rec.lines.push({ xy: new Float64Array(xy), hs, color, clamp });
    };
    const poly = entity.polyline;
    if (poly && val(poly.show, time, true) !== false) {
      addLine(
        val(poly.positions, time, null),
        rgba(poly.material, time, fallback),
        val(poly.clampToGround, time, false) === true,
        false,
      );
    }
    const polygon = entity.polygon;
    if (polygon && val(polygon.show, time, true) !== false) {
      const hier = val(polygon.hierarchy, time, null);
      const positions = Array.isArray(hier) ? hier : hier?.positions;
      const outline = val(polygon.outline, time, false)
        ? rgba(polygon.outlineColor, time, null)
        : null;
      const c = outline || rgba(polygon.material, time, fallback);
      addLine(positions, [c[0], c[1], c[2], Math.max(c[3], 0.75)], true, true);
    }
    const rect = entity.rectangle;
    if (rect && val(rect.show, time, true) !== false) {
      const r = val(rect.coordinates, time, null);
      if (r) {
        const pts = [
          [r.west, r.south],
          [r.east, r.south],
          [r.east, r.north],
          [r.west, r.north],
        ].map(([lo, la]) => Cesium.Cartesian3.fromRadians(lo, la));
        const c = rgba(rect.material, time, fallback);
        addLine(pts, [c[0], c[1], c[2], Math.max(c[3], 0.75)], true, true);
      }
    }
    const cart = entity.position?.getValue?.(time);
    const g = cart ? toGeo(cart) : null;
    const ellipse = entity.ellipse;
    if (g && ellipse && val(ellipse.show, time, true) !== false) {
      const a = val(ellipse.semiMajorAxis, time, 0);
      if (a > 0) {
        const pts = [];
        for (let i = 0; i <= 48; i += 1) {
          const d = destination(g.lat, g.lon, a, (i / 48) * Math.PI * 2);
          pts.push(Cesium.Cartesian3.fromDegrees(d.lon, d.lat));
        }
        const c = rgba(ellipse.material, time, fallback);
        addLine(pts, [c[0], c[1], c[2], Math.max(c[3], 0.8)], true, false);
      }
    }
    if (g) {
      const w = this._world(g.lat, g.lon);
      const bb = entity.billboard;
      const pt = entity.point;
      if (w && bb && val(bb.show, time, true) !== false) {
        const image = val(bb.image, time, null);
        const scale = val(bb.scale, time, 1);
        const width = val(bb.width, time, 0) || 24;
        rec.marker = {
          x: w.x,
          y: w.y,
          h: g.h,
          lat: g.lat,
          lon: g.lon,
          color: rgba(bb.color, time, [1, 1, 1, 1]),
          size: Math.min(48, Math.max(8, width * scale)),
          image,
          clamp: true,
        };
      } else if (w && pt && val(pt.show, time, true) !== false) {
        rec.marker = {
          x: w.x,
          y: w.y,
          h: g.h,
          lat: g.lat,
          lon: g.lon,
          color: rgba(pt.color, time, fallback),
          size: Math.min(28, Math.max(5, val(pt.pixelSize, time, 8) + 2)),
          image: null,
          clamp:
            val(pt.heightReference, time, 0) ===
            Cesium.HeightReference.CLAMP_TO_GROUND,
        };
      } else if (w && ellipse) {
        rec.marker = {
          x: w.x,
          y: w.y,
          h: g.h,
          lat: g.lat,
          lon: g.lon,
          color: rgba(ellipse.material, time, fallback),
          size: 7,
          image: null,
          clamp: true,
        };
      }
    }
    return rec;
  }

  /** Data sources and tagged primitive collections the globe is showing, with their layer. */
  _collect() {
    const v = this.viewer;
    const sources = [];
    const ds = v.dataSources;
    for (let i = 0; i < ds.length; i += 1) {
      const d = ds.get(i);
      if (!d.show || skipSource(d.name)) continue;
      sources.push(d);
    }
    const prims = [];
    const walk = (coll, depth) => {
      for (let i = 0; i < coll.length; i += 1) {
        const p = coll.get(i);
        if (!p) continue;
        if (p.gevLayerId) {
          if (p.show !== false) prims.push(p);
        } else if (p instanceof Cesium.PrimitiveCollection && depth < 2)
          walk(p, depth + 1);
      }
    };
    walk(v.scene.primitives, 0);
    return { sources, prims };
  }

  _texture(image) {
    if (!image) return null;
    const key = typeof image === 'string' ? image : image;
    let t = this.textures.get(key);
    if (t !== undefined) return t;
    if (this.textures.size > 64) return null;
    if (typeof image === 'string') {
      t = new THREE.TextureLoader().load(image);
    } else if (
      image instanceof HTMLCanvasElement ||
      image instanceof HTMLImageElement ||
      (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap)
    ) {
      t = new THREE.Texture(image);
      t.needsUpdate = true;
    } else t = null;
    if (t) t.colorSpace = THREE.SRGBColorSpace;
    this.textures.set(key, t);
    return t;
  }

  _batch(key, texture) {
    let b = this.pointBatches.get(key);
    if (b) return b;
    const geometry = new THREE.BufferGeometry();
    const material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: texture },
        useMap: { value: texture ? 1 : 0 },
        uScale: { value: 1 },
      },
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const points = new THREE.Points(geometry, material);
    points.renderOrder = 19;
    points.frustumCulled = false;
    this.markerGroup.add(points);
    b = { geometry, material, points, pos: [], col: [], size: [] };
    this.pointBatches.set(key, b);
    return b;
  }

  _rebuild() {
    const view = this.view;
    const e = view.chunks.exaggeration;
    const time = Cesium.JulianDate.now();
    const focus = view.getFocus();
    const ox = focus.x;
    const oy = focus.y;
    this.group.position.set(ox, 0, -oy);
    // Cull to what the camera can reach: a disc a few altitudes wide (all of it from high up).
    const reach = Math.max(focus.altitude * 6, 60000);
    const reach2 = reach * reach;
    const minSeg = Math.max(focus.altitude / 300, 20);
    const heightAt = (x, y) => view.chunks.heightAt(x, y) ?? 0;
    for (const b of this.pointBatches.values()) {
      b.pos.length = 0;
      b.col.length = 0;
      b.size.length = 0;
    }
    const lpos = [];
    const lcol = [];
    const items = [];
    const counts = {};
    let points = 0;
    const pushMarker = (m, source, entity, name) => {
      if (points >= MAX_POINTS) return;
      const dx = m.x - ox;
      const dy = m.y - oy;
      if (dx * dx + dy * dy > reach2) return;
      const ground = heightAt(m.x, m.y);
      const h = m.clamp
        ? ground + 25 * e
        : Math.max(ground + 25 * e, (m.h || 0) * e);
      const tex = this._texture(m.image);
      const b = this._batch(tex ? tex.uuid : 'dot', tex);
      b.pos.push(dx, h, -dy);
      b.col.push(...m.color);
      b.size.push(m.size);
      points += 1;
      counts[source] = (counts[source] || 0) + 1;
      items.push({
        source,
        entity,
        name,
        lat: m.lat,
        lon: m.lon,
        world: new THREE.Vector3(m.x, h, -m.y),
      });
    };
    const pushLine = (line) => {
      const xy = line.xy;
      const n = xy.length / 2;
      let prev = -1;
      let px = 0;
      let py = 0;
      let ph = 0;
      for (let i = 0; i < n; i += 1) {
        const x = xy[i * 2];
        const y = xy[i * 2 + 1];
        const last = i === n - 1;
        if (prev >= 0 && !last && Math.hypot(x - px, y - py) < minSeg) continue;
        const dx = x - ox;
        const dy = y - oy;
        const inside = dx * dx + dy * dy <= reach2;
        const prevInside =
          prev >= 0 &&
          (px - ox) * (px - ox) + (py - oy) * (py - oy) <= reach2;
        const h = line.clamp
          ? (inside ? heightAt(x, y) : 0) + 20 * e
          : Math.max(
              (inside ? heightAt(x, y) : 0) + 20 * e,
              (line.hs[i] || 0) * e,
            );
        if (prev >= 0 && (inside || prevInside)) {
          if (lpos.length / 3 >= MAX_LINE_VERTS) return;
          lpos.push(px - ox, ph, -(py - oy), dx, h, -dy);
          const c = line.color;
          lcol.push(c[0], c[1], c[2], c[3], c[0], c[1], c[2], c[3]);
        }
        prev = i;
        px = x;
        py = y;
        ph = h;
      }
    };
    const { sources, prims } = this._collect();
    for (const d of sources) {
      const fallback = [0.22, 0.88, 1, 1];
      for (const entity of d.entities.values) {
        if (!entity.isShowing) continue;
        let rec;
        try {
          rec = this._entityShape(entity, time, fallback);
        } catch {
          continue;
        }
        for (const line of rec.lines) pushLine(line);
        if (rec.marker) pushMarker(rec.marker, d.name, entity, rec.name);
      }
    }
    for (const coll of prims) {
      const isBillboards = coll instanceof Cesium.BillboardCollection;
      for (let i = 0; i < coll.length; i += 1) {
        const p = coll.get(i);
        if (!p || p.show === false || !p.position) continue;
        const g = toGeo(p.position);
        const w = g && this._world(g.lat, g.lon);
        if (!w) continue;
        const c = p.color;
        const image =
          isBillboards && typeof p.image === 'string' && p.image.length < 4096
            ? p.image
            : null;
        pushMarker(
          {
            x: w.x,
            y: w.y,
            h: g.h,
            lat: g.lat,
            lon: g.lon,
            color: c ? [c.red, c.green, c.blue, c.alpha] : [1, 1, 1, 1],
            size: isBillboards
              ? Math.min(40, Math.max(10, (p.width || 22) * (p.scale || 1)))
              : Math.min(24, Math.max(5, (p.pixelSize || 7) + 2)),
            image,
            clamp: true,
          },
          coll.gevLayerId,
          p,
          '',
        );
      }
    }
    for (const b of this.pointBatches.values()) {
      b.geometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(b.pos, 3),
      );
      b.geometry.setAttribute(
        'acolor',
        new THREE.Float32BufferAttribute(b.col, 4),
      );
      b.geometry.setAttribute(
        'asize',
        new THREE.Float32BufferAttribute(b.size, 1),
      );
      b.points.visible = b.pos.length > 0;
    }
    this.lineGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(lpos, 3),
    );
    this.lineGeometry.setAttribute(
      'color',
      new THREE.Float32BufferAttribute(lcol, 4),
    );
    this.items = items;
    this.counts = counts;
    this.lineVerts = lpos.length / 3;
  }

  // ---- Imagery drape ---------------------------------------------------------------------

  _providerId(provider) {
    let id = this.providerIds.get(provider);
    if (!id) {
      id = this.nextProviderId++;
      this.providerIds.set(provider, id);
    }
    return id;
  }

  /** Overlay imagery layers to drape: everything above the base map that is showing. */
  _imageryLayers() {
    const out = [];
    const layers = this.viewer.imageryLayers;
    const latestWeather = new Map();
    for (let i = 0; i < layers.length; i += 1) {
      const l = layers.get(i);
      if (!l.show) continue;
      const provider = l.imageryProvider;
      if (!provider?.tilingScheme) continue;
      const url = String(provider.url || provider._resource?.url || '');
      // The Esri photo is the flat terrain's own imagery, wherever it sits in the stack.
      if (/World_Imagery/i.test(url)) continue;
      if (i === 0 || l.isBaseLayer?.()) {
        // MAP SOURCE: a base map other than the Esri photo the flat terrain already wears
        // (OpenStreetMap, ...) is draped over the terrain, opaque, under everything else.
        if (this.mapSource && i === 0)
          out.push({ layer: l, provider, alpha: 1, order: -1, base: true });
        continue;
      }
      const weather = /\/api\/weather\//.test(url);
      // A weather frame that is still loading on the paused globe sits at alpha 0; show it at the
      // layer's opacity, and only the newest frame of each product.
      const alpha = l.alpha > 0.01 ? l.alpha : weather ? 0.7 : 0;
      if (alpha <= 0) continue;
      const entry = { layer: l, provider, alpha, order: i, base: false };
      if (weather) {
        const product = /product=([a-z-]+)/.exec(url)?.[1] || url;
        latestWeather.set(product, entry);
      } else out.push(entry);
    }
    return out.concat([...latestWeather.values()]);
  }

  _tileRange(provider, level, bbox) {
    const ts = provider.tilingScheme;
    const rect = provider.rectangle || ts.rectangle;
    const west = Math.max(bbox.west, rect.west);
    const east = Math.min(bbox.east, rect.east);
    const south = Math.max(bbox.south, rect.south);
    const north = Math.min(bbox.north, rect.north);
    if (west >= east || south >= north) return null;
    const nw = ts.positionToTileXY(
      Cesium.Cartographic.fromRadians(west + 1e-9, north - 1e-9),
      level,
    );
    const se = ts.positionToTileXY(
      Cesium.Cartographic.fromRadians(east - 1e-9, south + 1e-9),
      level,
    );
    if (!nw || !se) return null;
    return { x0: nw.x, x1: se.x, y0: nw.y, y1: se.y };
  }

  _tileMesh(provider, x, y, level, image, alpha, order) {
    const ts = provider.tilingScheme;
    const r = ts.tileXYToRectangle(x, y, level);
    const mercator = ts instanceof Cesium.WebMercatorTilingScheme;
    const N = 16;
    const pos = new Float32Array((N + 1) * (N + 1) * 3);
    const uv = new Float32Array((N + 1) * (N + 1) * 2);
    const xy = new Float64Array((N + 1) * (N + 1) * 2);
    const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + lat / 2));
    const invMerc = (m) => 2 * Math.atan(Math.exp(m)) - Math.PI / 2;
    // Cesium decodes imagery to ImageBitmaps already flipped for WebGL; canvases and images are not.
    const flipped =
      typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap;
    const yN = mercator ? mercY(r.north) : r.north;
    const yS = mercator ? mercY(r.south) : r.south;
    for (let j = 0; j <= N; j += 1) {
      const v = j / N;
      const yy = yN + (yS - yN) * v;
      const lat = Cesium.Math.toDegrees(mercator ? invMerc(yy) : yy);
      for (let i = 0; i <= N; i += 1) {
        const u = i / N;
        const lon = Cesium.Math.toDegrees(r.west + (r.east - r.west) * u);
        const w = this.frame.geodeticToWorld(
          Math.max(-89.999, Math.min(89.999, lat)),
          lon,
        );
        const k = j * (N + 1) + i;
        xy[k * 2] = w ? w.x : NaN;
        xy[k * 2 + 1] = w ? w.y : NaN;
        uv[k * 2] = u;
        uv[k * 2 + 1] = flipped ? 1 - v : v;
      }
    }
    const index = [];
    for (let j = 0; j < N; j += 1)
      for (let i = 0; i < N; i += 1) {
        const a = j * (N + 1) + i;
        const b = a + 1;
        const c = a + N + 1;
        const d = c + 1;
        if ([a, b, c, d].some((k) => !Number.isFinite(xy[k * 2]))) continue;
        index.push(a, c, b, b, c, d);
      }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geometry.setIndex(index);
    const texture = new THREE.Texture(image);
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: alpha < 1,
      opacity: alpha,
      // Depth-tested a little above the terrain: buildings and mountains still cover it.
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
      fog: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 4 + order * 0.01;
    mesh.frustumCulled = false;
    mesh.userData.xy = xy;
    return mesh;
  }

  /** Heights of a tile mesh: on the terrain (a little above), relative to the drape origin. */
  _placeTile(mesh, ox, oy) {
    const xy = mesh.userData.xy;
    const pos = mesh.geometry.attributes.position;
    const e = this.view.chunks.exaggeration;
    const lift = Math.max(15, (this.view.getFocus().altitude || 0) * 0.002) * e;
    for (let k = 0; k < pos.count; k += 1) {
      const x = xy[k * 2];
      const y = xy[k * 2 + 1];
      if (!Number.isFinite(x)) continue;
      const h = (this.view.chunks.heightAt(x, y) ?? 0) + lift;
      pos.setXYZ(k, x - ox, h, -(y - oy));
    }
    pos.needsUpdate = true;
    mesh.userData.placedAt = { ox, oy };
  }

  _updateDrape() {
    const view = this.view;
    const focus = view.getFocus();
    const ox = focus.x;
    const oy = focus.y;
    this.drape.position.set(ox, 0, -oy);
    const wanted = new Set();
    const layers = this._imageryLayers().filter((l) =>
      l.base ? this.mapSource : this.imagery,
    );
    const geo = focus.domain?.domain === 'gps' ? focus.domain : null;
    // What the camera can see from straight above (wider when tilted), and about six tiles
    // across it.
    const tilt = Math.max(0.35, Math.sin((-focus.pitchDeg * Math.PI) / 180));
    const viewW = (focus.altitude * 1.25) / tilt;
    const reach = Math.max(viewW * 0.8, 20000);
    let bbox;
    if (!geo || reach > 5e6) {
      bbox = {
        west: -Math.PI,
        east: Math.PI,
        south: Cesium.Math.toRadians(-85),
        north: Cesium.Math.toRadians(85),
      };
    } else {
      const dLat = reach / 111320;
      const dLon = dLat / Math.max(Math.cos((geo.lat * Math.PI) / 180), 0.05);
      bbox = {
        west: Cesium.Math.toRadians(Math.max(-180, geo.lon - dLon)),
        east: Cesium.Math.toRadians(Math.min(180, geo.lon + dLon)),
        south: Cesium.Math.toRadians(Math.max(-85, geo.lat - dLat)),
        north: Cesium.Math.toRadians(Math.min(85, geo.lat + dLat)),
      };
    }
    let budget = MAX_TILES;
    for (const entry of layers) {
      const { provider } = entry;
      const pid = this._providerId(provider);
      const ts = provider.tilingScheme;
      const x0 = ts.getNumberOfXTilesAtLevel(0);
      let level = Math.round(Math.log2(40075016 / x0 / (viewW / 6)));
      level = Math.max(
        provider.minimumLevel || 0,
        Math.min(level, provider.maximumLevel ?? 10, 10),
      );
      let range = this._tileRange(provider, level, bbox);
      while (
        range &&
        level > (provider.minimumLevel || 0) &&
        (range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1) > 100
      ) {
        level -= 1;
        range = this._tileRange(provider, level, bbox);
      }
      if (!range) continue;
      for (let y = range.y0; y <= range.y1; y += 1)
        for (let x = range.x0; x <= range.x1; x += 1) {
          if (budget-- <= 0) break;
          const key = `${pid}/${level}/${x}/${y}`;
          wanted.add(key);
          let tile = this.tiles.get(key);
          if (!tile) {
            tile = { state: 'new', mesh: null, alpha: entry.alpha };
            this.tiles.set(key, tile);
          }
          tile.used = performance.now();
          if (tile.state === 'new' || (tile.state === 'retry' && tile.retryAt < tile.used)) {
            tile.state = 'loading';
            let req;
            try {
              req = provider.requestImage(x, y, level);
            } catch {
              req = undefined;
            }
            if (!req) {
              tile.state = 'retry';
              tile.retryAt = tile.used + 800;
              continue;
            }
            Promise.resolve(req).then(
              (image) => {
                if (!image || !this.tiles.has(key)) return;
                tile.mesh = this._tileMesh(
                  provider,
                  x,
                  y,
                  level,
                  image,
                  entry.alpha,
                  entry.order,
                );
                this._placeTile(tile.mesh, ox, oy);
                tile.state = 'ready';
                this.drape.add(tile.mesh);
              },
              () => {
                tile.state = 'failed';
              },
            );
          }
          if (tile.mesh) {
            tile.mesh.visible = true;
            tile.mesh.material.opacity = entry.alpha;
            const at = tile.mesh.userData.placedAt;
            if (!at || Math.hypot(at.ox - ox, at.oy - oy) > 1)
              this._placeTile(tile.mesh, ox, oy);
          }
        }
    }
    // Hide tiles out of view; drop the oldest beyond the cache size.
    for (const [key, tile] of this.tiles) {
      if (wanted.has(key)) continue;
      if (tile.mesh) tile.mesh.visible = false;
    }
    if (this.tiles.size > MAX_TILES * 2) {
      const old = [...this.tiles.entries()]
        .filter(([k]) => !wanted.has(k))
        .sort((a, b) => a[1].used - b[1].used);
      for (const [key, tile] of old.slice(0, this.tiles.size - MAX_TILES)) {
        if (tile.mesh) {
          tile.mesh.removeFromParent();
          tile.mesh.geometry.dispose();
          tile.mesh.material.map?.dispose();
          tile.mesh.material.dispose();
        }
        this.tiles.delete(key);
      }
    }
    this.drapeTiles = wanted.size;
  }

  // ---- Frame loop ------------------------------------------------------------------------

  update(dt, view) {
    const now = performance.now();
    this._pulse(now);
    this.timer += dt;
    const focus = view.getFocus();
    const last = this.lastFocus;
    const moved =
      !last ||
      Math.hypot(focus.x - last.x, focus.y - last.y) >
        Math.max(focus.altitude * 0.25, 200) ||
      Math.abs(focus.altitude - last.altitude) > last.altitude * 0.3;
    if (this.timer > 1 || (moved && this.timer > 0.15)) {
      this.timer = 0;
      this.lastFocus = { x: focus.x, y: focus.y, altitude: focus.altitude };
      if (this.enabled) {
        try {
          this._rebuild();
        } catch (error) {
          console.warn('[FlatWorld] globe layer mirror failed', error);
        }
      }
      try {
        this._updateDrape();
      } catch (error) {
        console.warn('[FlatWorld] globe imagery drape failed', error);
      }
    }
    const scale = view.renderer.getPixelRatio();
    for (const b of this.pointBatches.values())
      b.material.uniforms.uScale.value = scale;
  }

  /** Mirrored marker under a screen point (client coordinates), or null. */
  nearest(clientX, clientY, radiusPx = 12) {
    if (!this.enabled || !this.view) return null;
    const r = this.view.canvas.getBoundingClientRect();
    const x = clientX - r.left;
    const y = clientY - r.top;
    let best = null;
    let bestD = radiusPx;
    for (const it of this.items) {
      const s = this.view.worldToScreen(it.world);
      if (!s) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestD) {
        bestD = d;
        best = it;
      }
    }
    return best;
  }

  /** Name tag for the marker under the pointer. */
  hover(clientX, clientY) {
    const it = this.nearest(clientX, clientY, 10);
    const el = this.hoverLabel;
    if (!it || !it.name) {
      el.style.display = 'none';
      return it;
    }
    const s = this.view.worldToScreen(it.world);
    el.style.display = '';
    el.textContent = it.name;
    el.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px)`;
    return it;
  }

  /** Select a mirrored entity the way the globe does (its info card / selection). */
  select(item) {
    if (!item?.entity) return false;
    if (item.entity instanceof Cesium.Entity) {
      this.viewer.selectedEntity = item.entity;
      return true;
    }
    return false;
  }

  diagnostics() {
    return {
      enabled: this.enabled,
      imagery: this.imagery,
      markers: { ...this.counts },
      lineVerts: this.lineVerts || 0,
      drapeTiles: this.drapeTiles || 0,
      readyTiles: [...this.tiles.values()].filter((t) => t.state === 'ready')
        .length,
    };
  }

  destroy() {
    this.group.removeFromParent();
    this.drape.removeFromParent();
    this.labelHost?.remove();
  }
}

const PREFS_KEY = 'gev.flatworld.globeLayers';

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function writePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode */
  }
}

/**
 * GLOBE LAYERS section of the flat panel: the switches for the mirror, the imagery drape and the
 * globe's DATA LAYERS / SCENES panels, and what is being drawn.
 */
export function installGlobeLayerControls({ panel, mirror, wind, overlay }) {
  const prefs = {
    markers: true,
    imagery: true,
    panels: true,
    wind: true,
    detection: true,
    mapSource: true,
    ...readPrefs(),
  };
  mirror.setMapSource(prefs.mapSource);
  wind?.setEnabled(prefs.wind);
  overlay?.setEnabled(prefs.detection);
  mirror.setEnabled(prefs.markers);
  mirror.setImagery(prefs.imagery);
  document.body.classList.toggle('fw-globe-panels', prefs.panels);
  const box = panel.section('globe-layers', 'GLOBE LAYERS');
  const row = document.createElement('div');
  row.className = 'fw-row';
  const mk = (label, key, title, apply) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = prefs[key] ? 'fw-btn on' : 'fw-btn';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', () => {
      prefs[key] = !prefs[key];
      b.classList.toggle('on', prefs[key]);
      apply(prefs[key]);
      writePrefs(prefs);
    });
    row.appendChild(b);
    return b;
  };
  mk(
    'DATA PANELS',
    'panels',
    'Show the globe’s DATA LAYERS and SCENES panels in the flat world; every layer switched on there is drawn here',
    (on) => document.body.classList.toggle('fw-globe-panels', on),
  );
  mk(
    'LAYER MARKERS',
    'markers',
    'Draw the globe layers’ markers, lines and outlines (CCTV, cables, quakes, radio, dams, ...) through the flat projection',
    (on) => mirror.setEnabled(on),
  );
  mk(
    'WEATHER & IMAGERY',
    'imagery',
    'Drape the globe’s weather radar, satellite, lightning and scene imagery over the flat terrain',
    (on) => mirror.setImagery(on),
  );
  mk(
    'MAP SOURCE',
    'mapSource',
    'Drape the globe’s chosen base map (OpenStreetMap and the other MAP SOURCE choices) over the flat terrain; the default Esri photo is the flat terrain’s own',
    (on) => mirror.setMapSource(on),
  );
  if (wind)
    mk(
      'WIND FLOW',
      'wind',
      'Animate the globe’s WIND forecast as streaks moving through the flat projection (needs WIND on in DATA LAYERS)',
      (on) => wind.setEnabled(on),
    );
  if (overlay)
    mk(
      'DETECTION OVERLAY',
      'detection',
      'The globe’s detection brackets, callouts and cards (and its density, fade and opacity sliders) and map annotations, following the flat camera',
      (on) => overlay.setEnabled(on),
    );
  const note = document.createElement('div');
  note.className = 'fw-note';
  box.append(row, note);
  setInterval(() => {
    if (!document.body.classList.contains('flatworld-active')) return;
    const d = mirror.diagnostics();
    const parts = Object.entries(d.markers)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, n]) => `${k} ${n.toLocaleString()}`);
    note.textContent =
      (parts.length ? parts.join(' · ') : 'No globe layer markers in view') +
      (d.drapeTiles ? ` · imagery tiles ${d.readyTiles}/${d.drapeTiles}` : '');
  }, 1500);
}
