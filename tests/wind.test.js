import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWind } from '../src/cloth/wind.js';

test('gust envelope stays within [1, 1 + gustAmp]', () => {
  const wind = createWind({ gustAmp: 0.6 }, 'gust-test');
  for (let t = 0; t < 200; t += 0.37) {
    const g = wind.gust(t);
    assert.ok(g >= 1 - 1e-9 && g <= 1.6 + 1e-9, `gust ${g} at ${t}`);
  }
});

test('turbulence is divergence-free', () => {
  const wind = createWind({}, 'div-test');
  // outer step matched to the curl's inner step in noise space so the discrete
  // mixed partials commute; the continuous curl is exactly divergence-free
  const h = wind.params.curlEps / wind.params.turbScale;
  const c = [0, 0, 0];
  let seed = 11;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 * 6 - 3;
  for (let n = 0; n < 20; n++) {
    const x = rnd(), y = rnd(), z = rnd(), t = Math.abs(rnd());
    const dx = (wind.curl(x + h, y, z, t, c)[0] - wind.curl(x - h, y, z, t, c)[0]) / (2 * h);
    const dy = (wind.curl(x, y + h, z, t, c)[1] - wind.curl(x, y - h, z, t, c)[1]) / (2 * h);
    const dz = (wind.curl(x, y, z + h, t, c)[2] - wind.curl(x, y, z - h, t, c)[2]) / (2 * h);
    const mag = Math.hypot(...wind.curl(x, y, z, t, c));
    assert.ok(Math.abs(dx + dy + dz) < 0.05 * Math.max(1, mag), `div ${dx + dy + dz} for |curl| ${mag}`);
  }
});

test('lattice samples reproduce the field at lattice nodes', () => {
  const wind = createWind({ speed: 2, turbulence: 1 }, 'lattice-test');
  wind.setBounds([-2, 0, -1], [2, 3, 1], 0);
  wind.update(1.5);
  const { nx, ny, nz, min, max } = wind.lattice;
  const out = [0, 0, 0], c = [0, 0, 0], b = wind.baseVector([0, 0, 0]);
  for (const [ix, iy, iz] of [[0, 0, 0], [nx - 1, ny - 1, nz - 1], [3, 5, 2]]) {
    const x = min[0] + (max[0] - min[0]) * ix / (nx - 1);
    const y = min[1] + (max[1] - min[1]) * iy / (ny - 1);
    const z = min[2] + (max[2] - min[2]) * iz / (nz - 1);
    wind.sampleAt(x, y, z, out);
    wind.curl(x, y, z, 1.5, c);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(out[k] - (b[k] + c[k])) < 1e-4, `axis ${k}: ${out[k]} vs ${b[k] + c[k]}`);
  }
});

test('wand adds a local push that decays over time', () => {
  const wind = createWind({ speed: 0, turbulence: 0, wandStrength: 2, wandRadius: 1 }, 'wand');
  wind.update(0);
  const out = [0, 0, 0];
  wind.sampleAt(0, 1, 0, out);
  assert.deepEqual(out, [0, 0, 0]);
  wind.setWand(0, 1, 0, 3, 0, 0);
  wind.sampleAt(0, 1, 0, out);
  assert.ok(Math.abs(out[0] - 6) < 1e-6);
  wind.sampleAt(5, 1, 0, out);
  assert.ok(out[0] < 1e-6, 'push should be local');
  wind.update(1, 2);
  wind.sampleAt(0, 1, 0, out);
  assert.ok(out[0] < 6 * Math.exp(-4 * 2) + 1e-6);
});
