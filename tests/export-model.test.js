import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveExportSettings } from '../src/projection/exportSettings.js';
import { MODEL_SETTING_KEYS, modelSettings } from '../src/projection/modelSettings.js';
import { assertRecordedEngine } from '../src/projection/recording.js';

test('default export follows every selected live model and its custom tuning', () => {
  const output = { engine: 'fast', ...modelSettings('fast', 'detail'), fps: 30, diffusionFps: 30, quality: 'master' };
  for (const engine of ['fast', 'fine', 'best', 'sdxl', 'klein', 'flux']) {
    const live = { engine, ...modelSettings(engine), seed: 731, reference: 0.8, cnScale: 1.2,
      morphAmount: 0.77, morphSeconds: 19, negative: 'glossy', enabled: false };
    const result = resolveExportSettings(output, live);
    assert.equal(result.engine, engine);
    for (const key of MODEL_SETTING_KEYS) assert.equal(result[key], live[key], key);
    assert.equal(result.fps, 30);
    assert.equal(result.diffusionFps, 30);
    assert.equal(result.quality, 'master');
    assert.equal(output.engine, 'fast', 'following live must not overwrite the separate export preset');
  }
});

test('explicit export model wins over live, and following live again uses current values', () => {
  const output = { useLiveModel: false, engine: 'sdxl', ...modelSettings('sdxl', 'detail'), seed: 16 };
  const live = { engine: 'klein', ...modelSettings('klein'), seed: 91 };
  assert.deepEqual(resolveExportSettings(output, live), output);
  live.engine = 'fine';
  Object.assign(live, modelSettings('fine'), { steps: 11 });
  assert.equal(resolveExportSettings(output, live).engine, 'sdxl');
  output.useLiveModel = true;
  assert.equal(resolveExportSettings(output, live).engine, 'fine');
  assert.equal(resolveExportSettings(output, live).steps, 11);
  output.useLiveModel = false;
  assert.equal(resolveExportSettings(output, live).modelSize, 1024);
  assert.equal(resolveExportSettings(output, live).seed, 16);
});

test('recording captures the selection before asynchronous preparation', () => {
  const live = { engine: 'klein', ...modelSettings('klein'), morphAmount: 0.7 };
  const output = { engine: 'fast', ...modelSettings('fast'), fps: 30 };
  const captured = resolveExportSettings(output, live);
  Object.assign(live, modelSettings('fast'), { engine: 'fast' });
  output.fps = 60;
  assert.equal(captured.engine, 'klein');
  assert.equal(captured.morphAmount, 0.7);
  assert.equal(captured.fps, 30);
});

test('recording refuses images attributed to a different model or no model', () => {
  assert.doesNotThrow(() => assertRecordedEngine('klein', 'klein'));
  assert.throws(() => assertRecordedEngine('klein', 'fast'), /requested klein.*returned fast/);
  assert.throws(() => assertRecordedEngine('klein', null), /no model identifier/);
});
