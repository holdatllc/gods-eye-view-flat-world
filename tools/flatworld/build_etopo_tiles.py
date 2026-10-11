"""Build the local ETOPO 2022 elevation pyramid served at /flatworld-data/etopo/{z}/{x}/{y}.png.

Input : ETOPO_2022_v1_60s_N90W180_surface.tif (NOAA NCEI, public domain; ice-surface elevation,
        EGM2008 orthometric heights, 1 arc-minute, pixel-is-area from (-180, 90)).
Output: geographic (EPSG:4326) pyramid, level z = 2^(z+1) x 2^z tiles of 256 px, Terrarium PNG.
        Level 5 = 16384 x 8192 px over the globe (~1.32 arc-min), box-filtered from the source.
"""
import json, os, sys, time
import numpy as np
import tifffile
from PIL import Image

ROOT = os.environ.get('GEI_ROOT', os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..')))
SRC = f'{ROOT}/data/etopo/ETOPO_2022_v1_60s_N90W180_surface.tif'
OUT = f'{ROOT}/data/tiles/etopo'
MAX_Z = 5
TILE = 256

def terrarium(h):
    v = np.clip(h, -32768, 32767.99) + 32768.0
    r = np.floor(v / 256.0)
    g = np.floor(v - r * 256.0)
    b = np.floor((v - np.floor(v)) * 256.0)
    return np.stack([r, g, b], axis=-1).astype(np.uint8)

def main():
    t0 = time.time()
    src = tifffile.imread(SRC).astype(np.float32)
    src[src < -20000] = 0.0  # nodata guard (ETOPO surface has none in practice)
    print('source', src.shape, float(src.min()), float(src.max()), f'{time.time()-t0:.1f}s', flush=True)
    meta = {'source': os.path.basename(SRC), 'max_zoom': MAX_Z, 'tile_size': TILE,
            'south_pole_mean_m': float(src[-1].mean()), 'north_pole_mean_m': float(src[0].mean()),
            'levels': {}}
    w, h = TILE * 2 ** (MAX_Z + 1), TILE * 2 ** MAX_Z
    level = np.asarray(Image.fromarray(src, mode='F').resize((w, h), Image.BOX), dtype=np.float32)
    del src
    for z in range(MAX_Z, -1, -1):
        cols, rows = 2 ** (z + 1), 2 ** z
        assert level.shape == (rows * TILE, cols * TILE), level.shape
        enc = terrarium(level)
        for x in range(cols):
            d = f'{OUT}/{z}/{x}'
            os.makedirs(d, exist_ok=True)
            for y in range(rows):
                tile = enc[y * TILE:(y + 1) * TILE, x * TILE:(x + 1) * TILE]
                Image.fromarray(tile, 'RGB').save(f'{d}/{y}.png', optimize=False, compress_level=6)
        meta['levels'][z] = {'cols': cols, 'rows': rows, 'min': float(level.min()), 'max': float(level.max())}
        print('level', z, cols * rows, 'tiles', f'{time.time()-t0:.1f}s', flush=True)
        if z:
            level = level.reshape(level.shape[0] // 2, 2, level.shape[1] // 2, 2).mean(axis=(1, 3))
    with open(f'{OUT}/meta.json', 'w') as f:
        json.dump(meta, f, indent=2)
    print(json.dumps(meta, indent=1))

if __name__ == '__main__':
    main()
