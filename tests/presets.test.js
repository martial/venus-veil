import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, PRESET_NAMES, applyPreset } from '../src/presets.js';
import { createRestShape } from '../src/cloth/restShape.js';
import { ClothSolver } from '../src/cloth/solver.js';
import { createWind } from '../src/cloth/wind.js';

function stubs() {
  const calls = { studio: 0, post: 0, rebuild: 0, projector: [] };
  const solver = new ClothSolver(createRestShape({ columns: 12, rows: 6 }));
  return {
    calls,
    context: {
      wind: createWind({}, 'presets'),
      solver,
      material: { color: { set(v) { this.value = v; } }, userData: { uniforms: { uFresnelAlpha: { value: 0 }, uDensityGain: { value: 0 }, uBacklightStrength: { value: 0 }, uFresnelPower: { value: 0 } } } },
      studio: { params: {}, apply: () => calls.studio++ },
      post: { params: {}, apply: () => calls.post++ },
      sculpture: { params: { amplitude: 0, retention: 0, tintStrength: 0, detail: 0, figureOpacity: 0, veilOpacity: 0 }, state: { loaded: true }, rebuild: () => calls.rebuild++ },
      projector: { params: { enabled: false }, setEnabled(v) { this.params.enabled = v; calls.projector.push(['setEnabled', v]); }, refresh() { calls.projector.push(['refresh']); } },
    },
  };
}

test('there are five looks, each with a label and a note', () => {
  assert.equal(PRESET_NAMES.length, 5);
  for (const name of PRESET_NAMES) {
    const p = PRESETS[name];
    assert.ok(p.label && p.note, name);
    for (const part of ['wind', 'cloth', 'material', 'uniforms', 'studio', 'post', 'sculpture', 'projector']) {
      assert.ok(p[part], `${name} is missing ${part}`);
    }
  }
});

test('applying a look writes through to every live object', () => {
  const { context, calls } = stubs();
  const preset = applyPreset('obsidian', context);
  assert.equal(context.wind.params.speed, preset.wind.speed);
  assert.equal(context.solver.params.bendCompliance, preset.cloth.bendCompliance);
  assert.equal(context.material.opacity, preset.material.opacity);
  assert.equal(context.material.color.value, preset.material.color);
  assert.equal(context.material.userData.uniforms.uDensityGain.value, preset.uniforms.uDensityGain);
  assert.equal(context.studio.params.keyIntensity, preset.studio.keyIntensity);
  assert.equal(context.post.params.exposure, preset.post.exposure);
  assert.equal(calls.studio, 1);
  assert.equal(calls.post, 1);
  assert.equal(context.solver.amplitude, preset.sculpture.amplitude, 'relief reaches the solver');
  assert.equal(context.solver.params.kRetention, preset.sculpture.retention);
  assert.equal(calls.rebuild, 1, 'texture parameters changed, so the sculpture is rebuilt');
});

test('every look drives the projector, with its own prompt and material', () => {
  const prompts = new Set();
  for (const name of PRESET_NAMES) {
    const { context, calls } = stubs();
    const preset = applyPreset(name, context);
    assert.equal(preset.projector.enabled, true, `${name} should project`);
    assert.deepEqual(calls.projector.at(-1), ['setEnabled', true]);
    assert.ok(['diffusion', 'fabric'].includes(context.projector.params.surface));
    assert.ok(preset.projector.prompt.length > 20);
    prompts.add(preset.projector.prompt);
  }
  assert.ok(prompts.size >= 4, 'the looks should not all ask for the same image');
});

test('every look reads the wind-shaped cloth, not a painted figure', () => {
  for (const name of PRESET_NAMES) {
    assert.equal(PRESETS[name].projector.emphasis, 0, `${name} should capture the cloth alone`);
  }
});

test('switching between looks refreshes the projector instead of restarting it', () => {
  const { context, calls } = stubs();
  applyPreset('limestone', context);
  assert.deepEqual(calls.projector.at(-1), ['setEnabled', true]);
  const rebuilds = calls.rebuild;
  applyPreset('obsidian', context);
  assert.deepEqual(calls.projector.at(-1), ['refresh'], 'already on: no restart');
  assert.equal(context.projector.params.power, PRESETS.obsidian.projector.power);
  assert.ok(calls.rebuild > rebuilds, 'texture parameters changed with the look');
  // turning projection off by hand still works
  context.projector.setEnabled(false);
  applyPreset('obsidian', context);
  assert.deepEqual(calls.projector.at(-1), ['setEnabled', true]);
});

test('every look leaves the cloth stable', () => {
  for (const name of PRESET_NAMES) {
    const { context } = stubs();
    applyPreset(name, context);
    const { solver, wind } = context;
    const { min, max } = solver.bounds();
    wind.setBounds(min, max);
    for (let s = 0; s < 240; s++) { if (s % 2 === 0) wind.update(s / 120, 1 / 60); solver.step(1 / 120, wind.sampleAt); }
    assert.ok(solver.maxStretchStrain() < 0.05, `${name}: strain ${solver.maxStretchStrain()}`);
    for (const v of solver.pos) assert.ok(Number.isFinite(v), `${name}: non-finite position`);
  }
});

test('an unknown look is refused', () => {
  assert.throws(() => applyPreset('nope', {}), /unknown preset/);
});

import { LIVE_PRESETS, pickSize, resolveLive } from '../src/presets.js';

test('real-time presets resolve for the service they run against', () => {
  assert.equal(resolveLive('auto', 'cuda'), 'sharp', 'a GPU server can afford 512 px');
  assert.equal(resolveLive('auto', 'coreml (cpu/gpu/ane)'), 'fluid', 'the Mac stays at 256 px');
  assert.equal(resolveLive('auto', null), 'fluid');
  assert.equal(resolveLive('detail', 'cuda'), 'detail');
  assert.equal(resolveLive('nonsense', 'cuda'), 'fluid');
  for (const [name, preset] of Object.entries(LIVE_PRESETS)) {
    if (name === 'auto') continue;
    assert.ok(preset.size >= 256 && preset.maxFps >= 1, name);
  }
});

test('a size the service lacks falls back to the nearest it has', () => {
  assert.equal(pickSize(256, [384, 512, 768]), 384);
  assert.equal(pickSize(768, [256, 384, 512]), 512);
  assert.equal(pickSize(512, [256, 384, 512, 768]), 512);
  assert.equal(pickSize(384, []), 384);
});
