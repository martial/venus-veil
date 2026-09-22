import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQuality, LEVELS } from '../src/render/quality.js';

const feed = (q, ms, frames = 200) => { let changes = 0; for (let i = 0; i < frames; i++) if (q.sample(ms)) changes++; return changes; };

test('slow frames lower the resolution first, then the detail step', () => {
  const q = createQuality({ maxScale: 1, floor: 24, target: 50 });
  feed(q, 1000 / 12, 400);
  assert.ok(q.params.scale <= 0.56, `scale ${q.params.scale}`);
  assert.equal(q.params.level, LEVELS.length - 1, 'reached the last detail step');
  assert.ok(q.settings.beamSteps < LEVELS[0].beamSteps && q.settings.samples === 0);
});

test('fast frames climb back to full quality and stop there', () => {
  const q = createQuality({ maxScale: 1, floor: 24, target: 50 });
  feed(q, 1000 / 10, 400);
  feed(q, 1000 / 120, 1200);
  assert.equal(q.params.level, 0);
  assert.ok(Math.abs(q.params.scale - 1) < 1e-6, `scale ${q.params.scale}`);
  assert.equal(q.sample(1000 / 120), false, 'no further changes at full quality');
});

test('a frame rate between floor and target is left alone', () => {
  const q = createQuality({ maxScale: 1, floor: 24, target: 50 });
  assert.equal(feed(q, 1000 / 35, 300), 0);
  assert.equal(q.params.scale, 1);
  assert.equal(q.params.level, 0);
});

test('manual mode and junk samples change nothing', () => {
  const q = createQuality({ maxScale: 1 });
  q.params.auto = false;
  assert.equal(feed(q, 1000 / 5, 200), 0);
  q.params.auto = true;
  assert.equal(q.sample(NaN), false);
  assert.equal(q.sample(0), false);
  assert.equal(q.sample(5000), false);
  assert.ok(q.params.frameMs > 0);
});

test('quality can recover on a 60 Hz display without needing impossible 75 fps', () => {
  const q = createQuality({ maxScale: 1, floor: 48, target: 60 });
  q.reset(0.55, 2);
  feed(q, 1000 / 60, 1600);
  assert.equal(q.params.level, 0);
  assert.equal(q.params.scale, 1);
});
