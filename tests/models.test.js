import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_ENGINES, modelNote } from '../src/projection/models.js';
import { parseArgs } from '../headless/options.mjs';

test('optional export models survive CLI parsing without falling back to live', () => {
  for (const engine of ['sdxl', 'klein', 'flux']) {
    assert.ok(Object.values(IMAGE_ENGINES).includes(engine));
    assert.equal(parseArgs(['--engine', engine]).engine, engine);
  }
});

test('model descriptions distinguish missing weights from image-reference limitations', () => {
  assert.equal(modelNote('flux', { engines: ['fast'], models: { flux: { available: false, reason: 'Install weights first.' } } }), 'Install weights first.');
  assert.match(modelNote('klein', { engines: ['klein'] }), /experimental/);
  assert.match(modelNote('flux', { engines: ['flux'] }), /identity is not preserved/);
});
