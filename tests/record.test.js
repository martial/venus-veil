import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickMimeType, extensionFor, exportPlan, pickBitrate, formatProgress, MIME_CANDIDATES, QUALITIES, RESOLUTIONS } from '../src/record.js';

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
