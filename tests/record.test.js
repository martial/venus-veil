import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickMimeType, extensionFor, exportPlan, pickBitrate, formatProgress, cameraAngle, createFrameWriter, diffusionInterval, evenSize, whenVisible, MIME_CANDIDATES, QUALITIES, RESOLUTIONS } from '../src/record.js';

test('MP4 is preferred, WebM is the fallback, and the extension follows', () => {
  const all = () => true;
  assert.equal(pickMimeType(all), MIME_CANDIDATES.mp4[0]);
  assert.equal(pickMimeType(all, 'webm'), MIME_CANDIDATES.webm[0]);
  // a browser without MP4 recording still gets a file
  const noMp4 = t => !t.startsWith('video/mp4');
  assert.equal(pickMimeType(noMp4, 'mp4'), MIME_CANDIDATES.webm[0]);
  // and one with only baseline H.264 picks that profile
  const baseline = t => t.includes('42E01E');
  assert.equal(pickMimeType(baseline), 'video/mp4;codecs=avc1.42E01E');
  assert.equal(pickMimeType(() => false), null, 'a browser that records nothing reports none');
  assert.equal(extensionFor(MIME_CANDIDATES.mp4[0]), 'mp4');
  assert.equal(extensionFor(MIME_CANDIDATES.webm[0]), 'webm');
  assert.equal(extensionFor(), 'webm');
});

test('the plan turns a duration into whole frames', () => {
  assert.deepEqual(exportPlan({ fps: 24, seconds: 8 }), { fps: 24, seconds: 8, frames: 192, dt: 1 / 24 });
  assert.equal(exportPlan({ fps: 30, seconds: 2.5 }).frames, 75);
  // guards: at least one frame, sane rate, capped length
  assert.equal(exportPlan({ fps: 0, seconds: 0 }).frames, 1);
  assert.equal(exportPlan({ fps: 1000, seconds: 1 }).fps, 60);
  assert.equal(exportPlan({ fps: 24, seconds: 9999, maxSeconds: 60 }).seconds, 60);
});

test('bitrate grows with pixels and with the quality setting', () => {
  assert.ok(pickBitrate(1280, 720, 24) >= 4e6, 'even a small clip gets a usable bitrate');
  assert.ok(pickBitrate(1920, 1080, 24) > pickBitrate(1280, 720, 24));
  assert.ok(pickBitrate(1920, 1080, 24, 'master') > pickBitrate(1920, 1080, 24, 'standard'));
  assert.equal(pickBitrate(1920, 1080, 24, 'master'), pickBitrate(1920, 1080, 24, 'standard') * QUALITIES.master);
  assert.ok(pickBitrate(3840, 2160, 60, 'master') <= 200e6);
  assert.equal(pickBitrate(1920, 1080, 24, 'nonsense'), pickBitrate(1920, 1080, 24, 'high'));
});

test('progress reports a fraction and a countdown', () => {
  const half = formatProgress(50, 100, 0, 10_000);
  assert.equal(half.done, 0.5);
  assert.match(half.text, /50 \/ 100/);
  assert.match(half.text, /0:10 left/);
  assert.equal(formatProgress(0, 100, 0, 1000).done, 0);
  assert.match(formatProgress(30, 60, 0, 60_000).text, /1:00 left/, 'half done after a minute means a minute to go');
});

test('the resolution list offers the viewport and three fixed sizes', () => {
  assert.equal(RESOLUTIONS.viewport, null);
  assert.deepEqual(RESOLUTIONS['1920 × 1080'], [1920, 1080]);
  for (const [label, size] of Object.entries(RESOLUTIONS)) {
    if (!size) continue;
    assert.ok(size[0] % 2 === 0 && size[1] % 2 === 0, `${label} must be even for video encoders`);
  }
});

test('the clip keeps its own frame rate while the diffusion updates more slowly', () => {
  assert.equal(diffusionInterval(60, 8), 8, 'a new image every 8th frame of a 60 fps clip');
  assert.equal(diffusionInterval(60, 60), 1);
  assert.equal(diffusionInterval(24, 8), 3);
  assert.equal(diffusionInterval(60, 100), 1, 'never faster than the clip itself');
  assert.equal(diffusionInterval(60, 0), 1, 'a missing rate means every frame');
  assert.ok(diffusionInterval(60, 0.25) > 60, 'a very slow diffusion holds one image for seconds');
});

