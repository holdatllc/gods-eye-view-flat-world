/**
 * Data sources for the flat world. All are keyless and openly licensed or used under the same
 * terms the globe already uses them with. Attribution strings are shown in the flat-world UI.
 */
import { geographicScheme, webMercatorScheme } from './tileSchemes.js';

export const FLATWORLD_DATA_BASE = '/flatworld-data';
export const LOCAL_GIBS_MAX_Z = 5;

export const IMAGERY_SOURCES = Object.freeze({
  esri: {
    id: 'esri',
    label: 'Esri World Imagery',
    // z20 like the globe's Esri layer (where Esri has no z20 tile its grey placeholder is
    // detected and the next zoom out is used).
    scheme: webMercatorScheme({ tileSize: 256, maxZoom: 20 }),
    // Esri serves HTTP/1.1, so browsers allow only six connections per host; the same public
    // service is reachable on two hostnames, which doubles tile throughput.
    url: (z, x, y) =>
      `https://${(x + y) % 2 ? 'server' : 'services'}.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    attribution:
      'Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    format: 'rgba',
  },
  gibsBlueMarble: {
    id: 'gibsBlueMarble',
    label: 'NASA Blue Marble Next Generation (GIBS)',
    scheme: geographicScheme({ tileSize: 512, maxZoom: 7, rootSpanDeg: 288 }),
    // Levels 0–5 stream from the local mirror (tools/flatworld/mirror_gibs.py); 6–7 from GIBS.
    url: (z, x, y) =>
      z <= LOCAL_GIBS_MAX_Z
        ? `${FLATWORLD_DATA_BASE}/gibs/BlueMarble_NextGeneration/${z}/${x}/${y}.jpeg`
        : `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_NextGeneration/default/2004-08-01/500m/${z}/${y}/${x}.jpeg`,
    attribution:
      'Polar imagery: NASA Earth Observatory Blue Marble NG via NASA GIBS (public domain)',
    format: 'rgba',
  },
  modisArctic: {
    id: 'modisArctic',
    label: 'NASA MODIS Terra true colour, 2026-07-20 (Arctic cap, GIBS)',
    // Only the northern cap (north of ~84°) is mirrored locally (tools/flatworld/mirror_gibs.py).
    scheme: geographicScheme({
      tileSize: 512,
      maxZoom: LOCAL_GIBS_MAX_Z,
      rootSpanDeg: 288,
    }),
    url: (z, x, y) =>
      `${FLATWORLD_DATA_BASE}/gibs/MODIS_Terra_CorrectedReflectance_TrueColor/${z}/${x}/${y}.jpg`,
    attribution:
      'Arctic cap imagery: NASA MODIS Terra corrected reflectance, 20 July 2026, via NASA GIBS (public domain)',
    format: 'rgba',
  },
  gibsBlackMarble: {
    id: 'gibsBlackMarble',
    label: 'NASA Black Marble 2016 night lights (GIBS)',
    // Night lights are only needed at regional scale: served entirely from the local mirror.
    scheme: geographicScheme({
      tileSize: 512,
      maxZoom: LOCAL_GIBS_MAX_Z,
      rootSpanDeg: 288,
    }),
    url: (z, x, y) =>
      `${FLATWORLD_DATA_BASE}/gibs/VIIRS_Black_Marble/${z}/${x}/${y}.png`,
    attribution:
      'Night lights: NASA Earth Observatory Black Marble 2016 (VIIRS) via NASA GIBS (public domain)',
    format: 'rgba',
  },
});

export const ELEVATION_SOURCES = Object.freeze({
  mapterhorn: {
    id: 'mapterhorn',
    label: 'Mapterhorn terrain',
    scheme: webMercatorScheme({ tileSize: 512, maxZoom: 15 }),
    url: (z, x, y) => `https://tiles.mapterhorn.com/${z}/${x}/${y}.webp`,
    attribution:
      'Terrain: © Mapterhorn (Copernicus GLO-30 and national DEMs), CC BY 4.0',
    format: 'terrarium',
  },
  etopo: {
    id: 'etopo',
    label: 'NOAA ETOPO 2022 (ice surface, bathymetry)',
    // Local pyramid built by tools/flatworld/build_etopo_tiles.py: level 0 = 2×1 tiles of 180°.
    scheme: geographicScheme({ tileSize: 256, maxZoom: 5, rootSpanDeg: 180 }),
    url: (z, x, y) => `${FLATWORLD_DATA_BASE}/etopo/${z}/${x}/${y}.png`,
    attribution:
      'Bathymetry and polar ice surface: NOAA NCEI ETOPO 2022 (public domain)',
    format: 'terrarium',
  },
});

export const VECTOR_SOURCES = Object.freeze({
  openfreemap: {
    id: 'openfreemap',
    label: 'OpenFreeMap (OpenStreetMap)',
    tileJson: 'https://tiles.openfreemap.org/planet',
    maxZoom: 14,
    attribution:
      'Buildings and roads: © OpenStreetMap contributors (ODbL) via OpenFreeMap / OpenMapTiles',
  },
});

/** Natural Earth coastlines/borders bundled with the app (drawn by overlays/vectorLines.js). */
export const NATURAL_EARTH_ATTRIBUTION =
  'Coastlines and borders: Made with Natural Earth (public domain)';

export function allAttributions() {
  return [
    ...Object.values(IMAGERY_SOURCES),
    ...Object.values(ELEVATION_SOURCES),
    ...Object.values(VECTOR_SOURCES),
  ]
    .map((s) => s.attribution)
    .concat(NATURAL_EARTH_ATTRIBUTION);
}

/**
 * Compact, always-visible credit line for the flat world (the globe's Cesium credit bar is hidden
 * while it is shown). Links point at each provider's own attribution or licence page.
 */
export function attributionHtml() {
  const link = (href, text) =>
    `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  return [
    `Powered by ${link('https://www.esri.com/', 'Esri')}: Esri, Maxar, Earthstar Geographics, and the GIS User Community`,
    `Terrain ${link('https://mapterhorn.com/attribution', '© Mapterhorn')} (${link('https://creativecommons.org/licenses/by/4.0/', 'CC BY 4.0')})`,
    `${link('https://www.ncei.noaa.gov/products/etopo-global-relief-model', 'NOAA ETOPO 2022')}`,
    `NASA ${link('https://earthdata.nasa.gov/gibs', 'GIBS')} Blue/Black Marble, MODIS`,
    `${link('https://www.openstreetmap.org/copyright', '© OpenStreetMap contributors')} via ${link('https://openfreemap.org/', 'OpenFreeMap')}`,
    `${link('https://www.naturalearthdata.com/', 'Natural Earth')}`,
  ].join(' · ');
}
