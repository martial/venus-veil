import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  otsuThreshold, percentile, boxBlur2D, buildMask, normalizeDepth, figureIsNearer,
  maskBounds, createFit, resampleToGrid, highPass, normalMapFromHeight, hasDarkBackground, fillHoles, computeSolverGrids,
} from '../src/pipeline/veilTexture.js';

// synthetic photo: dark background, bright disc in the centre; depth: disc nearer
function synthetic(w = 64, h = 96) {
  const luma = new Float32Array(w * h), depth = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (x - w / 2) / (w * 0.3), dy = (y - h / 2) / (h * 0.3);
    const inside = dx * dx + dy * dy < 1;
    const i = y * w + x;
    luma[i] = inside ? 0.5 + 0.3 * Math.sin(x * 0.7) * Math.cos(y * 0.5) : 0.03;
    depth[i] = inside ? 2 + (1 - dx * dx - dy * dy) * 3 : 0.5;
  }
  return { w, h, luma, depth };
}

test('otsu separates a bimodal field', () => {
  const values = new Float32Array(1000);
  for (let i = 0; i < 1000; i++) values[i] = i < 400 ? 0.1 + (i % 7) * 0.01 : 0.7 + (i % 5) * 0.02;
  const t = otsuThreshold(values);
  assert.ok(t > 0.2 && t < 0.65, `threshold ${t}`);
});

test('percentile respects the mask', () => {
  const values = Float32Array.from([0, 1, 2, 3, 100, 200]);
  const mask = Float32Array.from([1, 1, 1, 1, 0, 0]);
  assert.equal(percentile(values, 1, mask), 3);
  assert.equal(percentile(values, 0, null), 0);
  assert.equal(percentile(values, 1, null), 200);
});

test('boxBlur2D preserves a constant field and stays bounded', () => {
  const w = 20, h = 12, f = new Float32Array(w * h).fill(0.4);
  const b = boxBlur2D(f, w, h, 3);
  for (const v of b) assert.ok(Math.abs(v - 0.4) < 1e-6);
  f[5 * w + 5] = 1;
  const b2 = boxBlur2D(f, w, h, 2);
  for (const v of b2) assert.ok(v >= 0.4 - 1e-6 && v <= 1 + 1e-6);
});

test('mask from a dark-background photo isolates the figure', () => {
  const { w, h, luma, depth } = synthetic();
  assert.ok(hasDarkBackground(luma, w, h));
  const m = buildMask(luma, depth, w, h, { feather: 2 });
  assert.equal(m.source, 'luma');
  assert.equal(m.hard[0], 0);
  assert.equal(m.hard[(h / 2) * w + w / 2], 1);
  const centre = m.soft[(h / 2) * w + w / 2];
  assert.ok(centre > 0.95, `soft centre ${centre}`);
  assert.ok(m.soft[0] < 1e-6);
});

test('depth normalisation maps the masked range to 0..1 and zeroes the background', () => {
  const { w, h, luma, depth } = synthetic();
  const m = buildMask(luma, depth, w, h);
  assert.ok(figureIsNearer(depth, m.hard));
  const n = normalizeDepth(depth, m.hard, {});
  let max = 0, min = 1;
  for (let i = 0; i < n.length; i++) { if (m.hard[i] > 0.5) { max = Math.max(max, n[i]); min = Math.min(min, n[i]); } else assert.equal(n[i], 0); }
  assert.ok(max > 0.95 && min < 0.05, `range ${min}..${max}`);
  const inv = normalizeDepth(depth, m.hard, { invert: true });
  const c = (h / 2) * w + w / 2;
  assert.ok(Math.abs(inv[c] - (1 - n[c])) < 1e-6);
});

test('fit maps ribbon uv to image pixels and back, figure along the length', () => {
  const bounds = { x0: 10, y0: 5, x1: 60, y1: 95 };
  const fit = createFit(bounds, { rotate90: true, padding: 0.1, scale: 1 });
  // centre of the figure lands at the ribbon centre
  const [x, y] = fit.toImage(0.5, 0.5);
  assert.ok(Math.abs(x - 35) < 1e-6 && Math.abs(y - 50) < 1e-6);
  // round trip
  for (const [u, v] of [[0.2, 0.3], [0.8, 0.9], [0.5, 0.5]]) {
    const [ix, iy] = fit.toImage(u, v);
    const [uu, vv] = fit.toUV(ix, iy);
    assert.ok(Math.abs(uu - u) < 1e-6 && Math.abs(vv - v) < 1e-6);
  }
  // the top of the image (head) is at higher u than the bottom (feet)
  const [uTop] = fit.toUV(35, 5), [uBottom] = fit.toUV(35, 95);
  assert.ok(uTop > uBottom);
  // the figure fits inside the ribbon with padding
  const [uA] = fit.toUV(35, 5), [uB] = fit.toUV(35, 95);
  assert.ok(uA <= 1 && uB >= 0);
  const [, vA] = fit.toUV(10, 50), [, vB] = fit.toUV(60, 50);
  assert.ok(Math.max(vA, vB) <= 0.95 && Math.min(vA, vB) >= 0.05);
});

