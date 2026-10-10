/**
 * Builds one flat-world terrain chunk: a height grid, normals, per-vertex domain/water/sun data and
 * a reprojected colour texture. Runs inside a worker (see chunkWorker.js) but has no DOM/worker
 * dependencies, so it is unit-testable in Node with a fake tile loader.
 *
 * Chunk addressing: level L has square tiles of size `rootSize / 2^L` metres on an unbounded grid
 * in the display frame. A chunk can lie in the GPS domain, the ice domain, or straddle the
 * South-Pole circle; every vertex and texel is classified on its own.
 */
import { createWorldFrame, DOMAIN_ICE } from '../projection/domains.js';
import { createPolarAeqd } from '../projection/aeqd.js';
import { createIceField, iceColor } from '../ice/iceField.js';
import { ChunkSampler } from '../sources/sampler.js';
import { ELEVATION_SOURCES, IMAGERY_SOURCES } from '../sources/catalog.js';

const DEG = Math.PI / 180;
/** Mapterhorn is used when the needed ground resolution is finer than ETOPO's ~1.8 km. */
const FINE_TERRAIN_BELOW_M = 1500;
const ESRI_FULL_LAT = 81.0;
const ESRI_MAX_LAT = 85.0;

export const ROOT_TILE_SIZE = 2 ** 26; // 67,108.864 km: one root covers the whole GPS disc.

/**
 * Ground metres per sample for a plane spacing at a latitude. Along meridians the projection is
 * true to scale; along parallels one plane metre covers 1/k ground metres. Sampling at the
 * geometric mean (capped) keeps detail where the map stretches without fetching thousands of
 * source tiles for the hugely stretched polar rim.
 */
export function groundResolution(planeSpacing, lat) {
  const k = polarScale(lat);
  return planeSpacing / Math.min(Math.sqrt(Math.max(1, k)), 4);
}

let polarScale = (lat) => 1;

export function tileBounds(level, tx, ty, rootSize = ROOT_TILE_SIZE) {
  const size = rootSize / 2 ** level;
  const x0 = tx * size - rootSize / 2;
  const y0 = ty * size - rootSize / 2;
  return { size, x0, y0, x1: x0 + size, y1: y0 + size };
}

