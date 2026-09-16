import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRestShape, blurGrid } from '../src/cloth/restShape.js';
import { ClothSolver } from '../src/cloth/solver.js';
import { createWind } from '../src/cloth/wind.js';
import { createStepper } from '../src/cloth/stepper.js';

const DT = 1 / 120;
const small = () => createRestShape({ columns: 24, rows: 10 });

function makeRelief(shape) {
  // a soft bump in the middle of the sheet with a matching mask
  const { columns, rows, count } = shape;
  const depth = new Float32Array(count), mask = new Float32Array(count);
  for (let y = 0; y <= rows; y++) for (let x = 0; x <= columns; x++) {
    const u = x / columns - 0.5, v = y / rows - 0.5;
    const r = Math.hypot(u * 2, v * 2);
    const d = Math.max(0, 1 - r * r);
    const i = y * (columns + 1) + x;
    depth[i] = d; mask[i] = d > 0.05 ? 1 : 0;
  }
  return { depth, mask };
}

function maxDisplacement(solver) {
  let worst = 0;
  for (let i = 0; i < solver.count * 3; i += 3) {
    const d = Math.hypot(solver.pos[i] - solver.rest[i], solver.pos[i + 1] - solver.rest[i + 1], solver.pos[i + 2] - solver.rest[i + 2]);
    if (d > worst) worst = d;
  }
  return worst;
}

test('equilibrium: the rest pose is a fixed point without wind or gravity', () => {
  const solver = new ClothSolver(small(), { gravity: 0 });
  for (let i = 0; i < 240; i++) solver.step(DT, null);
  assert.ok(maxDisplacement(solver) < 1e-5, `moved ${maxDisplacement(solver)}`);
});

test('equilibrium holds after applying a relief (rest lengths were rebuilt)', () => {
  const shape = small();
  const solver = new ClothSolver(shape, { gravity: 0 });
  const { depth, mask } = makeRelief(shape);
  solver.setRelief(depth, mask, 0.3);
  solver.reset();
  for (let i = 0; i < 240; i++) solver.step(DT, null);
  assert.ok(maxDisplacement(solver) < 1e-5, `moved ${maxDisplacement(solver)}`);
  assert.ok(solver.maxStretchStrain() < 1e-5);
});

test('inextensibility: strain stays under 2% in wind after a random kick', () => {
  const solver = new ClothSolver(small());
  const wind = createWind({ speed: 3, turbulence: 1.5 }, 'test');
  const { min, max } = solver.bounds();
  wind.setBounds(min, max);
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5;
  for (let i = 0; i < solver.count * 3; i++) solver.pos[i] += rnd() * 0.1;
  for (let s = 0; s < 240; s++) {
    if (s % 2 === 0) wind.update(s * DT, DT * 2);
    solver.step(DT, wind.sampleAt);
  }
  assert.ok(solver.maxStretchStrain() < 0.02, `strain ${solver.maxStretchStrain()}`);
});

test('attachment: a displaced sheet swings back, faster with higher k, never overshooting', () => {
  const run = (kBase, steps) => {
    const solver = new ClothSolver(small(), { gravity: 0, kBase });
    for (let i = 2; i < solver.count * 3; i += 3) { solver.pos[i] += 0.3; solver.prev[i] += 0.3; }
    const history = [];
    for (let s = 0; s < steps; s++) { solver.step(DT, null); history.push(maxDisplacement(solver)); }
    return history;
  };
  const slow = run(20, 30), fast = run(200, 240);
  // k = 20 -> period 1.4 s, so 30 steps (0.25 s) are still on the way in
  for (let i = 1; i < slow.length; i++) assert.ok(slow[i] <= slow[i - 1] + 1e-9, 'not monotonic');
  assert.ok(fast[9] < slow[9], `fast ${fast[9]} vs slow ${slow[9]}`);
  assert.ok(Math.max(...fast) <= 0.3 + 1e-6, 'overshoot');
  assert.ok(fast[239] < 0.1, `should have mostly settled: ${fast[239]}`);
});

