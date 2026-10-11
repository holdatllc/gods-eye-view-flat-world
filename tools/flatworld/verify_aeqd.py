#!/usr/bin/env python3
"""Independent audit of app/src/flatworld/projection/aeqd.js and domains.js.

References:
  - PROJ (via pyproj Transformer) EPSG:4326 -> '+proj=aeqd +lat_0=90 +lon_0=0 +datum=WGS84 +units=m +no_defs'
  - PROJ Proj.get_factors for scale factors
  - GeographicLib Geodesic.WGS84 for meridian / geodesic distances

The JS module is evaluated by tools/flatworld/aeqd_dump.mjs (imported by absolute file URL).
Run:  source env.sh && pyenv/bin/python tools/flatworld/verify_aeqd.py
Writes program/evidence/B-aeqd-proj-verification.txt and program/evidence/B-reference-routes.json.
"""
import io
import json
import math
import os
import re
import subprocess
import sys

import numpy as np
from geographiclib.geodesic import Geodesic
from pyproj import Proj, Transformer
import pyproj

ROOT = os.environ.get('GEI_ROOT', os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..')))
HELPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'aeqd_dump.mjs')
EVID = os.path.join(ROOT, 'program/evidence')
NODE = os.environ.get('NODE', 'node')
PROJ_STR = '+proj=aeqd +lat_0=90 +lon_0=0 +datum=WGS84 +units=m +no_defs'

FWD_TOL_M = 1e-3          # pass: forward <= 1 mm
INV_TOL_DEG = 1e-9        # pass: inverse <= 1e-9 deg away from poles
POLE_BAND_DEG = 89.999    # "away from the poles" = |lat| <= 89.999 (pole band ~111 m)

T = Transformer.from_crs('EPSG:4326', PROJ_STR, always_xy=True)
G = Geodesic.WGS84
A_WGS = 6378137.0
F_WGS = 1 / 298.257223563
E2 = F_WGS * (2 - F_WGS)

out = io.StringIO()
verdicts = []


def log(*a):
    s = re.sub(r'np\.float64\(([^()]*)\)', r'\1', ' '.join(str(x) for x in a))
    print(s)
    out.write(s + '\n')


def verdict(name, ok, detail):
    verdicts.append((name, ok, detail))
    log(f'  [{"PASS" if ok else "FAIL"}] {name}: {detail}')


def enc(v):
    v = float(v)
    if math.isnan(v):
        return 'NaN'
    if math.isinf(v):
        return 'Infinity' if v > 0 else '-Infinity'
    return v


def dec(v):
    if isinstance(v, str):
        return float(v.replace('Infinity', 'inf'))
    return float(v) if v is not None else float('nan')


def js(reqs):
    p = subprocess.run([NODE, HELPER], input=json.dumps(reqs).encode(), capture_output=True, check=False)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.decode())
    return json.loads(p.stdout)


def js_forward(lat, lon):
    r = js([{'op': 'forward', 'lat': [enc(v) for v in lat], 'lon': [enc(v) for v in lon]}])[0]
    return (np.array([dec(v) for v in r['x']]), np.array([dec(v) for v in r['y']]), np.array([dec(v) for v in r['rho']]))


def js_inverse(x, y):
    r = js([{'op': 'inverse', 'x': [enc(v) for v in x], 'y': [enc(v) for v in y]}])[0]
    return (np.array([dec(v) for v in r['lat']]), np.array([dec(v) for v in r['lon']]), r['domain'], np.array([dec(v) for v in r['rho']]))


def wrap180(d):
    return (np.asarray(d) + 180.0) % 360.0 - 180.0


def stats(a):
    a = np.asarray(a)
    a = a[np.isfinite(a)]
    if a.size == 0:
        return 'n=0'
    return (f'n={a.size}  p50={np.percentile(a,50):.3e}  p99={np.percentile(a,99):.3e}  '
            f'p99.9={np.percentile(a,99.9):.3e}  max={a.max():.3e}')


def N_of(lat_deg):
    s = np.sin(np.radians(lat_deg))
    return A_WGS / np.sqrt(1 - E2 * s * s)


def M_of(lat_deg):
    s = np.sin(np.radians(lat_deg))
    return A_WGS * (1 - E2) / (1 - E2 * s * s) ** 1.5


def pos_err_m(lat_ref, lon_ref, lat, lon):
    """Local-metric horizontal error in metres (valid for tiny errors); handles lon wrap and the pole."""
    dlat = np.radians(lat - lat_ref) * M_of(lat_ref)
    dlon = np.radians(wrap180(lon - lon_ref)) * N_of(lat_ref) * np.cos(np.radians(lat_ref))
    return np.hypot(dlat, dlon)


