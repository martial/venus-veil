/** Compare real live HTTP/socket delivery through the deployed proxy.
 * node scripts/bench-live.mjs --endpoint https://POD/projector --token-file /path/to/token
 * The token is read from disk and never printed. No model or page settings change. */
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { WebSocket } from 'ws';
import { createLiveTransport } from '../src/projection/liveTransport.js';
import { createLiveClock } from '../src/projection/liveClock.js';
import { packFrame } from '../src/projection/rasterDepth.js';

const flag = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const endpoint = flag('endpoint', 'http://127.0.0.1:5191/projector');
const tokenFile = flag('token-file', '');
const headers = { 'User-Agent': 'Mozilla/5.0', ...(tokenFile ? { 'x-venus-token': (await readFile(tokenFile, 'utf8')).trim() } : {}) };
const size = Number(flag('size', 512)), rate = Number(flag('fps', 60)), seconds = Number(flag('seconds', 8));
const gray = new Uint8Array(size * size);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const r = ((x - size / 2) / (size * .3)) ** 2 + ((y - size / 2) / (size * .42)) ** 2;
  if (r < 1) gray[y * size + x] = 70 + 160 * Math.sqrt(1 - r);
}
class Socket extends WebSocket { constructor(url) { super(url, { headers }); } }
const percentile = (values, p) => { const v = values.toSorted((a, b) => a - b); return +(v[Math.min(v.length - 1, Math.floor(v.length * p))] || 0).toFixed(1); };
for (const stream of [false, true]) {
  let mode = '', inFlight = 0, id = 0, skipped = 0;
  const jobs = [], arrivals = [], inference = [], errors = {};
  const transport = createLiveTransport({ endpoint: () => endpoint, Socket, canStream: () => true,
    onMode: m => { mode = m; }, fetcher: (url, options) => fetch(url, { ...options, headers: { ...options.headers, ...headers } }) });
  const clock = createLiveClock(), start = performance.now(), end = start + (seconds + 1) * 1000;
  while (performance.now() < end) {
    const now = performance.now();
    if (inFlight < 12 && clock.take(now, rate)) {
      const frameId = ++id;
      const body = gzipSync(packFrame({ frame_id: frameId, size, prompt: 'a detailed sculpture, museum spotlight, black background',
        seed: 42, engine: 'fast', format: 'jpeg' }, gray));
      inFlight++;
      jobs.push((async () => {
        const sent = performance.now();
        try {
          const response = await transport.send(body, { id: frameId, stream, signal: AbortSignal.timeout(10000) });
          await response.arrayBuffer();
          const finished = performance.now();
          if (finished < start + 1000 || finished > end) return;
          if (response.status === 204) skipped++;
          else if (response.ok) { arrivals.push(finished - sent); inference.push(Number(response.headers.get('x-inference-ms'))); }
          else errors[response.status] = (errors[response.status] || 0) + 1;
        } catch (error) { errors[error.name] = (errors[error.name] || 0) + 1; }
        finally { inFlight--; }
      })());
    }
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  await Promise.all(jobs);
  console.log(JSON.stringify({ requested_transport: stream ? 'websocket' : 'http', actual_transport: mode, size, target_fps: rate,
    delivered_fps: +(arrivals.length / seconds).toFixed(2), median_ms: percentile(arrivals, .5), p95_ms: percentile(arrivals, .95),
    inference_ms: percentile(inference, .5), skipped, errors }));
  transport.close();
}
