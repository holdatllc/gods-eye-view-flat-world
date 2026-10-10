/**
 * Source tile schemes for the flat-world reprojection. Pure functions: usable in workers and tests.
 *
 * The flat world never stores one whole-Earth texture. Every chunk resamples the source tiles
 * that cover it, at the zoom that matches the chunk's ground resolution.
 */

const DEG = Math.PI / 180;
export const MERCATOR_MAX_LAT = 85.0511287798066;
const EARTH_CIRCUMFERENCE = 40075016.685578488; // WGS84 equatorial (web-mercator sphere)

/** Web-mercator (EPSG:3857) XYZ tiling. */
export function webMercatorScheme({ tileSize = 256, maxZoom = 19, minZoom = 0 } = {}) {
  return {
    kind: 'mercator',
    tileSize,
    maxZoom,
    minZoom,
    covers: (lat) => Math.abs(lat) <= MERCATOR_MAX_LAT,
    /** Ground metres per pixel at zoom z on the given latitude. */
    resolution: (z, lat) => (EARTH_CIRCUMFERENCE * Math.cos(lat * DEG)) / (tileSize * 2 ** z),
    /** Zoom whose resolution is at least as fine as `metresPerPixel`. */
    zoomFor(metresPerPixel, lat) {
      const c = Math.max(Math.cos(lat * DEG), 1e-6);
      const z = Math.ceil(Math.log2((EARTH_CIRCUMFERENCE * c) / (tileSize * metresPerPixel)));
      return Math.max(minZoom, Math.min(maxZoom, z));
    },
    /** Global pixel coordinates (floating) at zoom z. */
    pixel(lat, lon, z) {
      const n = tileSize * 2 ** z;
      const clamped = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
      const s = Math.sin(clamped * DEG);
      const px = ((lon + 180) / 360) * n;
      const py = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
      return { px, py, n, nx: n, ny: n };
    },
  };
}

/**
 * Geographic (EPSG:4326) tiling with `rootColumns` × `rootRows` tiles at level 0, each spanning
 * `rootSpanDeg` degrees, top-left at (−180, 90).
 */
export function geographicScheme({
  tileSize = 512,
  maxZoom = 8,
  rootSpanDeg = 288,
} = {}) {
  return {
    kind: 'geographic',
    tileSize,
    maxZoom,
    minZoom: 0,
    covers: () => true,
    resolution: (z) => ((rootSpanDeg / 2 ** z) * 111320) / tileSize,
    zoomFor(metresPerPixel) {
      const z = Math.ceil(Math.log2((rootSpanDeg * 111320) / (tileSize * metresPerPixel)));
      return Math.max(0, Math.min(maxZoom, z));
    },
    pixel(lat, lon, z) {
      const degPerPx = rootSpanDeg / 2 ** z / tileSize;
      return {
        px: (lon + 180) / degPerPx,
        py: (90 - lat) / degPerPx,
        // Wrap and clamp on the real 360° × 180° extent, not the padded tile grid.
        nx: 360 / degPerPx,
        ny: 180 / degPerPx,
      };
    },
  };
}

/** Wrap a global mercator/geographic pixel column into range (handles the antimeridian). */
export function wrapPixelX(px, nx) {
  return ((px % nx) + nx) % nx;
}

/** Decode a Terrarium-encoded RGB pixel to metres. */
export function decodeTerrarium(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}
