import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createActivity } from '../headless/activity.mjs';
import { serveDirectory } from '../headless/serve.mjs';

test('presence deduplicates heartbeats, removes closed sessions, and expires abandoned tabs', () => {
  let now = 0;
  const activity = createActivity({ now: () => now });
  assert.equal(activity.connected, 0);
  assert.equal(activity.touch('invalid'), false);
  activity.touch('session-123456789');
  activity.touch('session-123456789');
  activity.touch('session-234567890');
  assert.equal(activity.connected, 2);
  activity.leave('session-234567890');
  assert.equal(activity.connected, 1);
  now = 29000; activity.touch('session-123456789');
  now = 58000; assert.equal(activity.connected, 1);
  now = 59000; assert.equal(activity.connected, 0);
});

test('activity shares health reads and reports unknown counts when the GPU service is offline', async () => {
  let calls = 0, now = 0;
  const activity = createActivity({ service: 'http://gpu', now: () => now, fetcher: async () => {
    calls++;
    if (calls > 1) throw new Error('offline');
    return Response.json({ status: 'ready', active_jobs: 1, queued_jobs: 2, generated: 12 });
  } });
  const snapshots = await Promise.all([activity.snapshot(), activity.snapshot()]);
  assert.equal(calls, 1);
  assert.equal(snapshots[0].running, 1);
  assert.equal(snapshots[1].queued, 2);
  now = 500;
  assert.deepEqual(await activity.snapshot(), { connected: 0, status: 'offline', running: null, queued: null, generated: null });
});

test('activity is authenticated, counts paused tabs without live sockets, and supports leaving', async () => {
  const backend = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ready', active_jobs: 1, queued_jobs: 3, generated: 99 }));
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const page = await serveDirectory('/tmp', 0, { service: `http://127.0.0.1:${backend.address().port}`, token: 'secret' });
  const url = `${page.url}/projector/activity`, headers = { 'x-venus-token': 'secret' };
  try {
    assert.equal((await fetch(url)).status, 401);
    const first = await (await fetch(`${url}?session=session-123456789`, { headers })).json();
    assert.equal(first.connected, 1); assert.equal(first.running, 1); assert.equal(first.queued, 3);
    assert.equal((await (await fetch(`${url}?session=session-234567890`, { headers })).json()).connected, 2);
    assert.equal((await fetch(`${url}?session=session-123456789&leave=1`, { method: 'POST', headers })).status, 204);
    assert.equal((await (await fetch(url, { headers })).json()).connected, 1);
    assert.equal((await fetch(`${url}?session=bad`, { headers })).status, 400);
  } finally { await page.close(); backend.closeAllConnections(); await new Promise(r => backend.close(r)); }
});