test('relief collider: particles pushed behind the body come back and lose inward velocity', () => {
  const shape = small();
  const solver = new ClothSolver(shape, { gravity: 0, kBase: 0 });
  const { depth, mask } = makeRelief(shape);
  solver.setRelief(depth, mask, 0.3);
  solver.reset();
  const i = Math.floor(shape.rows / 2) * (shape.columns + 1) + Math.floor(shape.columns / 2);
  const k = i * 3;
  for (let c = 0; c < 3; c++) { solver.pos[k + c] -= solver.nRest[k + c] * 0.2; solver.prev[k + c] = solver.pos[k + c] - solver.nRest[k + c] * 0.05; }
  solver.step(DT, null);
  const d = (solver.pos[k] - solver.rest[k]) * solver.nRest[k] + (solver.pos[k + 1] - solver.rest[k + 1]) * solver.nRest[k + 1] + (solver.pos[k + 2] - solver.rest[k + 2]) * solver.nRest[k + 2];
  assert.ok(d >= -solver.params.reliefSlack - 1e-4, `d = ${d}`);
  const vn = ((solver.pos[k] - solver.prev[k]) * solver.nRest[k] + (solver.pos[k + 1] - solver.prev[k + 1]) * solver.nRest[k + 1] + (solver.pos[k + 2] - solver.prev[k + 2]) * solver.nRest[k + 2]) / DT;
  assert.ok(vn >= -1e-6, `inward velocity ${vn}`);
});

test('floor: nothing ends below the floor plane', () => {
  const solver = new ClothSolver(small(), { gravity: -5 });
  for (let i = 1; i < solver.count * 3; i += 3) { solver.pos[i] -= 3; solver.prev[i] -= 3; }
  for (let s = 0; s < 60; s++) solver.step(DT, null);
  for (let i = 1; i < solver.count * 3; i += 3) assert.ok(solver.pos[i] >= solver.params.floorY - 1e-6);
});

test('determinism: two seeded runs are bit-identical', () => {
  const run = () => {
    const solver = new ClothSolver(small());
    const wind = createWind({}, 'seed-42');
    const { min, max } = solver.bounds();
    wind.setBounds(min, max);
    for (let s = 0; s < 120; s++) { wind.update(s * DT, DT); solver.step(DT, wind.sampleAt); }
    return solver.pos;
  };
  const a = run(), b = run();
  assert.deepEqual(Array.from(a), Array.from(b));
});

test('damping: without wind the kinetic energy decays after settling', () => {
  const solver = new ClothSolver(small(), { gravity: 0 });
  let seed = 3;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5;
  for (let i = 0; i < solver.count * 3; i++) solver.pos[i] += rnd() * 0.2;
  for (let s = 0; s < 120; s++) solver.step(DT, null);
  const e0 = solver.kineticEnergy(DT);
  for (let s = 0; s < 240; s++) solver.step(DT, null);
  const e1 = solver.kineticEnergy(DT);
  assert.ok(e1 < e0, `energy grew ${e0} -> ${e1}`);
});

test('density: zero at rest, bounded, and high on a compressed sheet', () => {
  const solver = new ClothSolver(small(), { gravity: 0 });
  solver.updateDensity();
  for (const d of solver.density) assert.ok(d >= 0 && d <= 1);
  assert.ok(Math.max(...solver.density) < 1e-6);
  // hand-fold: squeeze the whole sheet along u toward its centre
  for (let i = 0; i < solver.count * 3; i += 3) solver.pos[i] *= 0.6;
  solver.density.fill(0);
  for (let s = 0; s < 40; s++) solver.updateDensity();
  const rowLength = solver.columns + 1;
  const mid = Math.floor(solver.rows / 2) * rowLength + Math.floor(solver.columns / 2);
  assert.ok(solver.density[mid] > 0.3, `density ${solver.density[mid]}`);
  for (const d of solver.density) assert.ok(d >= 0 && d <= 1);
});

test('implicit drag never overshoots the wind velocity', () => {
  const solver = new ClothSolver(small(), { gravity: 0, kDrag: 1000, kTan: 1000, kLift: 0, kBase: 0, damping: 0 });
  const windZ = 4;
  const sampler = (x, y, z, out) => { out[0] = 0; out[1] = 0; out[2] = windZ; return out; };
  solver.step(DT, sampler);
  for (let i = 0; i < solver.count * 3; i += 3) {
    const vz = (solver.pos[i + 2] - solver.prev[i + 2]) / DT;
    assert.ok(vz <= windZ + 1e-4, `vz ${vz}`);
  }
});

test('stepper: substeps are capped and the remainder carries over', () => {
  const stepper = createStepper({ dt: 1 / 120, maxSubsteps: 4 });
  assert.equal(stepper.advance(1 / 60), 2);
  assert.ok(Math.abs(stepper.accumulator) < 1e-9);
  assert.equal(stepper.advance(1 / 120 * 1.5), 1);
  assert.ok(Math.abs(stepper.accumulator - 1 / 240) < 1e-9);
  assert.equal(stepper.advance(1), 4);
  assert.ok(stepper.accumulator < 1 / 120);
  assert.equal(stepper.advance(NaN), 0);
});

