// Batch evaluator for the flat-world AEQD + world-frame modules (audit helper, read-only use).
// stdin: JSON array of requests; stdout: JSON array of responses.
// Non-finite numbers are encoded as the strings "NaN", "Infinity", "-Infinity" in both directions.
// Missing (undefined) fields are emitted as null-free absence so callers can test "key present".
import { pathToFileURL } from 'node:url';

const SRC = new URL('../../src/flatworld/projection/', import.meta.url)
  .pathname;
const aeqd = await import(pathToFileURL(SRC + 'aeqd.js').href);
const domains = await import(pathToFileURL(SRC + 'domains.js').href);

const dec = (v) =>
  v === 'NaN'
    ? NaN
    : v === 'Infinity'
      ? Infinity
      : v === '-Infinity'
        ? -Infinity
        : v;
const enc = (v) =>
  typeof v === 'number' && !Number.isFinite(v) ? String(v) : v;
const decArr = (a) => a.map(dec);
const encObj = (o) => {
  if (o === null) return null;
  const r = {};
  for (const [k, v] of Object.entries(o)) r[k] = enc(v);
  return r;
};

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const reqs = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const P = aeqd.polarAeqd;
const out = [];
for (const req of reqs) {
  const { op } = req;
  if (op === 'constants') {
    out.push({
      boundaryTolerance: aeqd.BOUNDARY_TOLERANCE_M,
      defaultRotation: domains.GLEASON_DISPLAY_ROTATION_DEG,
      hasIsBeyond: typeof P.isBeyondSouthPole === 'function',
      quarterMeridian: P.quarterMeridian,
      southPoleRadius: P.southPoleRadius,
      rectifyingRadius: P.rectifyingRadius,
      proj4: P.proj4,
    });
  } else if (op === 'forward') {
    const lat = decArr(req.lat),
      lon = decArr(req.lon);
    const x = [],
      y = [],
      rho = [];
    for (let i = 0; i < lat.length; i++) {
      const p = P.forward(lat[i], lon[i]);
      x.push(enc(p.x));
      y.push(enc(p.y));
      rho.push(enc(p.rho));
    }
    out.push({ x, y, rho });
  } else if (op === 'inverse') {
    const x = decArr(req.x),
      y = decArr(req.y);
    const lat = [],
      lon = [],
      domain = [],
      rho = [];
    for (let i = 0; i < x.length; i++) {
      const g = P.inverse(x[i], y[i]);
      lat.push(enc(g.lat));
      lon.push(enc(g.lon));
      domain.push(g.domain);
      rho.push(enc(g.rho ?? NaN));
    }
    out.push({ lat, lon, domain, rho });
  } else if (op === 'scale') {
    out.push({ items: decArr(req.lat).map((l) => encObj(P.scaleFactors(l))) });
  } else if (op === 'frame') {
    // rot: display rotation (deg). geo: [[lat,lon,h]], world: [[x,y,z]]
    const F = domains.createWorldFrame({ displayRotationDeg: req.rot });
    if (req.setRot !== undefined) F.setDisplayRotation(req.setRot);
    const res = {
      boundaryRadius: F.boundaryRadius,
      displayRotationDeg: F.displayRotationDeg,
    };
    if (req.geo) {
      res.geo = req.geo.map(([la, lo, h]) => {
        const w = F.geodeticToWorld(dec(la), dec(lo), h);
        if (!w) return null;
        const back = F.worldToDomain(w.x, w.y, w.z);
        return {
          world: encObj(w),
          back: encObj(back),
          keys: Object.keys(back),
          domainAt: F.domainAt(w.x, w.y),
        };
      });
    }
    if (req.world) {
      res.world = req.world.map(([x, y, z]) => {
        const r = F.worldToDomain(dec(x), dec(y), z);
        const p = F.fromDisplay(dec(x), dec(y));
        const inv = P.inverse(p.x, p.y);
        return {
          r: encObj(r),
          keys: Object.keys(r),
          domainAt: F.domainAt(dec(x), dec(y)),
          invDomain: inv.domain,
          invLat: enc(inv.lat),
          hyp: Math.hypot(dec(x), dec(y)),
        };
      });
    }
    out.push(res);
  } else {
    out.push({ error: `unknown op ${op}` });
  }
}
process.stdout.write(JSON.stringify(out));
