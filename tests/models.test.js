import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_ENGINES, modelNote } from '../src/projection/models.js';
import { parseArgs } from '../headless/options.mjs';
import { applyModelPreset, createModelSettingsBank, modelControlSpecs, modelSettings, MODEL_PRESETS,
  selectedModelPreset, snapshotModelSettings } from '../src/projection/modelSettings.js';

test('optional export models survive CLI parsing without falling back to live', () => {
  for (const engine of ['sdxl', 'klein', 'flux']) {
    assert.ok(Object.values(IMAGE_ENGINES).includes(engine));
    assert.equal(parseArgs(['--engine', engine]).engine, engine);
  }
});

test('each model has working presets and only exposes supported controls', () => {
  for (const engine of Object.values(IMAGE_ENGINES)) {
    for (const preset of Object.keys(MODEL_PRESETS[engine])) {
      const state = { engine, ...modelSettings(engine, preset) };
      assert.equal(selectedModelPreset(state), preset);
      for (const control of modelControlSpecs(engine)) assert.notEqual(state[control.key], undefined);
    }
  }
  for (const engine of ['fast', 'sdxl', 'klein']) {
    assert.ok(!modelControlSpecs(engine).some(control => control.key === 'steps'));
  }
  for (const engine of ['flux', 'klein']) {
    assert.ok(!modelControlSpecs(engine).some(control => control.key === 'cnScale'));
  }
  assert.ok(!modelControlSpecs('flux').some(control => control.key === 'reference'));
});

test('model switches remember custom tuning, and live and export banks stay separate', () => {
  const live = { engine: 'fine', ...modelSettings('fine') };
  const output = { engine: 'fine', ...modelSettings('fine') };
  const selectLive = createModelSettingsBank(live), selectOutput = createModelSettingsBank(output);
  live.steps = 11;
  live.reference = 0.6;
  output.steps = 22;
  selectLive('sdxl');
  assert.equal(live.cfg, 0);
  assert.equal(live.steps, 4);
  selectLive('fine');
  selectOutput('flux');
  selectOutput('fine');
  assert.equal(live.steps, 11);
  assert.equal(live.reference, 0.6);
  assert.equal(output.steps, 22);
  assert.equal(output.reference, 1);
  assert.equal(selectedModelPreset(live), 'custom');
});

test('export settings replace and restore every inference setting, including zero guidance', () => {
  const live = { engine: 'fine', ...modelSettings('fine'), cfg: 7, negative: 'glossy' };
  const before = snapshotModelSettings(live);
  const output = { engine: 'sdxl', ...modelSettings('sdxl', 'detail') };
  Object.assign(live, snapshotModelSettings(output));
  assert.equal(live.cfg, 0);
  assert.equal(live.modelSize, 1024);
  assert.equal(live.negative, '');
  Object.assign(live, before);
  assert.equal(live.cfg, 7);
  assert.equal(live.negative, 'glossy');
});

test('presets preserve the seed and text and disable recursive carry', () => {
  const target = { engine: 'best', ...modelSettings('best'), seed: 91, negative: 'plastic', carry: 0.5 };
  applyModelPreset(target, 'detail');
  assert.equal(target.seed, 91);
  assert.equal(target.negative, 'plastic');
  assert.equal(target.steps, 28);
  assert.equal(target.carry, 0);
});

test('model descriptions distinguish missing weights from image-reference limitations', () => {
  assert.equal(modelNote('flux', { engines: ['fast'], models: { flux: { available: false, reason: 'Install weights first.' } } }), 'Install weights first.');
  assert.match(modelNote('klein', { engines: ['klein'] }), /experimental/);
  assert.match(modelNote('flux', { engines: ['flux'] }), /identity is not preserved/);
});
