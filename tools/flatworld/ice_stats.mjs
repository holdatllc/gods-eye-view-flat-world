// Height/material statistics of the procedural ice field over 2,000 km windows (tuning aid).
import { createIceField } from '../../src/flatworld/ice/iceField.js';
const R = 20003931.4586;
const f = createIceField({}, { boundaryRadius: R });
for (const [cx, cy] of [
  [0, -(R + 900000)],
  [3e7, -9e7],
  [5e8, 2e8],
]) {
  const hs = [];
  let rock = 0,
    crev = 0,
    blue = 0;
  let maxSlope = 0;
  for (let j = 0; j < 200; j++)
    for (let i = 0; i < 200; i++) {
      const x = cx + (i - 100) * 10000,
        y = cy + (j - 100) * 10000;
      const s = f.sample(x, y);
      hs.push(s.height);
      rock += s.rock > 0.3;
      crev += s.crevasse > 0.3;
      blue += s.blueIce > 0.3;
      const s2 = f.sample(x + 200, y);
      maxSlope = Math.max(maxSlope, Math.abs(s2.height - s.height) / 200);
    }
  hs.sort((a, b) => a - b);
  const p = (q) => hs[Math.floor(q * hs.length)].toFixed(0);
  console.log(
    `(${cx},${cy}) p1 ${p(0.01)} p25 ${p(0.25)} p50 ${p(0.5)} p75 ${p(0.75)} p99 ${p(0.99)} max ${hs.at(-1).toFixed(0)} rock% ${rock / 400} blue% ${blue / 400} crev% ${crev / 400} maxSlope ${maxSlope.toFixed(2)}`,
  );
}