test('blurGrid keeps a constant field constant', () => {
  const shape = small();
  const values = new Float32Array(shape.count).fill(0.7);
  blurGrid(values, shape.columns, shape.rows, 2);
  for (const v of values) assert.ok(Math.abs(v - 0.7) < 1e-6);
});

test('shape matching: a moved and tilted body keeps its shape and is not dragged back to world rest', () => {
  const shape = small();
  const solver = new ClothSolver(shape, { gravity: 0, kBase: 0, kRetention: 400, damping: 0 });
  const { depth, mask } = makeRelief(shape);
  solver.setRelief(depth, mask, 0.3);
  solver.reset();
  // rigidly move the whole sheet: translate + rotate 10° about y around its centroid
  const c = solver.restCentroid, ang = 10 * Math.PI / 180, cs = Math.cos(ang), sn = Math.sin(ang);
  for (let i = 0; i < solver.count * 3; i += 3) {
    const x = solver.pos[i] - c[0], z = solver.pos[i + 2] - c[2];
    const nx = cs * x + sn * z + c[0] + 0.8, nz = -sn * x + cs * z + c[2];
    solver.pos[i] = nx; solver.pos[i + 2] = nz; solver.prev[i] = nx; solver.prev[i + 2] = nz;
  }
  // pairwise rest distances inside the mask should be preserved after settling
  const idx = []; for (let i = 0; i < solver.count; i++) if (solver.mask[i] > 0.9) idx.push(i);
  const dist = (arr, a, b) => Math.hypot(arr[a * 3] - arr[b * 3], arr[a * 3 + 1] - arr[b * 3 + 1], arr[a * 3 + 2] - arr[b * 3 + 2]);
  for (let s = 0; s < 120; s++) solver.step(DT, null);
  let worst = 0;
  for (let n = 0; n < idx.length; n += 7) for (let m = n + 3; m < idx.length; m += 11) {
    const d0 = dist(solver.rest, idx[n], idx[m]), d1 = dist(solver.pos, idx[n], idx[m]);
    worst = Math.max(worst, Math.abs(d1 - d0) / Math.max(1e-6, d0));
  }
  assert.ok(worst < 0.03, `shape distortion ${worst}`);
  // the cluster stayed where it was moved (not pulled back toward world rest)
  let cx = 0, w = 0; for (const i of idx) { cx += solver.pos[i * 3]; w++; }
  assert.ok(cx / w - c[0] > 0.6, `cluster centroid x offset ${cx / w - c[0]}`);
  // rotation was recovered (about 10° around y)
  const R = solver.rotation;
  assert.ok(Math.abs(Math.atan2(R[2], R[0]) - ang) < 0.05, `rotation ${Math.atan2(R[2], R[0])}`);
});

test('reliefScale frees the cloth from the sculpture without forgetting it', () => {
  const shape = small();
  const solver = new ClothSolver(shape, { gravity: 0 });
  const { depth, mask } = makeRelief(shape);
  solver.setRelief(depth, mask, 0.3);
  const shaped = Float32Array.from(solver.rest);
  solver.params.reliefScale = 0;
  solver.refreshReveal();
  // the rest shape is the bare strip again
  for (let i = 0; i < solver.count * 3; i++) assert.ok(Math.abs(solver.rest[i] - shape.base[i]) < 1e-6);
  // and the relief is still there to drive the image
  assert.ok(solver.relief && Math.max(...solver.relief) > 0.9);
  // half scale sits between the two
  solver.params.reliefScale = 0.5;
  solver.refreshReveal();
  const mid = Math.floor(shape.rows / 2) * (shape.columns + 1) + Math.floor(shape.columns / 2);
  const full = Math.hypot(shaped[mid * 3] - shape.base[mid * 3], shaped[mid * 3 + 1] - shape.base[mid * 3 + 1], shaped[mid * 3 + 2] - shape.base[mid * 3 + 2]);
  const half = Math.hypot(solver.rest[mid * 3] - shape.base[mid * 3], solver.rest[mid * 3 + 1] - shape.base[mid * 3 + 1], solver.rest[mid * 3 + 2] - shape.base[mid * 3 + 2]);
  assert.ok(Math.abs(half - full / 2) < 1e-4, `${half} vs ${full / 2}`);
});