test('the camera holds still, then eases into an orbit', () => {
  const path = { hold: 0.2, degrees: 40 };
  assert.equal(cameraAngle(0, path), 0);
  assert.equal(cameraAngle(0.2, path), 0, 'still for the first fifth of the clip');
  assert.ok(cameraAngle(0.25, path) < 1, 'and it starts gently');
  assert.equal(cameraAngle(1, path), 40, 'the full orbit is travelled by the end');
  assert.ok(Math.abs(cameraAngle(0.6, path) - 20) < 0.01, 'halfway through the move is halfway round');
  // monotonic, never jumping back
  let previous = -1;
  for (let p = 0; p <= 1.001; p += 0.02) {
    const angle = cameraAngle(p, path);
    assert.ok(angle >= previous - 1e-9, `went backwards at ${p}`);
    previous = angle;
  }
  assert.equal(cameraAngle(2, path), 40, 'clamped past the end');
  assert.equal(cameraAngle(0.5, { hold: 0, degrees: 0 }), 0, 'no orbit means no movement');
});

test('a 32 second clip at 60 fps is whole frames at a master bitrate', () => {
  const plan = exportPlan({ fps: 60, seconds: 32, maxSeconds: 120 });
  assert.equal(plan.frames, 1920);
  assert.equal(plan.dt, 1 / 60);
  const bitrate = pickBitrate(3840, 2160, 60, 'master');
  assert.ok(bitrate <= 120e6, 'a 4K master stays under the cap');
  assert.ok(bitrate >= 60e6, 'and still uses a high bitrate');
});

test('export dimensions are rounded to even numbers for H.264', () => {
  assert.deepEqual(evenSize(1800, 1043), [1800, 1042]);
  assert.deepEqual(evenSize(1921, 1081), [1920, 1080]);
  assert.deepEqual(evenSize(3840, 2160), [3840, 2160]);
  assert.deepEqual(evenSize(1, 1), [2, 2], 'never zero-sized');
});

test('every frame is stamped by its index, never by the clock', async () => {
  const added = [];
  const output = { started: false, finalized: false, target: { buffer: new ArrayBuffer(8) }, addVideoTrack() {}, async start() { this.started = true; }, async finalize() { this.finalized = true; }, async cancel() {} };
  const source = { async add(timestamp, duration) { added.push([timestamp, duration]); } };
  const writer = await createFrameWriter({}, { fps: 60, format: 'mp4' }, {
    createOutput: () => output,
    createSource: () => source,
  });
  assert.equal(output.started, true, 'the file is opened before any frame');
  for (let i = 0; i < 5; i++) {
    // a slow frame must not become a long frame
    await new Promise(resolve => setTimeout(resolve, i === 2 ? 30 : 0));
    await writer.frame();
  }
  assert.equal(writer.frames, 5);
  assert.deepEqual(added.map(([t]) => +t.toFixed(6)), [0, 1 / 60, 2 / 60, 3 / 60, 4 / 60].map(t => +t.toFixed(6)));
  for (const [, duration] of added) assert.equal(duration, 1 / 60);
  assert.equal(writer.extension, 'mp4');
  const blob = await writer.finish();
  assert.equal(output.finalized, true);
  assert.equal(blob.type, 'video/mp4');
});

test('WebM export asks for VP9 in a WebM container', async () => {
  let config = null;
  const output = { target: { buffer: new ArrayBuffer(4) }, addVideoTrack() {}, async start() {}, async finalize() {}, async cancel() {} };
  const writer = await createFrameWriter({}, { fps: 24, format: 'webm' }, {
    createOutput: () => output,
    createSource: (canvas, c) => { config = c; return { async add() {} }; },
  });
  assert.equal(config.codec, 'vp9');
  assert.equal(writer.extension, 'webm');
  assert.equal((await writer.finish()).type, 'video/webm');
});

test('a hidden page makes the recording wait', async () => {
  const listeners = new Set();
  const doc = { visibilityState: 'hidden', addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
  const waited = whenVisible(doc);
  let settled = false;
  waited.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(settled, false, 'still waiting while hidden');
  doc.visibilityState = 'visible';
  listeners.forEach(fn => fn());
  assert.equal(await waited, true, 'resumes when the page comes back');
  assert.equal(await whenVisible({ visibilityState: 'visible' }), false, 'a visible page never waits');
});
