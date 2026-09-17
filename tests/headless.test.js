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
