/**
 * Sun and moon positions for the flat-world view.
 *
 * Position (RA/dec, sidereal time, phase) is real ephemeris data from astronomy-engine.
 * Height above the plane is a model setting, not data.
 */
import {
  Body,
  GeoVector,
  EquatorFromVector,
  Rotation_EQJ_EQD,
  RotateVector,
  SiderealTime,
  MoonPhase,
  Illumination,
  MakeTime,
} from '../vendor/astronomy-engine/astronomy.js';

const DEG = Math.PI / 180;
export const OBLIQUITY_DEG = 23.44;
export const HEIGHT_MODES = ['coil', 'constant', 'rowbotham'];
export const COIL_BASE_KM = 4828;
export const COIL_SWING_KM = 1000;
export const CONSTANT_KM = 4828;
export const ROWBOTHAM_KM = 1127;
export const MOON_BELOW_SUN_KM = 300;
export const BODY_DIAMETER_KM = 51;

export function wrap180(deg) {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/** Geocentric RA (hours) and dec (deg) of date for a body. */
export function equatorOfDate(body, date) {
  const time = MakeTime(date);
  const v = RotateVector(Rotation_EQJ_EQD(time), GeoVector(body, time, true));
  const eq = EquatorFromVector(v);
  return { ra: eq.ra, dec: eq.dec, time };
}

/** Sub-body point on the Earth: lat = dec, lon = wrap180((RA − GST) × 15). */
export function subBodyPoint(body, date) {
  const { ra, dec, time } = equatorOfDate(body, date);
  const gst = SiderealTime(time);
  return { lat: dec, lon: wrap180((ra - gst) * 15), ra, dec, gst };
}

/** Model height in km for a given declination and height mode. */
export function sunHeightKm(decDeg, mode = 'coil') {
  if (mode === 'constant') return CONSTANT_KM;
  if (mode === 'rowbotham') return ROWBOTHAM_KM;
  return COIL_BASE_KM - COIL_SWING_KM * (decDeg / OBLIQUITY_DEG);
}

export function moonHeightKm(sunDecDeg, mode = 'coil') {
  return sunHeightKm(sunDecDeg, mode) - MOON_BELOW_SUN_KM;
}

/** sin(altitude) of the sun at (lat, lon) given the sub-solar point. */
export function sinSolarAltitude(latDeg, lonDeg, sub) {
  const la = latDeg * DEG;
  const de = sub.lat * DEG;
  return (
    Math.sin(la) * Math.sin(de) +
    Math.cos(la) * Math.cos(de) * Math.cos((lonDeg - sub.lon) * DEG)
  );
}

export function solarAltitudeDeg(latDeg, lonDeg, sub) {
  return (
    Math.asin(
      Math.max(-1, Math.min(1, sinSolarAltitude(latDeg, lonDeg, sub))),
    ) / DEG
  );
}

/** Day starts at −0.833°; twilight bands at −6, −12, −18. */
export const TWILIGHT_EDGES_DEG = [-0.833, -6, -12, -18];

export function dayState(altDeg) {
  if (altDeg > TWILIGHT_EDGES_DEG[0]) return 'day';
  if (altDeg > TWILIGHT_EDGES_DEG[1]) return 'civil twilight';
  if (altDeg > TWILIGHT_EDGES_DEG[2]) return 'nautical twilight';
  if (altDeg > TWILIGHT_EDGES_DEG[3]) return 'astronomical twilight';
  return 'night';
}

export function seasonLabel(decDeg, trendingUp) {
  if (Math.abs(decDeg) < 1.5)
    return trendingUp ? 'March equinox' : 'September equinox';
  if (decDeg > 22) return 'June solstice';
  if (decDeg < -22) return 'December solstice';
  const tail = trendingUp ? 'rising' : 'falling';
  return decDeg > 0
    ? `northern spring/summer, sun ${tail}`
    : `northern autumn/winter, sun ${tail}`;
}

export function moonPhaseName(phaseDeg) {
  const p = ((phaseDeg % 360) + 360) % 360;
  const names = [
    'new moon',
    'waxing crescent',
    'first quarter',
    'waxing gibbous',
    'full moon',
    'waning gibbous',
    'last quarter',
    'waning crescent',
  ];
  return names[Math.round(p / 45) % 8];
}

/**
 * Full state for one instant. `frame` is the world frame (geodeticToWorld in display metres).
 * Heights are model settings; positions are projected with the same function as planes and ships.
 */
export function skyState(
  date,
  frame,
  { mode = 'coil', moonPlace = 'dark' } = {},
) {
  const sun = subBodyPoint(Body.Sun, date);
  const realMoon = subBodyPoint(Body.Moon, date);
  // 'dark' (default) is a model choice: the moon sits on the night side, opposite the sun in
  // longitude, at its real declination. 'real' keeps the true ephemeris position.
  const moon =
    moonPlace === 'real'
      ? realMoon
      : {
          ...realMoon,
          lon: wrap180(sun.lon + 180),
          realLat: realMoon.lat,
          realLon: realMoon.lon,
        };
  const sunAhead = subBodyPoint(Body.Sun, new Date(date.getTime() + 86400000));
  const sunH = sunHeightKm(sun.dec, mode) * 1000;
  const moonH = moonHeightKm(sun.dec, mode) * 1000;
  const sw = frame.geodeticToWorld(sun.lat, sun.lon, sunH);
  const mw = frame.geodeticToWorld(moon.lat, moon.lon, moonH);
  const phaseDeg = MoonPhase(date);
  const illum = Illumination(Body.Moon, date);
  return {
    date,
    mode,
    moonPlace,
    sun: { ...sun, heightM: sunH, world: sw, radiusM: Math.hypot(sw.x, sw.y) },
    moon: {
      ...moon,
      heightM: moonH,
      world: mw,
      radiusM: Math.hypot(mw.x, mw.y),
      phaseDeg,
      phaseName: moonPhaseName(phaseDeg),
      illuminatedFraction: illum.phase_fraction,
    },
    season: seasonLabel(sun.dec, sunAhead.dec > sun.dec),
  };
}
