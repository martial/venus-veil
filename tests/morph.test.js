import test from 'node:test';
import assert from 'node:assert/strict';
import { createMorphTimeline, morphFrame } from '../src/projection/morph.js';
import { applyModelPreset, applyMorphPreset, createModelSettingsBank, modelSettings, selectedModelPreset, selectedMorphPreset } from '../src/projection/modelSettings.js';
import { recordProjectedFrame } from '../src/projection/recording.js';

test('live morph follows elapsed display time regardless of generation frame rate', () => {
  const params = { engine: 'klein', ...modelSettings('klein') };
  const a = createMorphTimeline(), b = createMorphTimeline();
  for (let i = 0; i < 120; i++) a.advance(1 / 60, params);
  for (let i = 0; i < 60; i++) b.advance(1 / 30, params);
  assert.ok(Math.abs(a.phase(params) - b.phase(params)) < 1e-12);
  const before = a.phase(params);
  a.advance(.1, params, false);
  assert.equal(a.phase(params), before);
  params.morphSeconds = 24;
  assert.equal(a.phase(params), before, 'changing speed must not jump to a different latent position');
});

test('offline morph uses video timestamps and retries keep the same phase', async () => {
  const params = { engine: 'klein', ...modelSettings('klein') };
  const timeline = createMorphTimeline();
  timeline.advance(.1, params);
  assert.equal(timeline.phase(params, 6), .5);
  assert.equal(timeline.phase(params, 0), 0);
  const seen = [];
  const projector = { state: { status: 'ready' }, async frame({ videoTime }) {
    seen.push(timeline.phase(params, videoTime));
    return seen.length === 1 ? undefined : 8;
  } };
  await recordProjectedFrame(projector, { videoTime: 6, pause: async () => {} });
  assert.deepEqual(seen, [.5, .5]);
  assert.equal(timeline.phase(params, 6), .5, 'restarting an export reproduces the same latent');
});

test('morph presets are separate from quality and remembered per model', () => {
  const params = { engine: 'klein', ...modelSettings('klein') };
  const select = createModelSettingsBank(params);
  applyMorphPreset(params, 'dream');
  applyModelPreset(params, 'speed');
  assert.equal(selectedMorphPreset(params), 'dream');
  assert.equal(selectedModelPreset(params), 'speed');
  select('fine');
  assert.deepEqual(morphFrame(params, 10), { morph_amount: 0, morph_phase: 0 });
  select('klein');
  assert.equal(selectedMorphPreset(params), 'dream');
  applyMorphPreset(params, 'still');
  assert.deepEqual(morphFrame(params, 10), { morph_amount: 0, morph_phase: 0 });
});
