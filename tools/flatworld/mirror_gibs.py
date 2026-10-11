"""Mirror low/mid zoom NASA GIBS EPSG:4326 tiles (public domain) to the local tile store so the
flat world streams them from the drive instead of a slow remote service.

Layers: VIIRS_Black_Marble (2016-01-01, png) and BlueMarble_NextGeneration (2004-08-01, jpeg),
TileMatrixSet 500m, levels 0..MAX_Z. Level z has ceil(1.25*2^z) x ceil(0.625*2^z) tiles of 512 px.
Output: data/tiles/gibs/<layer>/<z>/<x>/<y>.<ext>   Re-runnable; existing files are skipped.
"""
import concurrent.futures as cf, math, os, sys, time, urllib.request

ROOT = os.path.join(os.environ.get('GEV_FLATWORLD_DATA_DIR', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'data', 'tiles')), 'gibs')
# (layer, date, ext, tile matrix set, max rows per level as a fraction of the grid (None = all))
LAYERS = [
    ('VIIRS_Black_Marble', '2016-01-01', 'png', '500m', None),
    ('BlueMarble_NextGeneration', '2004-08-01', 'jpeg', '500m', None),
    # Arctic cap (north of ~84°): MODIS Terra true colour on a summer day, top rows only.
    ('MODIS_Terra_CorrectedReflectance_TrueColor', '2026-07-20', 'jpg', '250m', 'north'),
]
MAX_Z = int(sys.argv[1]) if len(sys.argv) > 1 else 5
UA = {'User-Agent': 'gods-eye-infinite-ice/0.1 (local mirror; contact holdatllc)'}

def jobs():
    for layer, date, ext, tms, limit in LAYERS:
        for z in range(MAX_Z + 1):
            cols, rows = math.ceil(1.25 * 2 ** z), math.ceil(0.625 * 2 ** z)
            if limit == 'north':
                rows = 1  # the first row spans 90° down to 90 − 288/2^z degrees
            for x in range(cols):
                for y in range(rows):
                    yield layer, date, ext, tms, z, x, y

def fetch(job):
    layer, date, ext, tms, z, x, y = job
    out = f'{ROOT}/{layer}/{z}/{x}/{y}.{ext}'
    if os.path.exists(out):
        return 'skip'
    url = f'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/{layer}/default/{date}/{tms}/{z}/{y}/{x}.{ext}'
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                data = r.read()
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with open(out + '.part', 'wb') as f:
                f.write(data)
            os.replace(out + '.part', out)
            return 'ok'
        except urllib.error.HTTPError as e:
            if e.code in (400, 404):
                return f'missing {e.code}'
            time.sleep(2 ** attempt)
        except Exception:
            time.sleep(2 ** attempt)
    return 'fail'

if __name__ == '__main__':
    all_jobs = list(jobs())
    t0 = time.time()
    counts = {}
    with cf.ThreadPoolExecutor(12) as ex:
        for i, res in enumerate(ex.map(fetch, all_jobs)):
            key = res.split()[0]
            counts[key] = counts.get(key, 0) + 1
            if i % 200 == 0:
                print(i, len(all_jobs), counts, f'{time.time()-t0:.0f}s', flush=True)
    print('done', counts, f'{time.time()-t0:.0f}s')
