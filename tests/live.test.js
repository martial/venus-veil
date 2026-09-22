import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { packLive, unpackLive } from '../src/projection/liveProtocol.js';
import { createLiveTransport } from '../src/projection/liveTransport.js';
import { createLiveClock } from '../src/projection/liveClock.js';
import { serveDirectory } from '../headless/serve.mjs';

test('binary live frames preserve metadata and pixels, including buffer offsets', () => {
  const packet = packLive({ id: 5, status: 200 }, new Uint8Array([0, 255, 17]));
  const padded = new Uint8Array(packet.length + 7); padded.set(packet, 7);
  const { meta, payload } = unpackLive(padded.subarray(7));
  assert.equal(meta.id, 5);
  assert.deepEqual([...payload], [0, 255, 17]);
  assert.throws(() => unpackLive(new Uint8Array(3)));
  assert.throws(() => unpackLive(packLive({ id: -1 })));
  assert.throws(() => unpackLive(new Uint8Array([255, 255, 255, 255])));
});

async function fixture(handler, token = '') {
  const backend = http.createServer(handler);
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const service = `http://127.0.0.1:${backend.address().port}`;
  const page = await serveDirectory('/tmp', 0, { service, token });
  return { page, wsUrl: `${page.url.replace('http:', 'ws:')}/projector/live`,
    async close() { await page.close(); backend.closeAllConnections(); await new Promise(r => backend.close(r)); } };
}

test('live sockets keep the token requirement and reject a foreign browser origin', async () => {
  const f = await fixture((_req, res) => res.end('ok'), 'secret');
  try {
    for (const headers of [{}, { Cookie: 'venus_token=wrong' }, { Cookie: 'venus_token=secret', Origin: 'https://foreign.example' }]) {
      const ws = new WebSocket(f.wsUrl, { headers });
      const [, response] = await once(ws, 'unexpected-response');
      assert.equal(response.statusCode, 403);
      ws.on('error', () => {}); ws.terminate();
    }
    const ws = new WebSocket(f.wsUrl, { headers: { Cookie: 'venus_token=secret', Origin: f.page.url } });
    await once(ws, 'open'); ws.close(); await once(ws, 'close');
  } finally { await f.close(); }
});

test('the live relay generates the newest waiting pose and bounds the inference queue', async () => {
  let release, sawFirst;
  const started = new Promise(r => { sawFirst = r; });
  const generated = [];
  const f = await fixture(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const value = Buffer.concat(chunks)[0]; generated.push(value);
    if (value === 1) { await new Promise(r => { release = r; sawFirst(); }); }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'X-Inference-Ms': '17' }); res.end(Buffer.from([value]));
  });
  const ws = new WebSocket(f.wsUrl); const replies = new Map();
  ws.on('message', data => { const packet = unpackLive(data); replies.set(packet.meta.id, packet); });
  try {
    await once(ws, 'open');
    ws.send(packLive({ id: 1 }, new Uint8Array([1]))); await started;
    const skipped = once(ws, 'message');
    ws.send(packLive({ id: 2 }, new Uint8Array([2])));
    ws.send(packLive({ id: 3 }, new Uint8Array([3])));
    await skipped;
    assert.equal(replies.get(2).meta.status, 204);
    release();
    while (!replies.has(3)) await once(ws, 'message');
    assert.deepEqual(generated, [1, 3]);
    assert.deepEqual([...replies.get(3).payload], [3]);
    assert.equal(replies.get(3).meta.headers['x-inference-ms'], '17');
  } finally { release?.(); ws.terminate(); await f.close(); }
});

test('the browser transport reconnects, cancels requests and uses HTTP for recordings', async () => {
  const f = await fixture((_req, res) => { res.setHeader('Content-Type', 'image/jpeg'); res.end(Buffer.from([9, 8])); });
  const modes = [];
  const transport = createLiveTransport({ endpoint: () => f.page.url + '/projector', Socket: WebSocket, canStream: () => true, onMode: mode => modes.push(mode) });
  try {
    const response = await transport.send(new Uint8Array([1]), { id: 1, signal: AbortSignal.timeout(3000) });
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [9, 8]);
    assert.ok(modes.includes('websocket'));
    await assert.rejects(transport.send(new Uint8Array(), { id: 2, signal: AbortSignal.abort() }), { name: 'AbortError' });
    transport.close();
    assert.equal((await transport.send(new Uint8Array(), { id: 3, signal: AbortSignal.timeout(3000) })).status, 200);
    assert.equal((await transport.send(new Uint8Array(), { id: 4, stream: false })).status, 200);
    assert.equal(modes.at(-1), 'http');
  } finally { transport.close(); await f.close(); }
});

test('an unavailable live socket falls back to HTTP', async () => {
  const backend = http.createServer((_req, res) => res.end('http frame'));
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  backend.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'));
  const transport = createLiveTransport({ endpoint: () => `http://127.0.0.1:${backend.address().port}`, Socket: WebSocket, canStream: () => true });
  try { assert.equal(await (await transport.send(new Uint8Array(), { id: 1 })).text(), 'http frame'); }
  finally { transport.close(); backend.closeAllConnections(); await new Promise(r => backend.close(r)); }
});

test('pacing holds the requested image rate despite display timer jitter and never catches up in bursts', () => {
  const clock = createLiveClock(); let frames = 0;
  for (let i = 0; i < 600; i++) if (clock.take(i * 1000 / 60 + (i % 3) * 0.03, 30)) frames++;
  assert.ok(Math.abs(frames - 300) <= 1, frames);
  assert.equal(clock.take(20000, 30), true);
  assert.equal(clock.take(20000, 30), false);
});

test('FPS measures elapsed throughput rather than averaging reciprocal arrival gaps', () => {
  const clock = createLiveClock();
  clock.presented(0);
  for (let i = 1; i <= 9; i++) clock.presented(500 + i);
  assert.equal(clock.presented(1000), 10);
  clock.reset(); assert.equal(clock.presented(1001), 0);
});
