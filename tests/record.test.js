import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickMimeType, exportPlan, pickBitrate, formatProgress, MIME_CANDIDATES, RESOLUTIONS } from '../src/record.js';

test('the container falls back through the candidates', () => {
  assert.equal(pickMimeType(() => true), MIME_CANDIDATES[0]);
  assert.equal(pickMimeType(t => t === 'video/webm'), 'video/webm');
  assert.equal(pickMimeType(t => t.includes('vp8')), 'video/webm;codecs=vp8');
  assert.equal(pickMimeType(() => false), null, 'a browser with no WebM support reports none');
});

test('the plan turns a duration into whole frames', () => {
  assert.deepEqual(exportPlan({ fps: 24, seconds: 8 }), { fps: 24, seconds: 8, frames: 192, dt: 1 / 24 });
  assert.equal(exportPlan({ fps: 30, seconds: 2.5 }).frames, 75);
  // guards: at least one frame, sane rate, capped length
  assert.equal(exportPlan({ fps: 0, seconds: 0 }).frames, 1);
  assert.equal(exportPlan({ fps: 1000, seconds: 1 }).fps, 60);
  assert.equal(exportPlan({ fps: 24, seconds: 9999, maxSeconds: 60 }).seconds, 60);
});

test('bitrate grows with pixels and stays in a sensible band', () => {
  assert.ok(pickBitrate(1280, 720, 24) >= 6e6);
  assert.ok(pickBitrate(1920, 1080, 24) > pickBitrate(1280, 720, 24));
  assert.ok(pickBitrate(3840, 2160, 60) <= 40e6);
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
