import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createDepthRaster, rasterDepth, buildStructure, downsampleGray, rotateQuarter, rotateTurns, turnTransform, packFrame, EMPTY_DEPTH } from '../src/projection/rasterDepth.js';

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

test('buildStructure stretches depth over the veil range and can follow a per-vertex field', () => {
  const size = 48, r = createDepthRaster(size);
  // a quad tilted in depth: left edge near, right edge far
  const positions = Float32Array.from([-1, -1, -4.5, 1, -1, -5.5, 1, 1, -5.5, -1, 1, -4.5]);
  const indices = Uint32Array.from([0, 1, 2, 0, 2, 3]);
  const values = Float32Array.from([0, 1, 1, 0]);         // field rises to the right
  rasterDepth(r, positions, indices, viewProjection(), 1, 40, values);
  const mid = y => Math.round(size / 2) * size + y;
  // without the field: the near side is brightest, and the range is stretched
  buildStructure(r, { emphasis: 0 });
  const left = r.gray[mid(14)], right = r.gray[mid(34)];
  assert.ok(left > right + 100, `depth contrast ${left} vs ${right}`);
  const covered = [...r.gray].filter(v => v > 0);
  assert.equal(Math.max(...covered), 255, 'nearest covered pixel reaches full white');
  assert.equal(Math.min(...covered), 30, 'farthest covered pixel sits on the floor value');
  assert.equal(r.gray[0], 0, 'background stays empty');
  // with the field: the bright side follows the field instead
  rasterDepth(r, positions, indices, viewProjection(), 1, 40, values);
  buildStructure(r, { emphasis: 1 });
  assert.ok(r.gray[mid(34)] > r.gray[mid(14)] + 100, 'field drives the shading');
});

test('rotateQuarter turns the capture, and one more turn puts the answer back', () => {
  const size = 4, n = size * size;
  const src = Uint8Array.from({ length: n }, (_, i) => i + 1);
  const turn = (buf, channels = 1) => rotateQuarter(buf, size, new (buf.constructor)(buf.length), channels);
  const flip = buf => {
    const out = new Uint8Array(buf.length);
    for (let y = 0; y < size; y++) out.set(buf.subarray((size - 1 - y) * size, (size - y) * size), y * size);
    return out;
  };
  // four quarter turns are the identity
  assert.deepEqual(Array.from(turn(turn(turn(turn(src))))), Array.from(src));
  // flip . turn . flip === turn^3, which is why one more turn in the answer's
  // (bottom-up) storage undoes the turn applied to the capture
  const three = turn(turn(turn(src)));
  assert.deepEqual(Array.from(flip(turn(flip(src)))), Array.from(three));
  // the projector's actual round trip: send turn(capture), receive it bottom-up, turn once
  const sent = turn(src);
  const answerBottomUp = flip(sent);              // the model returns GL-ordered rows
  const backOnTheVeil = flip(turn(answerBottomUp));
  assert.deepEqual(Array.from(backOnTheVeil), Array.from(src), 'the answer lands back on the veil');
  // a pixel keeps its four channels together
  const rgba = Uint8Array.from({ length: n * 4 }, (_, i) => i);
  const turned = turn(rgba, 4);
  assert.deepEqual(Array.from(turned.subarray(0, 4)), Array.from(rgba.subarray((size - 1) * size * 4, (size - 1) * size * 4 + 4)));
});

test('rotateTurns: k turns are k quarter turns, and k turns of the bottom-up answer undo them', () => {
  const size = 5, n = size * size;
  const src = Uint8Array.from({ length: n }, (_, i) => i + 1);
  const quarter = buf => rotateQuarter(buf, size, new Uint8Array(n));
  const flip = buf => {
    const out = new Uint8Array(buf.length);
    for (let y = 0; y < size; y++) out.set(buf.subarray((size - 1 - y) * size, (size - y) * size), y * size);
    return out;
  };
  let expected = src;
  for (let k = 0; k < 4; k++) {
    const turned = rotateTurns(src, size, new Uint8Array(n), k);
    assert.deepEqual(Array.from(turned), Array.from(expected), `${k} turns`);
    const back = flip(rotateTurns(flip(turned), size, new Uint8Array(n), k));
    assert.deepEqual(Array.from(back), Array.from(src), `${k} turns come back`);
    const rgba = Uint8Array.from({ length: n * 4 }, (_, i) => i % 251);
    const words = rotateTurns(rgba, size, new Uint8Array(n * 4), k, 4);
    const unaligned = new Uint8Array(n * 4 + 1).subarray(1);
    unaligned.set(rgba);
    const slow = rotateTurns(unaligned, size, new Uint8Array(n * 4 + 1).subarray(1), k, 4); // per-channel path
    assert.deepEqual(Array.from(slow), Array.from(words), `${k} turns, rgba paths agree`);
    expected = quarter(expected);
  }
});

test('turnTransform maps the canvas like the array turns', () => {
  const size = 8;
  for (let k = 0; k < 4; k++) {
    const [a, b, c, d, e, f] = turnTransform(k, size);
    // centre of pixel (x, y) of the source lands on the centre of its turned pixel
    const x = 1.5, y = 2.5;
    const X = a * x + c * y + e, Y = b * x + d * y + f;
    const sx = [x, Y, size - X, size - Y][k], sy = [y, size - X, size - Y, X][k];
    assert.ok(Math.abs(sx - x) < 1e-9 && Math.abs(sy - y) < 1e-9, `${k} turns`);
  }
});