def main():
    log('=' * 78)
    log('B: polar AEQD audit -- app/src/flatworld/projection/{aeqd,domains}.js vs PROJ / GeographicLib')
    log(f'pyproj {pyproj.__version__}  PROJ {pyproj.proj_version_str}  numpy {np.__version__}')
    node_v = subprocess.run([NODE, '-v'], capture_output=True).stdout.decode().strip()
    log(f'node {node_v}   reference CRS: {PROJ_STR}')
    log(f'thresholds: forward <= {FWD_TOL_M*1e3:g} mm; inverse <= {INV_TOL_DEG:g} deg for |lat| <= {POLE_BAND_DEG}')
    log('=' * 78)

    const = js([{'op': 'constants'}])[0]
    Q, R = const['quarterMeridian'], const['southPoleRadius']
    from fractions import Fraction
    TOL_M = const.get('boundaryTolerance', 1e-6)
    TIE_M = 1e-8  # |exact rho - (R + 1e-6)| below this is a floating-point tie (ulp of R is 3.7e-9 m)
    FR = Fraction(R)

    def exact_over(x, y):
        """exact (rational) rho - R for float x, y, returned as float metres; rho via exact x^2+y^2 then sqrt bracketing."""
        v = Fraction(x) ** 2 + Fraction(y) ** 2
        # rho - R = (v - R^2) / (rho + R); rho + R approximated in float is plenty (relative 1e-16 of a tiny number)
        return float((v - FR * FR) / (Fraction(math.sqrt(float(v))) + FR))

    log('\n## 0. Constants')
    q_ref = G.Inverse(90, 0, 0, 0)['s12']
    r_ref = G.Inverse(90, 0, -90, 0, Geodesic.STANDARD)['s12']
    _, y_sp = T.transform(0.0, -90.0)
    log(f'  JS quarterMeridian = {Q:.6f}  GeographicLib = {q_ref:.6f}  diff = {Q-q_ref:.3e} m')
    log(f'  JS southPoleRadius = {R:.6f}  GeographicLib = {r_ref:.6f}  PROJ |y(S pole)| = {abs(y_sp):.6f}')
    log(f'  JS proj4 string: {const["proj4"]}')
    log(f'  BOUNDARY_TOLERANCE_M = {const.get("boundaryTolerance")}  isBeyondSouthPole exported: {const.get("hasIsBeyond")}  '
        f'GLEASON_DISPLAY_ROTATION_DEG = {const.get("defaultRotation")}')
    verdict('quarter meridian vs GeographicLib', abs(Q - q_ref) < 1e-6, f'{abs(Q-q_ref):.3e} m')
    verdict('south-pole radius vs PROJ', abs(R - abs(y_sp)) < 1e-6, f'{abs(R-abs(y_sp)):.3e} m')

    # ------------------------------------------------------------------ forward
    log('\n## 1. Forward vs PROJ')
    rng = np.random.default_rng(20261010)
    glat, glon = np.meshgrid(np.arange(-90, 90.0001, 0.25), np.arange(-180, 180, 0.25), indexing='ij')
    glat, glon = glat.ravel(), glon.ravel()
    nr = 300_000
    rlat = np.degrees(np.arcsin(rng.uniform(-1, 1, nr)))
    rlon = rng.uniform(-180, 180, nr)
    lat = np.concatenate([glat, rlat])
    lon = np.concatenate([glon, rlon])
    px, py = T.transform(lon, lat)
    jx, jy, jrho = js_forward(lat, lon)
    ferr = np.hypot(jx - px, jy - py)
    log(f'  0.25-degree grid ({glat.size} pts) + {nr} seeded random (seed 20261010), total {lat.size}')
    log(f'  forward |dxy| m: {stats(ferr)}')
    i = int(np.nanargmax(ferr))
    log(f'  worst at lat={lat[i]!r} lon={lon[i]!r}: JS=({jx[i]!r},{jy[i]!r}) PROJ=({px[i]!r},{py[i]!r})')
    # also rho vs geodesic distance from the North Pole (exact definition of polar AEQD)
    verdict('forward dense grid+random <= 1 mm', np.nanmax(ferr) <= FWD_TOL_M and np.all(np.isfinite(ferr)),
            f'max {np.nanmax(ferr):.3e} m')
    fwd_max = float(np.nanmax(ferr))

    log('\n### 1b. Forward edge cases (JS vs PROJ)')
    edge = [
        (90, 0), (90, 123.4), (90, -180), (90 - 1e-9, 0), (90 - 1e-9, 77), (89.9999999, 45), (89.9999999, -135),
        (-90, 0), (-90, 90), (-90, 180), (-90, -180), (-90, -45.5), (-90, 540),
        (-90 + 1e-9, 0), (-90 + 1e-9, 111), (-89.9999999, 30), (-89.9999999, -170),
        (0, 180), (0, -180), (0, 179.9999999), (0, -179.9999999), (45, 180), (45, -180),
        (45, 179.9999999), (45, -179.9999999), (-60, 540), (-60, -190), (10, 540), (10, -190), (10, 900), (10, -720.5),
        (0, 0), (0, 90), (0, -90), (0, 45.123456789),
    ]
    elat = np.array([e[0] for e in edge], float)
    elon = np.array([e[1] for e in edge], float)
    ex, ey = T.transform(elon, elat)
    proj_refused = ~np.isfinite(ex)
    if proj_refused.any():
        # PROJ refuses |lon| beyond its own limit (returns inf); compare against PROJ on the wrapped longitude instead
        ex[proj_refused], ey[proj_refused] = T.transform(wrap180(elon[proj_refused]), elat[proj_refused])
    jx2, jy2, jr2 = js_forward(elat, elon)
    e_err = np.hypot(jx2 - ex, jy2 - ey)
    log(f'  {"lat":>16} {"lon":>16} {"JS x":>18} {"JS y":>18} {"PROJ x":>18} {"PROJ y":>18} {"|d| m":>10}')
    for k in range(len(edge)):
        log(f'  {elat[k]!r:>16} {elon[k]!r:>16} {jx2[k]:18.9f} {jy2[k]:18.9f} {ex[k]:18.9f} {ey[k]:18.9f} {e_err[k]:10.2e}')
    for k in np.where(proj_refused)[0]:
        log(f'  note: PROJ returned inf for lon={elon[k]!r} (outside PROJ input range); compared against PROJ at wrapped lon {wrap180(elon[k])!r}')
    verdict('forward edge cases <= 1 mm', np.all(e_err <= FWD_TOL_M), f'max {e_err.max():.3e} m')
    fwd_edge_max = float(e_err.max())

    log('\n### 1c. Invalid inputs (JS must return NaN; PROJ behaviour shown for reference)')
    bad = [(float('nan'), 0), (0, float('nan')), (float('inf'), 0), (-float('inf'), 0), (0, float('inf')),
           (90.0000001, 0), (-90.0000001, 0), (91, 0), (-91, 10), (180, 0), (1e308, 0)]
    blat = np.array([b[0] for b in bad]); blon = np.array([b[1] for b in bad])
    bx, by = T.transform(blon, blat)
    jbx, jby, jbr = js_forward(blat, blon)
    ok_bad = True
    for k, (la, lo) in enumerate(bad):
        isnan = math.isnan(jbx[k]) and math.isnan(jby[k]) and math.isnan(jbr[k])
        ok_bad &= isnan
        log(f'  lat={la!r:>14} lon={lo!r:>6}  JS=({jbx[k]!r},{jby[k]!r},rho={jbr[k]!r})  PROJ=({bx[k]!r},{by[k]!r})')
    verdict('invalid inputs -> NaN', ok_bad, 'all NaN' if ok_bad else 'some returned numbers')

    # ------------------------------------------------------------------ inverse
    log('\n## 2. Inverse vs PROJ')
    # (a) plane points = PROJ forward of the grid/random set; (b) uniform-in-area random disk points
    nd = 300_000
    rr = R * np.sqrt(rng.uniform(0, 1, nd))
    th = rng.uniform(-np.pi, np.pi, nd)
    ix = np.concatenate([px, rr * np.sin(th)])
    iy = np.concatenate([py, -rr * np.cos(th)])
    plon, plat = T.transform(ix, iy, direction='INVERSE')
    jlat, jlon, jdom, _ = js_inverse(ix, iy)
    gps_all = np.array([d == 'gps' for d in jdom])
    log(f'  {ix.size} plane points ({px.size} from PROJ-forward of section-1 set, {nd} uniform-area disk)')
    log(f'  JS domain counts: gps={gps_all.sum()} other={(~gps_all).sum()}')
    dlat = np.abs(jlat - plat)
    dlon = np.abs(wrap180(jlon - plon))
    away = np.abs(plat) <= POLE_BAND_DEG
    log(f'  |dlat| deg (all):               {stats(dlat)}')
    log(f'  |dlon| deg (|lat|<={POLE_BAND_DEG}):     {stats(dlon[away])}')
    log(f'  |dlon| deg (pole band, info):   {stats(dlon[~away])}')
    perr = pos_err_m(plat, plon, jlat, jlon)
    log(f'  horizontal position error m (all, local metric, pole-safe): {stats(perr)}')
    inv_max_away = float(max(np.nanmax(dlat[away]), np.nanmax(dlon[away])))
    i = int(np.nanargmax(np.where(away, np.maximum(dlat, dlon), -1)))
    log(f'  worst (away from poles) at x={ix[i]!r} y={iy[i]!r}: JS=({jlat[i]!r},{jlon[i]!r}) PROJ=({plat[i]!r},{plon[i]!r})')
    verdict('inverse vs PROJ <= 1e-9 deg away from poles', gps_all.all() and inv_max_away <= INV_TOL_DEG,
            f'max {inv_max_away:.3e} deg; all-points dlat max {np.nanmax(dlat):.3e} deg; pos err max {np.nanmax(perr):.3e} m')
    inv_pos_max = float(np.nanmax(perr))

    # round trip of the JS module itself
    rlat2, rlon2, rdom, _ = js_inverse(jx, jy)
    rt_lat = np.abs(rlat2 - lat)
    rt_lon = np.abs(wrap180(rlon2 - lon))
    away1 = np.abs(lat) <= POLE_BAND_DEG
    rt_max = float(max(rt_lat.max(), rt_lon[away1].max()))
    log(f'  JS round trip forward->inverse: |dlat| {stats(rt_lat)}')
    log(f'                                  |dlon| (away) {stats(rt_lon[away1])}')
    log(f'                                  pos err m (all) {stats(pos_err_m(lat, lon, rlat2, rlon2))}')
    verdict('JS self round trip <= 1e-9 deg away from poles', rt_max <= INV_TOL_DEG and all(d == 'gps' for d in rdom),
            f'max {rt_max:.3e} deg')

    log('\n### 2b. Inverse at and around the South-Pole circle (rho = R + delta), several bearings')
    log(f'  contract: ice iff exact rho > R + {TOL_M:g} m; gps points with rho in (R, R+{TOL_M:g}] must invert to lat -90 within 1e-9 deg')
    TF = R + TOL_M  # float threshold used by the JS
    deltas = [-1.0, -1e-3, -1e-6, -1e-9, 0.0, 'R+1ulp', 1e-9, 1e-7, 5e-7, 'T-1ulp', 'T', 'T+1ulp', 'T+2ulp', 1.000001e-6, 2e-6, 1e-3, 1.0, R, 2 * R]
    bearings = [0.0, 37.0, 90.0, 180.0, -123.4]
    rows = []
    for b_ in bearings:
        for d in deltas:
            if d == 'R+1ulp':
                r = np.nextafter(R, np.inf)
            elif isinstance(d, str):
                r = {'T-1ulp': np.nextafter(TF, 0), 'T': TF, 'T+1ulp': np.nextafter(TF, np.inf),
                     'T+2ulp': np.nextafter(np.nextafter(TF, np.inf), np.inf)}[d]
            else:
                r = R + d
            x, y = r * math.sin(math.radians(b_)), -r * math.cos(math.radians(b_))
            rows.append((b_, d, x, y, math.hypot(x, y)))
    bx_ = np.array([r[2] for r in rows]); by_ = np.array([r[3] for r in rows])
    blon_p, blat_p = T.transform(bx_, by_, direction='INVERSE')
    blat_j, blon_j, bdom_j, brho_j = js_inverse(bx_, by_)
    log(f'  {"bear":>6} {"delta":>12} {"exact rho-R m":>14} {"JS domain":>9} {"JS lat":>20} {"JS lon":>20} {"PROJ lat":>22}')
    band_bad, ice_bad, gps_bad, ties = [], [], [], 0
    for k, (b_, d, x, y, h) in enumerate(rows):
        ov = exact_over(x, y)
        log(f'  {b_:6.1f} {str(d):>12} {ov:14.6e} {bdom_j[k]:>9} {blat_j[k]!r:>20} {blon_j[k]!r:>20} {blat_p[k]!r:>22}')
        if abs(ov - TOL_M) < TIE_M:
            ties += 1
            if bdom_j[k] == 'gps' and abs(blat_j[k] + 90) > INV_TOL_DEG:
                band_bad.append((x, y, ov, blat_j[k]))
            continue
        if ov > TOL_M and not (bdom_j[k] == 'ice' and math.isnan(blat_j[k]) and math.isnan(blon_j[k])):
            ice_bad.append((x, y, ov, bdom_j[k]))
        if ov <= TOL_M and bdom_j[k] != 'gps':
            gps_bad.append((x, y, ov, bdom_j[k]))
        if 0 < ov <= TOL_M and bdom_j[k] == 'gps' and not abs(blat_j[k] + 90) <= INV_TOL_DEG:
            band_bad.append((x, y, ov, blat_j[k]))
    log('  PROJ behaviour: beyond the circle PROJ does not error; it returns latitudes < -90 (e.g. -270 at 2R).')
    log(f'  info: {ties} rows within {TIE_M:g} m of the exact threshold R+1e-6 (float tie zone; either domain accepted, gps must be lat -90)')
    verdict('inverse: exact rho > R+1e-6 -> ice with NaN lat/lon', not ice_bad, f'{len(ice_bad)} violations' if ice_bad else 'ok')
    verdict('inverse: exact rho <= R+1e-6 -> gps', not gps_bad, f'{len(gps_bad)} violations' if gps_bad else 'ok')
    on_ok = all(bdom_j[k] == 'gps' and abs(blat_j[k] + 90.0) <= INV_TOL_DEG for k, r in enumerate(rows) if 0 <= exact_over(r[2], r[3]) <= TOL_M)
    verdict('inverse on/just beyond the circle (0 <= rho-R <= 1e-6) -> gps, |lat + 90| <= 1e-9 deg', on_ok and not band_bad, 'ok' if on_ok else 'violations')

    log('\n### 2c. Inverse invalid inputs')
    il, io_, idm, _ = js_inverse([float('nan'), 0, float('inf'), -float('inf'), 1e308], [0, float('nan'), 0, 0, 1e308])
    for k, (x, y) in enumerate([(float('nan'), 0), (0, float('nan')), (float('inf'), 0), (-float('inf'), 0), (1e308, 1e308)]):
        log(f'  inverse({x!r},{y!r}) -> domain={idm[k]} lat={il[k]!r} lon={io_[k]!r}')
    log('  note: inverse(Infinity, 0) is reported as domain "invalid", not "ice"; inverse(1e308,1e308) -> hypot=inf -> "ice".')

    # ------------------------------------------------------------------ scale factors
    log('\n## 3. Scale factors vs PROJ get_factors and an independent GeographicLib formula')
    p = Proj(PROJ_STR)
    slats = [89.999, 89.9, 89, 80, 60, 45, 30, 10, 0, -10, -30, -45, -60, -80, -89, -89.9, -89.999]
    sc = js([{'op': 'scale', 'lat': slats + [90, -90, 'NaN']}])[0]['items']
    log(f'  {"lat":>8} {"JS k":>20} {"PROJ parallel":>20} {"GLib rho/(N cos)":>20} {"rel d PROJ":>11} {"rel d GLib":>11} {"JS h":>4} {"PROJ merid":>16}')
    worst_k_proj = worst_k_glib = worst_h = 0
    for la, s in zip(slats, sc):
        f = p.get_factors(0.0, la)
        rho_g = G.Inverse(90, 0, la, 0)['s12']
        k_g = rho_g / (N_of(la) * math.cos(math.radians(la)))
        kj = dec(s['k'])
        r1 = abs(kj - f.parallel_scale) / k_g
        r2 = abs(kj - k_g) / k_g
        worst_k_proj = max(worst_k_proj, r1); worst_k_glib = max(worst_k_glib, r2)
        worst_h = max(worst_h, abs(dec(s['h']) - f.meridional_scale))
        log(f'  {la:8.3f} {kj:20.12f} {f.parallel_scale:20.12f} {k_g:20.12f} {r1:11.2e} {r2:11.2e} {dec(s["h"]):4g} {f.meridional_scale:16.12f}')
    for la, s in zip([90, -90, 'NaN'], sc[len(slats):]):
        log(f'  scaleFactors({la}) -> {s}')
    # Near-pole k: independent rho by Gauss-Legendre integration of the meridian radius M(t) from phi to 90 deg
    # (no cancellation), k = rho / (N cos phi). k must tend to 1 at the North Pole.
    gx, gw = np.polynomial.legendre.leggauss(40)

    def rho_quad(lat_deg):
        # integrate over colatitude c in [0, 90-lat] (90-lat is exact in floating point near the pole)
        cmax = math.radians(90.0 - lat_deg)
        c = 0.5 * cmax * (gx + 1.0)
        cs = np.cos(c)  # sin(phi) = cos(colat)
        return float(0.5 * cmax * np.sum(gw * A_WGS * (1 - E2) / (1 - E2 * cs * cs) ** 1.5))

    def k_ref(lat_deg):
        colat = math.radians(90.0 - lat_deg)
        n_ = A_WGS / math.sqrt(1 - E2 * math.cos(colat) ** 2)
        return rho_quad(lat_deg) / (n_ * math.sin(colat))

    np_lats = [89.99, 89.9999, 89.99999, 89.999999, 89.9999998, float(np.nextafter(90 - 1e-7, 0)), 90 - 1e-7,
               float(np.nextafter(90 - 1e-7, 90)), 89.999999999, 89.9999999999, float(np.nextafter(90, 0)), 90.0]
    sweep = list(90 - np.logspace(-7.5, -2, 400))  # dense sweep on both sides of the 1e-7 deg switch
    np_sc = js([{'op': 'scale', 'lat': np_lats + sweep + [100, -100, 90.5, -90.0000001, 'NaN', 'Infinity', -90, -89.9999999]}])[0]['items']
    worst_np = 0.0
    log('  near-North-Pole k (JS vs quadrature reference over colatitude):')
    for la, s_ in zip(np_lats, np_sc):
        kj = dec(s_['k'])
        kr = 1.0 if la == 90.0 else k_ref(la)
        worst_np = max(worst_np, abs(kj - kr))
        log(f'    lat={la!r:>20}  JS k={kj!r:<22} ref k={kr!r:<22} |d|={abs(kj-kr):.2e}')
    worst_sw, worst_sw_lat = 0.0, None
    for la, s_ in zip(sweep, np_sc[len(np_lats):len(np_lats) + len(sweep)]):
        d_ = abs(dec(s_['k']) - k_ref(la))
        if d_ > worst_sw:
            worst_sw, worst_sw_lat = d_, la
    log(f'    dense sweep 90-10^[-7.5..-2] deg ({len(sweep)} lats): max |dk| = {worst_sw:.2e} at lat {worst_sw_lat!r}')
    worst_np = max(worst_np, worst_sw)
    verdict('scaleFactors k near/at North Pole (|dk| <= 1e-6, k(90) = 1)', worst_np <= 1e-6, f'max |dk| {worst_np:.2e}')
    tail = np_sc[len(np_lats) + len(sweep):]
    names = [100, -100, 90.5, -90.0000001, 'NaN', 'Infinity', -90, -89.9999999]
    for la, s_ in zip(names, tail):
        log(f'    scaleFactors({la}) -> {s_}')
    oor_ok = all(s_['k'] == 'NaN' and s_['h'] == 'NaN' for s_ in tail[:6])
    verdict('scaleFactors rejects out-of-range / non-finite latitude (NaN)', oor_ok, 'ok' if oor_ok else 'returns numbers')
    sp_ok = tail[6]['k'] == 'Infinity' and isinstance(tail[7]['k'], (int, float)) and tail[7]['k'] > 1e8
    verdict('scaleFactors(-90) = Infinity, finite and huge just north of it', sp_ok, f"k(-90)={tail[6]['k']}, k(-89.9999999)={tail[7]['k']}")
    # verify GLib-based reference against quadrature too
    log(f'    quadrature vs GeographicLib rho at 45 deg: {abs(rho_quad(45) - G.Inverse(90,0,45,0)["s12"]):.2e} m')
    verdict('k vs GeographicLib-based rho/(N cos phi)', worst_k_glib < 1e-9, f'max rel {worst_k_glib:.2e}')
    verdict('k vs PROJ get_factors parallel_scale', worst_k_proj < 1e-8,
            f'max rel {worst_k_proj:.2e} (PROJ uses numerical differentiation)')
    verdict('h = 1 vs PROJ meridional_scale', worst_h < 1e-8, f'max |d| {worst_h:.2e}')

    # ------------------------------------------------------------------ meridians
    log('\n## 4. Plane distance along meridians vs GeographicLib geodesic distance')
    nm = 20000
    mlon = rng.uniform(-180, 180, nm)
    a1 = np.degrees(np.arcsin(rng.uniform(-1, 1, nm)))
    a2 = np.degrees(np.arcsin(rng.uniform(-1, 1, nm)))
    lat_hi, lat_lo = np.maximum(a1, a2), np.minimum(a1, a2)
    x1, y1, r1_ = js_forward(lat_hi, mlon)
    x2, y2, r2_ = js_forward(lat_lo, mlon)
    plane = np.hypot(x2 - x1, y2 - y1)
    geo = np.array([G.Inverse(lat_hi[k], mlon[k], lat_lo[k], mlon[k], Geodesic.DISTANCE)['s12'] for k in range(nm)])
    md = np.abs(plane - geo)
    log(f'  same-meridian pairs (n={nm}): |plane - geodesic| m: {stats(md)}')
    pole_d = np.array([G.Inverse(90, 0, lat_lo[k], mlon[k], Geodesic.DISTANCE)['s12'] for k in range(nm)])
    pdiff = np.abs(r2_ - pole_d)
    log(f'  rho vs geodesic distance from North Pole (n={nm}): {stats(pdiff)}')
    # trans-polar meridian pairs: (lat1, lon) & (lat2, lon+180), only where via-North-Pole is the shorter path
    sel = (lat_hi + lat_lo) > 1.0
    xb, yb, rb = js_forward(lat_lo[sel], mlon[sel] + 180)
    plane_tp = np.hypot(xb - x1[sel], yb - y1[sel])
    geo_tp = np.array([G.Inverse(h, lo, l, lo + 180, Geodesic.DISTANCE)['s12'] for h, l, lo in zip(lat_hi[sel], lat_lo[sel], mlon[sel])])
    tpd = np.abs(plane_tp - geo_tp)
    log(f'  trans-North-Pole meridian pairs (n={sel.sum()}): {stats(tpd)}')
    mer_max = float(max(md.max(), pdiff.max(), tpd.max()))
    verdict('meridian distances exact (<= 1e-6 m)', mer_max <= 1e-6, f'max {mer_max:.3e} m')

    # ------------------------------------------------------------------ city routes
    log('\n## 5. Reference routes: geodesic vs straight line on the plane')
    cities = {
        'London': (51.5074, -0.1278), 'New York': (40.7128, -74.0060),
        'Sydney': (-33.8688, 151.2093), 'Santiago': (-33.4489, -70.6693),
        'Tokyo': (35.6762, 139.6503), 'Los Angeles': (34.0522, -118.2437),
        'Johannesburg': (-26.2041, 28.0473), 'Perth': (-31.9505, 115.8605),
        'Reykjavik': (64.1466, -21.9426), 'Anchorage': (61.2181, -149.9003),
        'Cape Town': (-33.9249, 18.4241), 'Buenos Aires': (-34.6037, -58.3816),
    }
    pairs = [('London', 'New York'), ('Sydney', 'Santiago'), ('Tokyo', 'Los Angeles'), ('Johannesburg', 'Perth'),
             ('Reykjavik', 'Anchorage'), ('Cape Town', 'Buenos Aires')]
    routes = []
    log(f'  {"route":<28} {"geodesic km":>13} {"plane line km":>14} {"ratio":>8} {"geod. path on plane km":>23}')
    for a, b in pairs:
        (la1, lo1), (la2, lo2) = cities[a], cities[b]
        inv = G.Inverse(la1, lo1, la2, lo2)
        fx, fy, fr = js_forward(np.array([la1, la2]), np.array([lo1, lo2]))
        ppx, ppy = T.transform([lo1, lo2], [la1, la2])
        line = float(math.hypot(fx[1] - fx[0], fy[1] - fy[0]))
        line_proj = float(math.hypot(ppx[1] - ppx[0], ppy[1] - ppy[0]))
        gl = G.InverseLine(la1, lo1, la2, lo2)
        ns = 2001
        pts = [gl.Position(gl.s13 * k / (ns - 1)) for k in range(ns)]
        qx, qy = T.transform([q['lon2'] for q in pts], [q['lat2'] for q in pts])
        path_plane = float(np.sum(np.hypot(np.diff(qx), np.diff(qy))))
        routes.append({
            'from': {'name': a, 'lat': la1, 'lon': lo1, 'plane_x_m': float(fx[0]), 'plane_y_m': float(fy[0]), 'rho_m': float(fr[0])},
            'to': {'name': b, 'lat': la2, 'lon': lo2, 'plane_x_m': float(fx[1]), 'plane_y_m': float(fy[1]), 'rho_m': float(fr[1])},
            'geodesic_m': inv['s12'], 'initial_azimuth_deg': inv['azi1'], 'final_azimuth_deg': inv['azi2'],
            'plane_straight_line_m': line, 'plane_straight_line_m_via_PROJ': line_proj,
            'plane_minus_geodesic_m': line - inv['s12'], 'plane_over_geodesic_ratio': line / inv['s12'],
            'geodesic_path_length_on_plane_m': path_plane, 'geodesic_path_samples': ns,
        })
        log(f'  {a+" - "+b:<28} {inv["s12"]/1e3:13.3f} {line/1e3:14.3f} {line/inv["s12"]:8.4f} {path_plane/1e3:23.3f}')
    ref = {
        'description': ('Reference values for navigation: WGS84 geodesic (GeographicLib Geodesic.WGS84.Inverse) vs '
                        'straight-line distance on the north-polar AEQD plane (app/src/flatworld/projection/aeqd.js, '
                        'cross-checked with PROJ). The plane straight line is NOT a travel distance except along meridians '
                        'through the North Pole; geodesic_path_length_on_plane_m is the length of the true geodesic drawn on the plane.'),
        'projection': PROJ_STR, 'ellipsoid': {'a': A_WGS, 'f': F_WGS},
        'tools': {'pyproj': pyproj.__version__, 'proj': pyproj.proj_version_str, 'geographiclib': '2.1', 'node': node_v},
        'units': 'metres, degrees', 'routes': routes,
    }
    with open(os.path.join(EVID, 'B-reference-routes.json'), 'w') as fh:
        json.dump(ref, fh, indent=2)
    log('  saved program/evidence/B-reference-routes.json')
    worst_route = max(abs(r['plane_straight_line_m'] - r['plane_straight_line_m_via_PROJ']) for r in routes)
    verdict('route plane distances JS vs PROJ', worst_route <= 2e-3, f'max {worst_route:.3e} m')

    # ------------------------------------------------------------------ domain split
    log('\n## 6. domains.js world frame (round 3): contract "ice iff exact rho > R + 1e-6 m"; (R, R+1e-6] -> gps at lat -90')
    TF = R + TOL_M
    rng6 = np.random.default_rng(6)
    rots = [float(const.get('defaultRotation', 90)), 0.0, 17.25, -123.456, 180.0, 359.9, 1e-7, 45.0, -90.0] + \
        list(rng6.uniform(-360, 360, 11))
    ng = 40000
    worst_rt = worst_rt_m = 0.0
    rt_ok = True
    agg = dict(n_geo=0, sp_fail=[], n_world=0, ice_bad=[], gps_bad=[], band_bad=[], nan_gps=[], ll_on_ice=[],
               dis_domainAt=[], dis_inverse=[], ties=0, tie_dom={'gps': 0, 'ice': 0}, worst_band_lat=0.0)
    for ri, rot in enumerate(rots):
        geo_in = []
        if ri < 9:
            glat_ = np.degrees(np.arcsin(rng.uniform(-1, 1, ng)))
            glon_ = rng.uniform(-180, 180, ng)
            geo_in = [[float(a_), float(b_), 12.5] for a_, b_ in zip(glat_, glon_)]
        sp_lons = list(np.linspace(-180, 180, 3601))  # South Pole every 0.1 deg of longitude
        geo_in += [[-90.0, float(l), 0.0] for l in sp_lons] + [[90.0, float(l), 0.0] for l in sp_lons[::90]]
        geo_in += [[-90 + 1e-12, float(l), 0.0] for l in sp_lons[::7]] + [[-89.9999999, float(l), 0.0] for l in sp_lons[::7]]
        world_in = []
        if ri < 9:
            rr_ = R * np.sqrt(rng.uniform(1.0000001, 9.0, 20000))
            tt = rng.uniform(-np.pi, np.pi, 20000)
            world_in += [[float(r * math.cos(t)), float(r * math.sin(t)), 3.0] for r, t in zip(rr_, tt)]
        # adversarial rim: radii a few ulps around R and around the float threshold R+1e-6, at 1800 bearings
        radii = [R - 1.0, R - 1e-6]
        r_ = R
        for _ in range(4):
            r_ = np.nextafter(r_, 0)
        for _ in range(9):
            radii.append(float(r_)); r_ = np.nextafter(r_, np.inf)
        r_ = TF
        for _ in range(6):
            r_ = np.nextafter(r_, 0)
        for _ in range(13):
            radii.append(float(r_)); r_ = np.nextafter(r_, np.inf)
        radii += [R + 5e-7, R + 2e-6, R + 1.0]
        for t in np.linspace(-math.pi, math.pi, 1801):
            ct, st = math.cos(t), math.sin(t)
            for r in radii:
                world_in.append([r * ct, r * st, 0.0])
        res = js([{'op': 'frame', 'rot': rot, 'geo': geo_in, 'world': world_in}])[0]
        # (a) geodetic -> world -> domain
        n_bad = 0
        bl = np.array([dec(g['back'].get('lat')) for g in res['geo']])
        bo = np.array([dec(g['back'].get('lon')) for g in res['geo']])
        inl = np.array([g[0] for g in geo_in]); ino = np.array([g[1] for g in geo_in])
        for k, g in enumerate(res['geo']):
            if g['back']['domain'] != 'gps' or not math.isfinite(dec(g['back'].get('lat'))):
                n_bad += 1
                agg['sp_fail'].append((rot, geo_in[k][0], geo_in[k][1], g['world']['x'], g['world']['y'], g['back']['domain']))
        agg['n_geo'] += len(geo_in)
        fin = np.isfinite(bl)
        aw = (np.abs(inl) <= POLE_BAND_DEG) & fin
        rt = float(max(np.nanmax(np.abs(bl - inl)[fin]), np.nanmax(np.abs(wrap180(bo - ino))[aw]) if aw.any() else 0.0))
        rtm = float(np.nanmax(pos_err_m(inl, ino, bl, bo)[fin]))
        sp_idx = [k for k, g in enumerate(geo_in) if g[0] == -90.0]
        sp_lat_err = max(abs(bl[k] + 90) for k in sp_idx if math.isfinite(bl[k])) if sp_idx else 0.0
        rt_ok &= rt <= INV_TOL_DEG and sp_lat_err <= INV_TOL_DEG and abs(res['displayRotationDeg'] - rot) < 1e-9
        rt_ok &= all(g['back'].get('height') == g_in[2] for g, g_in in zip(res['geo'], geo_in))
        worst_rt = max(worst_rt, rt, sp_lat_err); worst_rt_m = max(worst_rt_m, rtm)
        # (b) world points
        cnt = {'ice': 0, 'gps': 0}
        n_nan0, n_dis0 = len(agg['nan_gps']), len(agg['dis_inverse'])
        for (x, y, _), w in zip(world_in, res['world']):
            agg['n_world'] += 1
            ov = exact_over(x, y)
            dom = w['r']['domain']
            cnt[dom] = cnt.get(dom, 0) + 1
            if dom not in ('gps', 'ice'):
                agg['gps_bad'].append((rot, x, y, ov, dom))
            if dom != w['domainAt']:
                agg['dis_domainAt'].append((rot, x, y, ov, dom, w['domainAt']))
            if dom != w['invDomain']:
                agg['dis_inverse'].append((rot, x, y, ov, dom, w['invDomain'], w['hyp']))
            if dom == 'ice' and ('lat' in w['keys'] or 'lon' in w['keys']):
                agg['ll_on_ice'].append((rot, x, y))
            if dom == 'gps':
                lat_ = dec(w['r'].get('lat'))
                if not math.isfinite(lat_):
                    agg['nan_gps'].append((rot, x, y, ov))
                elif ov > 0:
                    e_ = abs(lat_ + 90)
                    agg['worst_band_lat'] = max(agg['worst_band_lat'], e_)
                    if e_ > INV_TOL_DEG:
                        agg['band_bad'].append((rot, x, y, ov, lat_))
            if (ov > TOL_M and dom != 'ice') or (ov <= TOL_M and dom != 'gps'):
                agg['max_dev'] = max(agg.get('max_dev', 0.0), abs(ov - TOL_M))
            if abs(ov - TOL_M) < TIE_M:
                agg['ties'] += 1; agg['tie_dom'][dom] = agg['tie_dom'].get(dom, 0) + 1
                continue
            if ov > TOL_M and dom != 'ice':
                agg['ice_bad'].append((rot, x, y, ov, dom))
            if ov <= TOL_M and dom != 'gps':
                agg['gps_bad'].append((rot, x, y, ov, dom))
        log(f'  rot={rot:>20.12g}: geodetic n={len(geo_in)} non-gps={n_bad} max err {max(rt, sp_lat_err):.2e} deg / {rtm:.2e} m; '
            f'world n={len(world_in)} -> ice {cnt.get("ice",0)} gps {cnt.get("gps",0)}; '
            f'gps-with-NaN-lat {len(agg["nan_gps"]) - n_nan0}, worldToDomain!=inverse {len(agg["dis_inverse"]) - n_dis0}')

    def show(lst, fmt, k=6):
        for v in lst[:k]:
            log('    ' + fmt(v))

    verdict('domains.js gps round trip (incl. South Pole at 0.1 deg steps -> lat -90 within 1e-9 deg)', rt_ok,
            f'max {worst_rt:.2e} deg / {worst_rt_m:.2e} m over {agg["n_geo"]} geodetic inputs, {len(rots)} rotations')
    verdict('domains.js: every real geodetic point comes back gps with finite lat/lon', not agg['sp_fail'],
            f'{len(agg["sp_fail"])} failures' if agg['sp_fail'] else 'ok')
    show(agg['sp_fail'], lambda v: f'DEFECT: rot={v[0]} geodeticToWorld({v[1]!r}, {v[2]!r}) -> ({v[3]!r}, {v[4]!r}) -> {v[5]}')
    log(f'  world points checked: {agg["n_world"]} ({len(rots)} rotations; per rotation 1801 bearings x {len(radii)} radii incl. +-ulps around R and R+1e-6)')
    log(f'  info: {agg["ties"]} points within {TIE_M:g} m of exact R+1e-6 (float tie zone): {agg["tie_dom"]}')
    log(f'  info: widest observed departure from exact classification: |exact rho - (R+1e-6)| = {agg.get("max_dev", 0.0):.2e} m')
    verdict('exact rho > R+1e-6 (outside tie zone) -> ice', not agg['ice_bad'], f'{len(agg["ice_bad"])} violations' if agg['ice_bad'] else 'ok')
    show(agg['ice_bad'], lambda v: f'VIOLATION: rot={v[0]} worldToDomain({v[1]!r}, {v[2]!r}) rho-R={v[3]:.4e} -> {v[4]}')
    verdict('exact rho <= R+1e-6 (outside tie zone) -> gps', not agg['gps_bad'], f'{len(agg["gps_bad"])} violations' if agg['gps_bad'] else 'ok')
    show(agg['gps_bad'], lambda v: f'VIOLATION: rot={v[0]} worldToDomain({v[1]!r}, {v[2]!r}) rho-R={v[3]:.4e} -> {v[4]}')
    verdict('gps result beyond the exact circle has lat -90 within 1e-9 deg', not agg['band_bad'],
            f'max |lat+90| {agg["worst_band_lat"]:.2e} deg' if not agg['band_bad'] else f'{len(agg["band_bad"])} violations')
    verdict('no gps result with NaN lat (worldToDomain vs inverse rounding hole)', not agg['nan_gps'],
            (f'{len(agg["nan_gps"])} gps results with NaN lat, all with |exact rho - (R+1e-6)| <= '
             f'{max(abs(v[3] - TOL_M) for v in agg["nan_gps"]):.2e} m') if agg['nan_gps'] else 'ok')
    show(agg['nan_gps'], lambda v: f'DEFECT: rot={v[0]} worldToDomain({v[1]!r}, {v[2]!r}) [exact rho-R={v[3]:.6e} m] -> domain gps, lat NaN')
    verdict('no ice result carries lat/lon', not agg['ll_on_ice'], f'{len(agg["ll_on_ice"])}' if agg['ll_on_ice'] else 'ok')
    verdict('worldToDomain agrees with domainAt', not agg['dis_domainAt'], f'{len(agg["dis_domainAt"])} disagreements')
    verdict('worldToDomain agrees with projection.inverse(fromDisplay(p)).domain', not agg['dis_inverse'],
            (f'{len(agg["dis_inverse"])} disagreements, all with |exact rho - (R+1e-6)| <= '
             f'{max(abs(v[3] - TOL_M) for v in agg["dis_inverse"]):.2e} m') if agg['dis_inverse'] else 'ok')
    show(agg['dis_inverse'], lambda v: f'DISAGREE: rot={v[0]} display ({v[1]!r}, {v[2]!r}) exact rho-R={v[3]:.6e}: worldToDomain={v[4]}, inverse(fromDisplay)={v[5]}')

    log('\n### 6b. Non-finite / extreme world inputs (several rotations)')
    nf_inputs = [['NaN', 0, 0], [0, 'NaN', 0], ['NaN', 'NaN', 0], ['Infinity', 0, 0], ['-Infinity', 5, 0], [0, 'Infinity', 0],
                 ['Infinity', 'Infinity', 0], [1e308, 1e308, 0], [1.7e308, 1.7e308, 0], [-1.7e308, 1e300, 0], [5e-324, 0, 0], [0, 0, 0]]
    bad_nf, dis_nf = [], []
    for rot in [float(const.get('defaultRotation', 90)), 0.0, 17.25, 180.0]:
        res = js([{'op': 'frame', 'rot': rot, 'world': nf_inputs}])[0]
        for inp, w in zip(nf_inputs, res['world']):
            if rot == float(const.get('defaultRotation', 90)):
                log(f'  rot={rot:g} worldToDomain({inp[0]}, {inp[1]}) -> {w["r"]}  domainAt -> {w["domainAt"]}')
            dom = w['r']['domain']
            finite_in = all(isinstance(v, (int, float)) for v in inp[:2])
            if dom == 'gps' and not math.isfinite(dec(w['r'].get('lat'))):
                bad_nf.append((rot, inp, 'gps with NaN lat'))
            if not finite_in and dom == 'gps':
                bad_nf.append((rot, inp, 'non-finite input classified gps'))
            if dom == 'ice' and ('lat' in w['keys'] or 'lon' in w['keys']):
                bad_nf.append((rot, inp, 'ice with lat/lon'))
            if dom != w['domainAt']:
                dis_nf.append((rot, inp, dom, w['domainAt']))
    verdict('non-finite input never gps; no gps with NaN lat; no ice with lat/lon', not bad_nf,
            f'{bad_nf[:4]}' if bad_nf else 'ok')
    verdict('worldToDomain == domainAt for non-finite/extreme input', not dis_nf, f'{dis_nf[:4]}' if dis_nf else 'ok')

    log('\n### 6d. setDisplayRotation() after construction == construction with that rotation')
    pts = [[float(r * math.cos(t)), float(r * math.sin(t)), 0.0]
           for r, t in zip(R * np.sqrt(rng.uniform(0, 4, 4000)), rng.uniform(-np.pi, np.pi, 4000))]
    geo_s = [[float(a_), float(b_), 0.0] for a_, b_ in zip(np.degrees(np.arcsin(rng.uniform(-1, 1, 2000))), rng.uniform(-180, 180, 2000))]
    mism = 0
    for r0, r1 in [(0.0, 90.0), (90.0, -33.3), (12.0, 12.0)]:
        A_, B_ = js([{'op': 'frame', 'rot': r0, 'setRot': r1, 'world': pts, 'geo': geo_s},
                     {'op': 'frame', 'rot': r1, 'world': pts, 'geo': geo_s}])
        mism += sum(a_['r'] != b_['r'] or a_['domainAt'] != b_['domainAt'] for a_, b_ in zip(A_['world'], B_['world']))
        mism += sum(a_['world'] != b_['world'] or a_['back'] != b_['back'] for a_, b_ in zip(A_['geo'], B_['geo']))
        mism += abs(A_['displayRotationDeg'] - r1) > 1e-12
    verdict('setDisplayRotation is equivalent to constructing with that rotation (bit-identical)', mism == 0, f'{mism} mismatches')

    log('\n### 6c. geodeticToWorld longitude wrapping')
    gin = [[10, 540, 0], [-90, 540, 0], [45, -190, 0], [0, 900, 0], [-33, -720.5, 0], [12, 180, 0], [12, -180, 0], [12, 179.9999999, 0]]
    res = js([{'op': 'frame', 'rot': float(const.get('defaultRotation', 90)), 'geo': gin}])[0]
    wrap_bad = []
    for (la, lo, _), g in zip(gin, res['geo']):
        wl = dec(g['world']['lon'])
        exp = float(wrap180(lo))
        ok_ = -180 <= wl < 180 and abs(wl - exp) < 1e-9 and g['back']['domain'] == 'gps'
        log(f'  geodeticToWorld({la}, {lo}) -> lon {wl!r} (expected {exp!r}); back domain {g["back"]["domain"]} lat {g["back"].get("lat")} lon {g["back"].get("lon")}')
        if not ok_:
            wrap_bad.append((la, lo, wl))
    verdict('geodeticToWorld reports lon wrapped into [-180, 180)', not wrap_bad, f'{wrap_bad}' if wrap_bad else 'ok')

    log('\n## Summary')
    for n, ok, d in verdicts:
        log(f'  {"PASS" if ok else "FAIL"}  {n}  ({d})')
    overall = all(v[1] for v in verdicts)
    log(f'\nOVERALL: {"PASS" if overall else "FAIL"}')
    log(f'forward max (grid+random) {fwd_max:.3e} m; forward edge max {fwd_edge_max:.3e} m; inverse max away from poles '
        f'{inv_max_away:.3e} deg; inverse pos err max {inv_pos_max:.3e} m; meridian max {mer_max:.3e} m')
    with open(os.path.join(EVID, 'B-aeqd-proj-verification.txt'), 'w') as fh:
        fh.write(out.getvalue())
    return 0 if overall else 1


if __name__ == '__main__':
    sys.exit(main())
