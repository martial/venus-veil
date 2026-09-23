import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRestShape, applyRelief, computeGridNormals, ribbonPoint, orientRestShape } from '../src/cloth/restShape.js';

test('grid has the right size, uv range and unit normals', () => {
  const shape = createRestShape({ columns: 12, rows: 6 });
  assert.equal(shape.count, 13 * 7);
  assert.equal(shape.base.length, shape.count * 3);
  assert.equal(shape.uv[0], 0);
  assert.equal(shape.uv[(shape.count - 1) * 2], 1);
  assert.equal(shape.uv[(shape.count - 1) * 2 + 1], 1);
  for (let i = 0; i < shape.count * 3; i += 3) {
    const l = Math.hypot(shape.nBase[i], shape.nBase[i + 1], shape.nBase[i + 2]);
    assert.ok(Math.abs(l - 1) < 1e-5);
  }
});

test('the veil hovers above the floor and faces +z in the middle', () => {
  const shape = createRestShape();
  let minY = Infinity;
  for (let i = 1; i < shape.count * 3; i += 3) minY = Math.min(minY, shape.base[i]);
  assert.ok(minY > 0.05, `min y ${minY}`);
  const mid = Math.floor(shape.rows / 2) * (shape.columns + 1) + Math.floor(shape.columns / 2);
  assert.ok(shape.nBase[mid * 3 + 2] > 0.5, 'centre normal should point toward the camera');
});

test('ribbonPoint spans the width along u and the height along v', () => {
  const a = ribbonPoint(0, 0.5), b = ribbonPoint(1, 0.5);
  assert.ok(Math.abs((b[0] - a[0]) - 5) < 1e-6);
  const c = ribbonPoint(0.5, 0), d = ribbonPoint(0.5, 1);
  assert.ok(Math.abs(Math.hypot(d[0] - c[0], d[1] - c[1], d[2] - c[2]) - 2) < 1e-6);
});

test('applyRelief moves each point by depth * amplitude along its normal', () => {
  const shape = createRestShape({ columns: 8, rows: 4 });
  const out = new Float32Array(shape.count * 3);
  applyRelief(shape, null, 0.5, out);
  assert.deepEqual(Array.from(out), Array.from(shape.base));
  const depth = new Float32Array(shape.count).fill(1);
  applyRelief(shape, depth, 0.25, out);
  for (let i = 0; i < shape.count * 3; i += 3) {
    const d = Math.hypot(out[i] - shape.base[i], out[i + 1] - shape.base[i + 1], out[i + 2] - shape.base[i + 2]);
    assert.ok(Math.abs(d - 0.25) < 1e-5, `moved ${d}`);
  }
});

test('computeGridNormals of a flat xy grid is +z', () => {
  const columns = 4, rows = 3, count = (columns + 1) * (rows + 1);
  const pos = new Float32Array(count * 3);
  for (let y = 0; y <= rows; y++) for (let x = 0; x <= columns; x++) {
    const i = y * (columns + 1) + x;
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = 0;
  }
  const n = computeGridNormals(pos, columns, rows, new Float32Array(count * 3));
  for (let i = 0; i < count * 3; i += 3) assert.ok(Math.abs(n[i + 2] - 1) < 1e-6);
});

test('orientRestShape stands the strip up above the floor and lays it back down', () => {
  const shape = createRestShape();
  const original = shape.base.slice();
  const lengths = shape => {
    const out = [];
    for (let i = 0; i < shape.columns; i++) {
      const a = i * 3, b = (i + 1) * 3;
      out.push(Math.hypot(shape.base[b] - shape.base[a], shape.base[b + 1] - shape.base[a + 1], shape.base[b + 2] - shape.base[a + 2]));
    }
    return out;
  };
  const before = lengths(shape);
  orientRestShape(shape, true, { scale: 0.5, bottom: 0.4 });
  assert.ok(shape.vertical);
  // u = 0 (the end a laid figure's head is on) is at the top
  assert.ok(shape.base[1] > shape.base[shape.columns * 3 + 1] + 1.5);
  let minY = Infinity;
  for (let i = 0; i < shape.count; i++) minY = Math.min(minY, shape.base[i * 3 + 1]);
  assert.ok(Math.abs(minY - 0.4) < 1e-5);
  lengths(shape).forEach((l, i) => assert.ok(Math.abs(l - before[i] * 0.5) < 1e-4));
  for (let i = 0; i < shape.count; i++) {
    const k = i * 3;
    assert.ok(Math.abs(Math.hypot(shape.nBase[k], shape.nBase[k + 1], shape.nBase[k + 2]) - 1) < 1e-4);
  }
  orientRestShape(shape, false);
  assert.deepEqual(Array.from(shape.base), Array.from(original));
});