export function createChunkBuilder({ store, frameOptions = {}, iceParams = {} }) {
  const projection = createPolarAeqd();
  polarScale = (lat) => projection.scaleFactors(lat).k;
  const frame = createWorldFrame({ projection, ...frameOptions });
  let ice = createIceField(iceParams, frame);

  function setIceParams(params) {
    ice = createIceField(params, frame);
  }

  function setDisplayRotation(deg) {
    frame.setDisplayRotation(deg);
  }

  /**
   * @param {{ level:number, tx:number, ty:number, grid?:number, texSize?:number }} req
   */
  async function build({ level, tx, ty, grid = 64, texSize = 256 }) {
    const { size, x0, y0 } = tileBounds(level, tx, ty);
    const step = size / grid;
    const G = grid;
    const W = G + 3; // height grid with a one-sample border ring for seamless normals
    const sampler = new ChunkSampler(store);

    // ---- Classify vertices and request elevation tiles -------------------------------------
    const n = W * W;
    const vx = new Float64Array(n);
    const vy = new Float64Array(n);
    const vLat = new Float64Array(n);
    const vLon = new Float64Array(n);
    const vIce = new Uint8Array(n);
    const vRes = new Float64Array(n);
    for (let j = 0; j < W; j += 1) {
      for (let i = 0; i < W; i += 1) {
        const k = j * W + i;
        const x = x0 + (i - 1) * step;
        const y = y0 + (j - 1) * step;
        vx[k] = x;
        vy[k] = y;
        const d = frame.worldToDomain(x, y);
        if (d.domain === DOMAIN_ICE) {
          vIce[k] = 1;
          continue;
        }
        vLat[k] = d.lat;
        vLon[k] = d.lon;
        const res = groundResolution(step, d.lat);
        vRes[k] = res;
        const etopo = ELEVATION_SOURCES.etopo;
        sampler.request(etopo, d.lat, d.lon, etopo.scheme.zoomFor(res));
        if (res < FINE_TERRAIN_BELOW_M && Math.abs(d.lat) < 85) {
          const mt = ELEVATION_SOURCES.mapterhorn;
          sampler.request(mt, d.lat, d.lon, mt.scheme.zoomFor(res, d.lat));
        }
      }
    }

    // ---- Classify texels and request imagery tiles --------------------------------------------
    const T = texSize;
    const texStep = size / T;
    const tLat = new Float64Array(T * T);
    const tLon = new Float64Array(T * T);
    const tIce = new Uint8Array(T * T);
    const tZoomEsri = new Int8Array(T * T);
    const tZoomGibs = new Int8Array(T * T);
    const esri = IMAGERY_SOURCES.esri;
    const gibs = IMAGERY_SOURCES.gibsBlueMarble;
    const lights = IMAGERY_SOURCES.gibsBlackMarble;
    const arctic = IMAGERY_SOURCES.modisArctic;
    const tZoomLights = new Int8Array(T * T);
    for (let j = 0; j < T; j += 1) {
      for (let i = 0; i < T; i += 1) {
        const k = j * T + i;
        const x = x0 + (i + 0.5) * texStep;
        const y = y0 + (j + 0.5) * texStep; // row 0 is the chunk's y0 edge (uv v = 0, flipY off)
        const d = frame.worldToDomain(x, y);
        if (d.domain === DOMAIN_ICE) {
          tIce[k] = 1;
          continue;
        }
        tLat[k] = d.lat;
        tLon[k] = d.lon;
        const res = groundResolution(texStep, d.lat);
        const absLat = Math.abs(d.lat);
        if (absLat < ESRI_MAX_LAT) {
          tZoomEsri[k] = esri.scheme.zoomFor(res, d.lat);
          sampler.request(esri, d.lat, d.lon, tZoomEsri[k]);
        } else tZoomEsri[k] = -1;
        if (absLat > ESRI_FULL_LAT) {
          const cap = d.lat > 0 ? arctic : gibs;
          tZoomGibs[k] = cap.scheme.zoomFor(res);
          sampler.request(cap, d.lat, d.lon, tZoomGibs[k]);
        } else tZoomGibs[k] = -1;
        // Night lights are only seen from afar; a coarser zoom keeps the request count low.
        tZoomLights[k] = lights.scheme.zoomFor(res * 2);
        sampler.request(lights, d.lat, d.lon, tZoomLights[k]);
      }
    }

    const tilesRequested = sampler.pending.size;
    const tResolve0 = Date.now();
    await sampler.resolve();
    const resolveMs = Date.now() - tResolve0;

    // ---- Heights ----------------------------------------------------------------------------
    const hSurf = new Float64Array(n);
    const hBed = new Float64Array(n);
    const water = new Float32Array(n);
    const iceSamples = new Array(n);
    for (let k = 0; k < n; k += 1) {
      if (vIce[k]) {
        const s = ice.sample(vx[k], vy[k]);
        iceSamples[k] = s;
        hSurf[k] = s.height;
        hBed[k] = s.height;
        continue;
      }
      const lat = vLat[k];
      const lon = vLon[k];
      const res = vRes[k];
      const etopo = ELEVATION_SOURCES.etopo;
      let hEtopo = sampler.sampleHeight(etopo, lat, lon, etopo.scheme.zoomFor(res));
      if (!Number.isFinite(hEtopo)) hEtopo = 0;
      let h = hEtopo;
      let w = hEtopo < 0 ? 1 : 0;
      if (res < FINE_TERRAIN_BELOW_M && Math.abs(lat) < 85) {
        const mt = ELEVATION_SOURCES.mapterhorn;
        const hm = sampler.sampleHeight(mt, lat, lon, mt.scheme.zoomFor(res, lat));
        if (Number.isFinite(hm)) {
          // Mapterhorn is land-only (oceans read 0); ETOPO supplies bathymetry there.
          if (Math.abs(hm) < 0.5 && hEtopo < -2) {
            w = 1;
          } else {
            h = hm;
            w = 0;
          }
        }
      }
      hBed[k] = h;
      hSurf[k] = w ? 0 : h;
      water[k] = w;
    }

    // ---- Vertex buffers (G+1)^2 core vertices + 4·G skirt vertices --------------------------
    const V = (G + 1) * (G + 1);
    const S = 4 * G;
    const total = V + S;
    const position = new Float32Array(total * 3);
    const normal = new Float32Array(total * 3);
    const bed = new Float32Array(total);
    const up = new Float32Array(total * 3);
    const domain = new Float32Array(total);
    const waterAttr = new Float32Array(total);
    const skirt = new Float32Array(total);
    const uv = new Float32Array(total * 2);
    let minH = Infinity;
    let maxH = -Infinity;

    const writeVertex = (dst, i, j, isSkirt) => {
      const k = (j + 1) * W + (i + 1);
      const h = hSurf[k];
      position[dst * 3] = i * step;
      position[dst * 3 + 1] = h;
      position[dst * 3 + 2] = -j * step;
      bed[dst] = hBed[k];
      // Central-difference normal in the (x, h, -y) frame.
      const dhdx = (hSurf[k + 1] - hSurf[k - 1]) / (2 * step);
      const dhdy = (hSurf[k + W] - hSurf[k - W]) / (2 * step);
      const nx = -dhdx;
      const ny = 1;
      const nz = dhdy;
      const len = Math.hypot(nx, ny, nz);
      normal[dst * 3] = nx / len;
      normal[dst * 3 + 1] = ny / len;
      normal[dst * 3 + 2] = nz / len;
      if (vIce[k]) {
        // The ice domain shares the South Pole's sky: its up-vector is the pole's, taken along the
        // rim longitude in this direction, so lighting is continuous across the circle. (This is a
        // lighting convention only; ice points never receive a geodetic position.)
        const p = frame.fromDisplay(vx[k], vy[k]);
        const lam = Math.atan2(p.x, -p.y);
        const la = -89.99 * DEG;
        up[dst * 3] = Math.cos(la) * Math.cos(lam);
        up[dst * 3 + 1] = Math.cos(la) * Math.sin(lam);
        up[dst * 3 + 2] = Math.sin(la);
        domain[dst] = 1;
      } else {
        const la = vLat[k] * DEG;
        const lo = vLon[k] * DEG;
        up[dst * 3] = Math.cos(la) * Math.cos(lo);
        up[dst * 3 + 1] = Math.cos(la) * Math.sin(lo);
        up[dst * 3 + 2] = Math.sin(la);
      }
      waterAttr[dst] = water[k];
      skirt[dst] = isSkirt ? 1 : 0;
      uv[dst * 2] = i / G;
      uv[dst * 2 + 1] = j / G;
      if (!isSkirt) {
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    };

    for (let j = 0; j <= G; j += 1) {
      for (let i = 0; i <= G; i += 1) writeVertex(j * (G + 1) + i, i, j, false);
    }
    // Skirts: bottom edge (j=0), right edge (i=G), top edge (j=G), left edge (i=0), G each.
    let s = V;
    for (let i = 0; i < G; i += 1) writeVertex(s++, i, 0, true);
    for (let j = 0; j < G; j += 1) writeVertex(s++, G, j, true);
    for (let i = G; i > 0; i -= 1) writeVertex(s++, i, G, true);
    for (let j = G; j > 0; j -= 1) writeVertex(s++, 0, j, true);

    // ---- Texture ------------------------------------------------------------------------------
    const rgba = new Uint8Array(T * T * 4);
    const scratch = { rock: 0, blueIce: 0, snow: 0, crevasse: 0 };
    const c = [0, 0, 0];
    const c2 = [0, 0, 0];
    let iceTexels = 0;
    let gpsTexels = 0;
    for (let j = 0; j < T; j += 1) {
      for (let i = 0; i < T; i += 1) {
        const k = j * T + i;
        const o = k * 4;
        if (tIce[k]) {
          iceTexels += 1;
          const x = x0 + (i + 0.5) * texStep;
          const y = y0 + (j + 0.5) * texStep;
          // Material fields vary slowly: interpolate them from the vertex samples, and evaluate
          // only the fine detail (grain, crevasse cracks) per texel.
          const fx = ((i + 0.5) / T) * G + 1;
          const fy = ((j + 0.5) / T) * G + 1;
          const ia = Math.min(Math.floor(fx), W - 2);
          const ja = Math.min(Math.floor(fy), W - 2);
          const u = fx - ia;
          const v = fy - ja;
          const s00 = iceSamples[ja * W + ia];
          const s10 = iceSamples[ja * W + ia + 1];
          const s01 = iceSamples[(ja + 1) * W + ia];
          const s11 = iceSamples[(ja + 1) * W + ia + 1];
          if (!s00 || !s10 || !s01 || !s11) {
            const sm = ice.sample(x, y);
            const col = iceColor(sm, x, y, 0, ice.params.seed);
            rgba[o] = col[0];
            rgba[o + 1] = col[1];
            rgba[o + 2] = col[2];
            rgba[o + 3] = 0;
            continue;
          }
          const lerp = (key) =>
            (s00[key] * (1 - u) + s10[key] * u) * (1 - v) + (s01[key] * (1 - u) + s11[key] * u) * v;
          const zone = lerp('crevasseZone');
          const tr = lerp('transition');
          scratch.rock = lerp('rock');
          scratch.blueIce = lerp('blueIce');
          scratch.snow = lerp('snow');
          scratch.crevasse = tr * ice.crevasseAt(x, y, zone);
          const gi = Math.min(G, Math.round(((i + 0.5) / T) * G));
          const gj = Math.min(G, Math.round(((j + 0.5) / T) * G));
          const ny = normal[(gj * (G + 1) + gi) * 3 + 1];
          const col = iceColor(scratch, x, y, Math.sqrt(Math.max(0, 1 - ny * ny)), ice.params.seed);
          rgba[o] = col[0];
          rgba[o + 1] = col[1];
          rgba[o + 2] = col[2];
          rgba[o + 3] = 0; // alpha carries night lights; the ice has none
          continue;
        }
        gpsTexels += 1;
        const lat = tLat[k];
        const lon = tLon[k];
        const absLat = Math.abs(lat);
        let got = null;
        if (tZoomEsri[k] >= 0) got = sampler.sampleColor(esri, lat, lon, tZoomEsri[k], c);
        if (tZoomGibs[k] >= 0) {
          const g = sampler.sampleColor(lat > 0 ? arctic : gibs, lat, lon, tZoomGibs[k], c2);
          if (g) {
            const lin = Math.min(1, Math.max(0, (absLat - ESRI_FULL_LAT) / (ESRI_MAX_LAT - ESRI_FULL_LAT)));
            // Soft, wide blend so the polar cap reads as a natural ice edge, not a seam.
            const t = got ? lin * lin * (3 - 2 * lin) : 1;
            c[0] = (got ? c[0] : 0) * (1 - t) + g[0] * t;
            c[1] = (got ? c[1] : 0) * (1 - t) + g[1] * t;
            c[2] = (got ? c[2] : 0) * (1 - t) + g[2] * t;
            got = c;
          }
        }
        if (!got) {
          c[0] = 30;
          c[1] = 40;
          c[2] = 60;
        }
        rgba[o] = c[0];
        rgba[o + 1] = c[1];
        rgba[o + 2] = c[2];
        // Alpha channel = night-light intensity from Black Marble (dark base removed).
        const nl = sampler.sampleColor(lights, lat, lon, tZoomLights[k], c2);
        const lum = nl ? Math.max(nl[0], nl[1], nl[2]) : 0;
        rgba[o + 3] = Math.max(0, Math.min(255, Math.round(((lum - 70) / 185) * 255)));
      }
    }

    return {
      level,
      tx,
      ty,
      size,
      x0,
      y0,
      grid: G,
      texSize: T,
      minH: Number.isFinite(minH) ? minH : 0,
      maxH: Number.isFinite(maxH) ? maxH : 0,
      domainMix: iceTexels && gpsTexels ? 'mixed' : iceTexels ? 'ice' : 'gps',
      timing: { tilesRequested, resolveMs },
      position,
      normal,
      bed,
      up,
      domain,
      water: waterAttr,
      skirt,
      uv,
      rgba,
    };
  }

  return { build, setIceParams, setDisplayRotation, frame, projection };
}

/** Index buffer shared by every chunk of a given grid size (core grid + skirt quads). */
export function chunkIndices(G) {
  const V = (G + 1) * (G + 1);
  const idx = [];
  for (let j = 0; j < G; j += 1) {
    for (let i = 0; i < G; i += 1) {
      const a = j * (G + 1) + i;
      const b = a + 1;
      const c = a + (G + 1);
      const d = c + 1;
      // Counter-clockwise when seen from above (+Y) with z = −y.
      idx.push(a, b, d, a, d, c);
    }
  }
  // Each edge vertex pairs with its skirt copy.
  const edge = [];
  for (let i = 0; i < G; i += 1) edge.push(i); // bottom
  for (let j = 0; j < G; j += 1) edge.push(j * (G + 1) + G); // right
  for (let i = G; i > 0; i -= 1) edge.push(G * (G + 1) + i); // top
  for (let j = G; j > 0; j -= 1) edge.push(j * (G + 1)); // left
  for (let e = 0; e < edge.length; e += 1) {
    const a = edge[e];
    const b = edge[(e + 1) % edge.length];
    const sa = V + e;
    const sb = V + ((e + 1) % edge.length);
    idx.push(a, sa, sb, a, sb, b);
  }
  return new Uint32Array(idx);
}
