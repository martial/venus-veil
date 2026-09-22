import { WebSocketServer, WebSocket } from 'ws';
import { packLive, unpackLive } from '../src/projection/liveProtocol.js';

/** One inference and one latest waiting pose per connection. Older waiting
 * poses are acknowledged as skipped instead of building a latency queue. */
export function attachLive(server, { service, authorized }) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');
    const origin = request.headers.origin;
    const hosts = [request.headers.host, request.headers['x-forwarded-host']?.split(',')[0].trim()];
    let sameOrigin = !origin;
    try { if (origin) sameOrigin = hosts.includes(new URL(origin).host); } catch { /* invalid origin */ }
    if (!service || url.pathname !== '/projector/live' || !authorized(request, url) || !sameOrigin) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws));
  });
  sockets.on('connection', ws => {
    let active = false, waiting = null, alive = true;
    const abort = new AbortController();
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30000);
    heartbeat.unref();
    ws.on('close', () => { clearInterval(heartbeat); waiting = null; abort.abort(); });
    ws.on('error', () => { /* close handles cleanup */ });
    const send = (meta, payload) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.close(1013, 'connection too slow'); return; }
      ws.send(packLive(meta, payload));
    };
    async function run(frame) {
      active = true;
      try {
        const response = await fetch(`${service.replace(/\/$/, '')}/generate`, {
          method: 'POST', body: frame.payload, headers: { 'Content-Type': 'application/octet-stream' },
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]),
        });
        const payload = new Uint8Array(await response.arrayBuffer());
        const headers = {};
        for (const name of ['content-type', 'x-inference-ms', 'x-drift-label', 'x-frame-id', 'x-engine', 'x-stages']) {
          if (response.headers.has(name)) headers[name] = response.headers.get(name);
        }
        send({ id: frame.meta.id, status: response.status, headers }, payload);
      } catch (error) {
        if (!abort.signal.aborted) send({ id: frame.meta.id, status: 502 }, new TextEncoder().encode(error.message));
      } finally {
        active = false;
        if (waiting && !abort.signal.aborted) { const next = waiting; waiting = null; run(next); }
      }
    }
    ws.on('message', (data, binary) => {
      if (!binary) { ws.close(1003, 'binary frames only'); return; }
      try {
        const frame = unpackLive(data);
        if (!active) run(frame);
        else {
          if (waiting) send({ id: waiting.meta.id, status: 204 });
          waiting = frame;
        }
      } catch { ws.close(1007, 'invalid frame'); }
    });
  });
  return () => { for (const socket of sockets.clients) socket.terminate(); sockets.close(); };
}
