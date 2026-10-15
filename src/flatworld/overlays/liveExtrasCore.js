/**
 * Pure helpers for the flat world's extra live data (no three.js / Cesium imports, so they run
 * under node:test). See liveExtras.js.
 */
const KNOT = 0.514444;
const DEG = Math.PI / 180;

/**
 * Digitraffic GeoJSON locations (+ optional vessel metadata by MMSI) → live-overlay rows.
 * Drops fixes older than `maxAgeMs` and MMSIs in `skipMmsi`.
 */
export function digitrafficRows(
  geojson,
  meta = new Map(),
  { now = Date.now(), maxAgeMs = 30 * 60 * 1000, skipMmsi = new Set() } = {},
) {
  const out = [];
  for (const f of geojson?.features ?? []) {
    const c = f?.geometry?.coordinates;
    const p = f?.properties ?? {};
    const mmsi = f?.mmsi ?? p.mmsi;
    if (!Array.isArray(c) || !Number.isFinite(mmsi)) continue;
    const [lon, lat] = c;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (
      Number.isFinite(p.timestampExternal) &&
      now - p.timestampExternal > maxAgeMs
    )
      continue;
    if (skipMmsi.has(String(mmsi))) continue;
    const sog = Number.isFinite(p.sog) && p.sog < 102.3 ? p.sog : null;
    const cog = Number.isFinite(p.cog) && p.cog < 360 ? p.cog : null;
    const hdg =
      Number.isFinite(p.heading) && p.heading < 360 ? p.heading : null;
    const m = meta.get(mmsi);
    out.push({
      id: String(mmsi),
      label: (m?.name || '').trim() || `MMSI ${mmsi}`,
      lat,
      lon,
      altitudeM: 0,
      heading: sog !== null && sog > 0.5 && cog !== null ? cog : (hdg ?? cog),
      speedMps: sog === null ? null : sog * KNOT,
      onGround: false,
      source: 'Fintraffic Digitraffic AIS',
      shipType: m?.shipType ?? null,
      destination: (m?.destination || '').trim() || null,
    });
  }
  return out;
}

/**
 * Split flight rows the flights feed flags as military out of the civil list, and drop civil rows
 * whose id the military feed already has. Returns `{ civil, militaryExtra }`.
 */
export function splitMilitary(flightRows, militaryFlagIds, militaryIds) {
  const civil = [];
  const militaryExtra = [];
  for (const r of flightRows) {
    if (militaryIds.has(r.id)) continue;
    if (militaryFlagIds.has(r.id)) militaryExtra.push(r);
    else civil.push(r);
  }
  return { civil, militaryExtra };
}

function segLenM([lon1, lat1], [lon2, lat2]) {
  const y = (lat2 - lat1) * DEG * 6371000;
  const x = (lon2 - lon1) * DEG * 6371000 * Math.cos(((lat1 + lat2) / 2) * DEG);
  return Math.hypot(x, y);
}

/**
 * Advance a simulated vehicle `travelM` metres along `coords` ([lon, lat] polyline) from
 * (segIdx, t) in `direction` (±1). Returns the new state, or `{ done: true }` past either end.
 */
export function advanceAlong(coords, state, travelM) {
  let { segIdx, t } = state;
  const dir = state.direction;
  const n = coords.length - 1;
  if (n < 1) return { ...state, done: true };
  while (travelM > 0) {
    const len = Math.max(0.001, segLenM(coords[segIdx], coords[segIdx + 1]));
    const avail = (dir > 0 ? 1 - t : t) * len;
    if (travelM < avail) {
      t += (travelM / len) * dir;
      break;
    }
    travelM -= avail;
    const next = segIdx + dir;
    if (next < 0 || next >= n)
      return { ...state, segIdx, t: dir > 0 ? 1 : 0, done: true };
    segIdx = next;
    t = dir > 0 ? 0 : 1;
  }
  const a = coords[segIdx];
  const b = coords[segIdx + 1];
  return {
    ...state,
    segIdx,
    t,
    lon: a[0] + (b[0] - a[0]) * t,
    lat: a[1] + (b[1] - a[1]) * t,
    heading:
      (Math.atan2(
        (b[0] - a[0]) * Math.cos(a[1] * DEG) * dir,
        (b[1] - a[1]) * dir,
      ) /
        DEG +
        360) %
      360,
    done: false,
  };
}

/** Cruising speed (m/s) by OpenMapTiles road class. */
const ROAD_SPEED = {
  motorway: 27,
  trunk: 22,
  primary: 15,
  secondary: 13,
  tertiary: 11,
  minor: 8,
  service: 5,
};

/**
 * Place simulated vehicles on roads ([lon, lat] polylines from OpenFreeMap): about one per 150 m
 * of road (more on bigger roads), deterministic for a given seed, at most `max` in total.
 */
export function spawnVehicles(roads, { max = 3000, seed = 1 } = {}) {
  let r = (seed * 2654435761) >>> 0 || 1;
  const rand = () => {
    r ^= r << 13;
    r ^= r >>> 17;
    r ^= r << 5;
    return (r >>> 0) / 4294967296;
  };
  const cars = [];
  roads.forEach((road, ri) => {
    const coords = road?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return;
    let len = 0;
    for (let i = 0; i < coords.length - 1; i++)
      len += segLenM(coords[i], coords[i + 1]);
    const cls = road.roadClass || 'minor';
    const spacing =
      cls === 'motorway' || cls === 'trunk'
        ? 90
        : cls === 'primary'
          ? 120
          : 160;
    const n = Math.floor(len / spacing + rand());
    for (let j = 0; j < n; j++) {
      const direction = road.oneway ? 1 : rand() < 0.5 ? 1 : -1;
      const start = { segIdx: 0, t: 0, direction: 1 };
      const placed = advanceAlong(coords, start, rand() * len);
      if (placed.done) continue;
      cars.push({
        ...placed,
        direction,
        id: `${ri}:${j}`,
        coords,
        mps: (ROAD_SPEED[cls] ?? 8) * (0.75 + rand() * 0.4),
        roadClass: cls,
        roadName: road.roadProperties?.name || null,
      });
    }
  });
  if (cars.length <= max) return cars;
  // Thin evenly rather than keeping only the first roads in the tile.
  const step = cars.length / max;
  return Array.from({ length: max }, (_, i) => cars[Math.floor(i * step)]);
}
