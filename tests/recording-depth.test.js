import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { recordProjectedFrame } from '../src/projection/recording.js';
import { PAGE_API } from '../headless/page-api.mjs';

test('recording retries skipped captures instead of accepting an unrelated live reply', async () => {
  let attempts = 0;
  const projector = {
    state: { status: 'ready', presented: 10 },
    async frame(options) {
      assert.equal(options.strict, true);
      this.state.presented++;
      return ++attempts === 3 ? 24 : undefined;
    },
  };
  assert.equal(await recordProjectedFrame(projector, { pause: async () => {} }), 24);
  assert.equal(attempts, 3);
});

test('recording fails instead of exporting stale light when depth generation fails', async () => {
  const projector = { state: { status: 'ready' }, frame: async () => { throw new Error('ControlNet failed'); } };
  await assert.rejects(recordProjectedFrame(projector), /ControlNet failed/);
  projector.frame = async () => undefined;
  await assert.rejects(recordProjectedFrame(projector, { pause: async () => {} }), /No image received for the recorded depth/);
});

test('recording refreshes service readiness and never silently skips generation while offline', async () => {
  const projector = { state: { status: 'loading' }, health: async () => {}, frame: () => assert.fail('not ready') };
  await assert.rejects(recordProjectedFrame(projector, { pause: async () => {} }), /No image received/);
  projector.health = async () => { projector.state.status = 'ready'; };
  projector.frame = async () => 7;
  assert.equal(await recordProjectedFrame(projector), 7);
});

test('headless export freezes the live clock and waits for depth before recording each pose', async () => {
  let live = true, pose = 0, releaseDepth, releaseImage;
  const depths = [], renders = [];
  const depthReady = new Promise(resolve => { releaseDepth = resolve; });
  const imageReady = new Promise(resolve => { releaseImage = resolve; });
  const veil = {
    sculpture: { whenReady: () => depthReady, update() {} },
    renderer: { setAnimationLoop(value) { assert.equal(value, null); live = false; }, shadowMap: {} },
    projector: {
      params: { size: 512, enabled: true }, state: { status: 'ready', presented: 0 },
      async prepareRecording() { assert.equal(live, false); },
      async recordFrame() {
        depths.push(pose);
        await imageReady;
        assert.equal(pose, depths.at(-1), 'cloth must remain at its captured pose during inference');
        this.state.presented++;
      },
      update() {},
    },
    solver: { time: 0, step() { pose++; }, updateDensity() {} },
    stepper: { dt: 1 / 120 }, wind: { update() {}, sampleAt() {} }, ribbon: { sync() {} },
    quality: { params: {}, reset() {} }, applyQuality() {},
    camera: { position: { x: 0, y: 1, z: 5 } }, controls: { target: { x: 0, y: 1, z: 0 } },
    studio: { update() {} }, post: { render() { renders.push(pose); } },
  };
  const window = { __veil: veil };
  vm.runInNewContext(PAGE_API, { window, document: { createElement: () => ({}), head: { appendChild() {} } }, performance });
  const api = window.__veilHeadless;
  const preparing = api.prepare({ fps: 60, interval: 1, frames: 2, orbit: 0, engine: 'fine', generated: 512 });
  await Promise.resolve(); assert.equal(live, true, 'depth preparation has not finished');
  releaseDepth(); await preparing;
  assert.equal(live, false);
  const frame = api.frame(0);
  await Promise.resolve();
  assert.deepEqual(depths, [2]); assert.deepEqual(renders, []);
  releaseImage(); await frame; await api.frame(1);
  assert.deepEqual(depths, [2, 4]); assert.deepEqual(renders, depths);
});
