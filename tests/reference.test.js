import test from 'node:test';
import assert from 'node:assert/strict';
import { createReferenceUpload } from '../src/projection/reference.js';
import { GUIDE_MAX, PRESETS, guidedPrompt, promptForReference } from '../src/presets.js';

const A = '0123456789abcdef', B = 'fedcba9876543210';
const photo = () => new Blob(['photo'], { type: 'image/jpeg' });
const answer = (id, caption = '') => Response.json({ id, caption });
function fixture() {
  const requests = [];
  const state = { endpoint: 'https://pod/projector', status: 'ready', references: true };
  let changed = 0, time = 0;
  const ref = createReferenceUpload({
    state, onChange: () => changed++, now: () => time,
    fetcher: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })),
  });
  return { ref, state, requests, get changed() { return changed; }, tick: ms => { time += ms; } };
}

test('a replacement photo blocks unconditioned frames and late uploads cannot restore the old subject', async () => {
  const f = fixture();
  const first = f.ref.set(photo());
  assert.equal(f.ref.ready, false);
  const second = f.ref.set(photo());
  assert.equal(f.requests[0].options.signal.aborted, true);
  f.requests[1].resolve(answer(B, 'a green dragon'));
  await second;
  f.requests[0].resolve(answer(A, 'a statue of a woman'));
  await first;
  assert.equal(f.state.referenceId, B);
  assert.equal(f.state.referenceCaption, 'a green dragon');
  assert.equal(f.ref.ready, true);
  assert.equal(f.changed, 2, 'each change invalidates the previous projected frames');
  await f.ref.ensure();
  assert.equal(f.requests.length, 2, 'the ready photo is uploaded only once');
});

test('a failed upload stays unready, reports the error and retries without flooding the service', async () => {
  const f = fixture();
  const first = f.ref.set(photo());
  f.requests[0].resolve(new Response('busy', { status: 503 }));
  await first;
  assert.equal(f.ref.ready, false);
  assert.equal(f.state.referenceError, 'busy');
  await f.ref.ensure();
  assert.equal(f.requests.length, 1);
  f.tick(2001);
  const retry = f.ref.ensure();
  assert.equal(f.ref.ensure(), retry, 'live requests share one upload');
  f.requests[1].resolve(answer(A));
  await retry;
  assert.equal(f.ref.ready, true);
  assert.equal(f.state.referenceError, null);
});

test('clearing a photo while its upload is in flight cannot bring it back', async () => {
  const f = fixture();
  const pending = f.ref.set(photo());
  await f.ref.set(null);
  f.requests[0].resolve(answer(A, 'old subject'));
  await pending;
  assert.equal(f.state.referenceId, null);
  assert.equal(f.state.referenceCaption, '');
  assert.equal(f.ref.hasPhoto, false);
  assert.equal(f.ref.ready, true);
});

test('a new service and a lost server reference both require a fresh upload', async () => {
  const f = fixture();
  let pending = f.ref.set(photo());
  f.requests[0].resolve(answer(A));
  await pending;
  f.state.endpoint = 'https://another-pod/projector';
  assert.equal(f.ref.ready, false);
  pending = f.ref.ensure();
  assert.equal(f.requests[1].url, 'https://another-pod/projector/reference');
  f.requests[1].resolve(answer(B));
  await pending;
  f.ref.invalidate(A);
  assert.equal(f.ref.ready, true, 'an old frame cannot invalidate the newer reference');
  f.ref.invalidate(B);
  assert.equal(f.ref.ready, false);
  pending = f.ref.ensure();
  f.requests[2].resolve(answer(B));
  await pending;
  assert.equal(f.ref.ready, true);
});

test('photos selected before health is ready upload when the service comes online', async () => {
  const f = fixture();
  f.state.status = 'offline';
  await f.ref.set(photo());
  assert.equal(f.requests.length, 0);
  assert.equal(f.ref.ready, false);
  f.state.status = 'ready';
  const pending = f.ref.ensure();
  f.requests[0].resolve(answer(A));
  await pending;
  assert.equal(f.ref.ready, true);
});

test('every look takes its subject from the photo, and preserves the selected finish', () => {
  for (const preset of Object.values(PRESETS)) {
    const prompt = promptForReference(preset.projector.prompt, 'a green dragon');
    assert.ok(prompt.startsWith('a green dragon,'));
    assert.ok(prompt.includes(preset.photoStyle));
    assert.doesNotMatch(prompt, /venus|breasts|braided head|round belly/i);
    assert.doesNotMatch(promptForReference(preset.projector.prompt), /venus/i, 'older services without captions still remove the Venus subject');
  }
  const custom = 'a red balloon floating over water';
  assert.equal(promptForReference(custom, 'a green dragon'), custom);
});

test('a guide goes in front of the prompt, and an empty guide leaves it alone', () => {
  const prompt = promptForReference(PRESETS.bronze.projector.prompt, 'a green dragon');
  assert.equal(guidedPrompt('', prompt), prompt);
  assert.equal(guidedPrompt('   ', prompt), prompt);
  assert.equal(guidedPrompt(undefined, prompt), prompt);
  assert.equal(guidedPrompt('  smiling,\n eyes closed ,  ', prompt), `smiling, eyes closed, ${prompt}`);
  assert.ok(guidedPrompt('x'.repeat(1000), prompt).startsWith(`${'x'.repeat(GUIDE_MAX)}, `));
});
