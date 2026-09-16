import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createDepthRaster, rasterDepth, downsampleGray, packFrame, EMPTY_DEPTH } from '../src/projection/rasterDepth.js';

function viewProjection(position = [0, 0, 0], target = [0, 0, -1]) {
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
  camera.position.set(...position);
  camera.lookAt(...target);
  camera.updateMatrixWorld();
  return new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
}

// axis-aligned quad in the plane z = zPlane, spanning [x0,x1]×[y0,y1]
function quad(x0, x1, y0, y1, zPlane, base = 0) {
  return {
    positions: [x0, y0, zPlane, x1, y0, zPlane, x1, y1, zPlane, x0, y1, zPlane],
    indices: [base, base + 1, base + 2, base, base + 2, base + 3],
  };
}
function merge(...quads) {
  const positions = [], indices = [];
  for (const q of quads) {
    const base = positions.length / 3;
    positions.push(...q.positions);
    indices.push(...q.indices.map(i => i + base));
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}
const at = (size, x, y) => y * size + x;
const atGL = (size, x, y) => (size - 1 - y) * size + x;

test('a quad in front of the camera covers the centre with the right metric depth', () => {
  const size = 64, r = createDepthRaster(size);
  const { positions, indices } = merge(quad(-1, 1, -1, 1, -5));
  rasterDepth(r, positions, indices, viewProjection(), 3, 8);
  assert.ok(r.gray[at(size, 32, 32)] > 0);
  assert.equal(r.gray[at(size, 0, 0)], 0);
  assert.ok(Math.abs(r.metric[atGL(size, 32, 32)] - 5) < 1e-3, `metric ${r.metric[atGL(size, 32, 32)]}`);
  assert.equal(r.metric[atGL(size, 0, 0)], EMPTY_DEPTH);
  assert.ok(r.covered > 0 && r.covered < size * size);
});

test('the nearest surface wins and is brighter', () => {
  const size = 64, r = createDepthRaster(size);
  const { positions, indices } = merge(quad(-1, 1, -1, 1, -6), quad(-0.4, 0.4, -0.4, 0.4, -4));
  rasterDepth(r, positions, indices, viewProjection(), 3, 8);
  assert.ok(Math.abs(r.metric[atGL(size, 32, 32)] - 4) < 1e-3);
  const nearGray = r.gray[at(size, 32, 32)], farGray = r.gray[at(size, 20, 32)];
  assert.ok(nearGray > farGray && farGray > 0, `${nearGray} vs ${farGray}`);
  // drawing order does not matter
  const flipped = merge(quad(-0.4, 0.4, -0.4, 0.4, -4), quad(-1, 1, -1, 1, -6));
  const r2 = createDepthRaster(size);
  rasterDepth(r2, flipped.positions, flipped.indices, viewProjection(), 3, 8);
  assert.deepEqual(Array.from(r2.gray), Array.from(r.gray));
});

test('rows: gray is top-down, metric is bottom-up (GL texture order)', () => {
  const size = 32, r = createDepthRaster(size);
  const { positions, indices } = merge(quad(-1, 1, 0.3, 1.5, -5));   // upper part of the view
  rasterDepth(r, positions, indices, viewProjection(), 3, 8);
  assert.ok(r.gray[at(size, 16, 8)] > 0, 'upper rows lit in gray');
  assert.equal(r.gray[at(size, 16, 26)], 0);
  assert.ok(r.metric[(size - 1 - 8) * size + 16] < EMPTY_DEPTH, 'same pixel lit in metric at the flipped row');
});

test('geometry behind the camera draws nothing; crossing the near plane is clipped safely', () => {
  const size = 32, r = createDepthRaster(size);
  const behind = merge(quad(-1, 1, -1, 1, 5));
  rasterDepth(r, behind.positions, behind.indices, viewProjection(), 1, 8);
  assert.equal(r.covered, 0);
  // a floor-like quad from behind the camera to far in front
  const positions = Float32Array.from([-1, -0.5, 2, 1, -0.5, 2, 1, -0.5, -10, -1, -0.5, -10]);
  const indices = Uint32Array.from([0, 1, 2, 0, 2, 3]);
  rasterDepth(r, positions, indices, viewProjection(), 1, 8);
  assert.ok(r.covered > 0);
  for (const v of r.metric) assert.ok(Number.isFinite(v) && v > 0);
});

test('packFrame lays out length, utf-8 JSON and depth bytes', () => {
  const gray = Uint8Array.from([1, 2, 3, 4]);
  const body = packFrame({ size: 2, prompt: 'Vénus' }, gray);
  const length = new DataView(body.buffer).getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + length)));
  assert.equal(meta.prompt, 'Vénus');
  assert.deepEqual(Array.from(body.subarray(4 + length)), [1, 2, 3, 4]);
});

test('downsampleGray averages covered samples and drops thin coverage', () => {
  const src = new Uint8Array(16);   // 4x4
  const dst = new Uint8Array(4);    // 2x2
  // top-left block fully covered with 100, top-right block one sample only
  src[0] = src[1] = src[4] = src[5] = 100;
  src[2] = 200;
  downsampleGray(src, 4, dst, 2);
  assert.equal(dst[0], 100);
  assert.equal(dst[1], 0, 'a quarter-covered block stays empty');
  assert.equal(dst[2], 0);
  // half coverage keeps the average of the covered samples
  const half = new Uint8Array(16);
  half[0] = 40; half[1] = 80;
  const out = new Uint8Array(4);
  downsampleGray(half, 4, out, 2);
  assert.equal(out[0], 60);
  assert.throws(() => downsampleGray(src, 4, dst, 3));
});
