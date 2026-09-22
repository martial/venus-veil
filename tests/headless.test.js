import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, estimate, parseArgs, validate } from '../headless/options.mjs';
import { PAGE_API } from '../headless/page-api.mjs';

test('the defaults render something sensible', () => {
  const o = validate(DEFAULTS);
  assert.equal(o.frameCount, 8 * 60);
  assert.equal(o.interval, 10, 'six images a second at 60 fps');
  assert.equal(o.imageCount, 48);
});

test('flags map onto options, in kebab or plain form', () => {
  const o = parseArgs(['--look', 'obsidian', '--engine', 'fine', '--seconds', '4', '--fps', '30',
    '--images-per-second', '3', '--keep-frames', '--no-gpu', '--out', 'x.mp4']);
  assert.equal(o.look, 'obsidian');
  assert.equal(o.engine, 'fine');
  assert.equal(o.frameCount, 120);
  assert.equal(o.interval, 10);
  assert.equal(o.keepFrames, true);
  assert.equal(o.gpu, false);
  assert.equal(o.out, 'x.mp4');
});

test('nonsense is refused with a message, not a stack trace', () => {
  assert.throws(() => parseArgs(['--look', 'banana']), /look must be one of/);
  assert.throws(() => parseArgs(['--engine', 'turbo']), /engine must be one of/);
  assert.throws(() => parseArgs(['--generated', '640']), /generated must be/);
  assert.throws(() => parseArgs(['--seconds']), /needs a value/);
  assert.throws(() => parseArgs(['--seconds', 'soon']), /needs a number/);
  assert.throws(() => parseArgs(['--wat', '1']), /unknown option/);
  assert.throws(() => parseArgs(['seconds']), /unexpected argument/);
  assert.equal(parseArgs(['--help']).help, true);
});

test('values are clamped, and dimensions made even for H.264', () => {
  const o = parseArgs(['--width', '1921', '--height', '1081', '--carry', '5', '--hold', '9',
    '--crf', '99', '--fps', '999', '--images-per-second', '1000']);
  assert.deepEqual([o.width, o.height], [1920, 1080]);
  assert.equal(o.carry, 0.9);
  assert.equal(o.hold, 0.8);
  assert.equal(o.crf, 51);
  assert.equal(o.fps, 120);
  assert.equal(o.imagesPerSecond, 120, 'never more images than frames');
  assert.equal(o.interval, 1);
});

test('the estimate reads in minutes or hours', () => {
  const short = estimate(validate({ ...DEFAULTS, seconds: 4, imagesPerSecond: 2, engine: 'fine' }));
  assert.match(short.text, /min/);
  const long = estimate(validate({ ...DEFAULTS, seconds: 32, imagesPerSecond: 60, engine: 'best' }));
  assert.match(long.text, /^\d+ h \d\d$/);
});

test('the injected page helper only uses what the app exposes', () => {
  assert.match(PAGE_API, /window\.__veilHeadless/);
  for (const name of ['prepare', 'frame', 'stats']) assert.ok(PAGE_API.includes(`${name}(`), name);
  // it must not reach for modules the page does not publish
  assert.ok(!PAGE_API.includes('veil.THREE'), 'no three.js dependency');
  assert.ok(!/\bimport\b/.test(PAGE_API), 'no imports: it is injected as plain source');
});

import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveDirectory } from '../headless/serve.mjs';
import { defaultEndpoint, wireFormat } from '../src/projection/projector.js';

const get = (url, headers = {}) => new Promise((resolve, reject) => {
  http.get(url, { headers }, response => {
    let body = '';
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
  }).on('error', reject);
});

test('a token opens the page once, then a cookie carries it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'venus-serve-'));
  await writeFile(path.join(root, 'index.html'), '<title>venus</title>');
  await writeFile(path.join(root, 'app.js'), 'console.log(1)');
  const server = await serveDirectory(root, 5299, { token: 'secret' });
  try {
    assert.equal((await get('http://127.0.0.1:5299/')).status, 401, 'no token, no page');
    assert.equal((await get('http://127.0.0.1:5299/?token=wrong')).status, 401);
    const opened = await get('http://127.0.0.1:5299/?token=secret');
    assert.equal(opened.status, 200);
    const cookie = opened.headers['set-cookie']?.[0]?.split(';')[0];
    assert.equal(cookie, 'venus_token=secret');
    const asset = await get('http://127.0.0.1:5299/app.js', { cookie });
    assert.equal(asset.status, 200, 'assets pass with the cookie');
    assert.equal((await get('http://127.0.0.1:5299/app.js', { 'x-venus-token': 'secret' })).status, 200);
  } finally {
    await server.close();
  }
});

test('the page finds its diffusion service wherever it is served', () => {
  const at = href => { const u = new URL(href); return { hostname: u.hostname, port: u.port, origin: u.origin }; };
  assert.equal(defaultEndpoint(at('http://127.0.0.1:5190/')), 'http://127.0.0.1:5193', 'dev server on this Mac');
  assert.equal(defaultEndpoint(at('https://martial.github.io/venus-veil/')), 'http://127.0.0.1:5193', 'published page');
  assert.equal(defaultEndpoint(at('https://abc123-5191.proxy.runpod.net/')), 'https://abc123-5191.proxy.runpod.net/projector', 'a pod');
  assert.equal(defaultEndpoint(null), 'http://127.0.0.1:5193');
});

test('frames travel raw on the loopback and as JPEG across the internet', () => {
  assert.equal(wireFormat('http://127.0.0.1:5193'), 'rgba');
  assert.equal(wireFormat('http://localhost:5191/projector'), 'rgba');
  assert.equal(wireFormat('https://abc123-8888.proxy.runpod.net/projector'), 'jpeg');
  assert.equal(wireFormat('not a url'), 'rgba');
});