test('resampleToGrid reproduces a gradient through an identity fit', () => {
  const w = 40, h = 20, f = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f[y * w + x] = x / (w - 1);
  const fit = { toImage: (u, v) => [u * (w - 1), (1 - v) * (h - 1)] };
  const g = resampleToGrid(f, w, h, 8, 4, fit, 0);
  assert.equal(g.length, 9 * 5);
  assert.ok(Math.abs(g[0] - 0) < 1e-6 && Math.abs(g[8] - 1) < 1e-6 && Math.abs(g[4] - 0.5) < 1e-6);
});

test('maskBounds and highPass / normal map basics', () => {
  const { w, h, luma, depth } = synthetic();
  const m = buildMask(luma, depth, w, h);
  const b = maskBounds(m.hard, w, h);
  assert.ok(!b.empty && b.x0 > 0 && b.x1 < w - 1 && b.y0 > 0 && b.y1 < h - 1);
  const hp = highPass(luma, w, h, 4, 1);
  let mean = 0; for (const v of hp) mean += v; mean /= hp.length;
  assert.ok(Math.abs(mean) < 0.05, `high-pass mean ${mean}`);
  const flat = new Float32Array(w * h).fill(0.5);
  const nm = normalMapFromHeight(flat, w, h, 4);
  assert.ok(Math.abs(nm[0] - 127.5) <= 1 && Math.abs(nm[1] - 127.5) <= 1 && nm[2] === 255);
});

test('fillHoles closes dark crevices inside the figure but keeps the outside background', () => {
  const w = 30, h = 30, m = new Float32Array(w * h);
  for (let y = 5; y < 25; y++) for (let x = 5; x < 25; x++) m[y * w + x] = 1;
  for (let y = 12; y < 18; y++) for (let x = 12; x < 18; x++) m[y * w + x] = 0;   // hole
  const f = fillHoles(m, w, h);
  assert.equal(f[15 * w + 15], 1);
  assert.equal(f[0], 0);
  assert.equal(f[2 * w + 2], 0);
  // a dark-background photo with shadowed crevices yields a solid figure mask
  const { w: pw, h: ph, luma, depth } = synthetic();
  for (let y = 40; y < 56; y++) luma[y * pw + 32] = 0.01;   // vertical crevice through the disc
  const mk = buildMask(luma, depth, pw, ph);
  assert.equal(mk.hard[48 * pw + 32], 1);
});

test('solver grids: mask and relief are zero outside the figure and positive inside', () => {
  const { w, h, luma, depth } = synthetic();
  const mask = buildMask(luma, depth, w, h);
  const depthNorm = normalizeDepth(depth, mask.hard, {});
  const bounds = maskBounds(mask.hard, w, h);
  const columns = 24, rows = 10;
  const { reliefGrid, maskGrid } = computeSolverGrids({ w, h, depthNorm, maskSoft: mask.soft, bounds }, { columns, rows }, { rotate90: true });
  assert.equal(maskGrid.length, (columns + 1) * (rows + 1));
  let covered = 0;
  for (const v of maskGrid) { assert.ok(v >= 0 && v <= 1); if (v > 0.5) covered++; }
  const coverage = covered / maskGrid.length;
  assert.ok(coverage > 0.1 && coverage < 0.6, `coverage ${coverage}`);
  // corners of the ribbon are outside the figure
  for (const i of [0, columns, rows * (columns + 1), maskGrid.length - 1]) { assert.ok(maskGrid[i] < 1e-6); assert.ok(reliefGrid[i] < 1e-6); }
  // centre of the ribbon is inside, with relief
  const mid = Math.floor(rows / 2) * (columns + 1) + Math.floor(columns / 2);
  assert.ok(maskGrid[mid] > 0.9, `mid mask ${maskGrid[mid]}`);
  assert.ok(reliefGrid[mid] > 0.5, `mid relief ${reliefGrid[mid]}`);
});
