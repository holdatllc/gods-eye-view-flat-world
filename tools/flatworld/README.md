# Flat-world tools

Verification and data-build scripts for the flat world (`src/flatworld`, `docs/FLAT-WORLD.md`).
Python scripts need pyproj, numpy, pillow, tifffile and geographiclib.

| Script | What it does |
|--------|--------------|
| `verify_aeqd.py` | Independent check of the projection and domain split against PROJ and GeographicLib (uses `aeqd_dump.mjs`). Exits 1 on any failure. |
| `aeqd_dump.mjs` | Evaluates the app's projection for batches of points (helper for the above). |
| `build_etopo_tiles.py` | Builds the ETOPO 2022 Terrarium pyramid served at `/flatworld-data/etopo`. |
| `mirror_gibs.py [maxZoom]` | Mirrors NASA GIBS Blue Marble, Black Marble and the MODIS Arctic cap to `/flatworld-data/gibs`. |
| `ice_determinism.mjs` | Hashes procedural ice chunks; two runs must print identical lines. |
| `ice_stats.mjs` | Height/material statistics of the ice field (tuning aid). |
| `ice_bench.mjs` | Times full-size ice chunk builds. |

Data lands in `GEV_FLATWORLD_DATA_DIR` (default `../data/tiles` beside the checkout).
