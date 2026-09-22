import { packLive, unpackLive } from './liveProtocol.js';

/** Persistent live transport with HTTP fallback; recordings always use HTTP. */
export function createLiveTransport({ endpoint, onMode = () => {}, Socket = globalThis.WebSocket, fetcher = globalThis.fetch, canStream = url => typeof location !== 'undefined' && new URL(url).origin === location.origin }) {
  let socket = null, opening = null, connectedTo = '', retryAt = 0;
  const pending = new Map();
  function disconnect(error = new Error('live connection closed')) {
    for (const job of pending.values()) job.fail(error);
    pending.clear();
    const previous = socket;
    socket = null;
    opening = null;
    previous?.close();
    onMode('http');
  }
  function connect(url) {
    if (connectedTo !== url) { disconnect(); connectedTo = url; retryAt = 0; }
    if (socket?.readyState === 1) return Promise.resolve(socket);
    if (opening) return opening;
    if (!Socket || performance.now() < retryAt) return Promise.resolve(null);
    onMode('connecting');
    const target = new URL(`${url}/live`);
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    const current = socket = new Socket(target.href);
    current.binaryType = 'arraybuffer';
    opening = new Promise(resolve => {
      const timeout = setTimeout(() => fail(), 2000);
      const fail = () => {
        clearTimeout(timeout);
        if (socket === current) { retryAt = performance.now() + 30000; disconnect(); }
        resolve(null);
      };
      current.onopen = () => {
        clearTimeout(timeout);
        if (socket !== current) { current.close(); resolve(null); return; }
        opening = null;
        onMode('websocket');
        resolve(current);
      };
      current.onerror = fail;
      current.onclose = fail;
      current.onmessage = event => {
        if (socket !== current) return;
        try {
          const { meta, payload } = unpackLive(event.data);
          const job = pending.get(meta.id);
          if (!job) return;      // an aborted capture
          job.done(new Response(meta.status === 204 ? null : payload, { status: meta.status, headers: meta.headers }));
        } catch (error) { disconnect(error); }
      };
    });
    return opening;
  }
  return {
    async send(body, { id, signal, stream = true } = {}) {
      const url = endpoint();
      const connection = stream && canStream(url) ? await connect(url) : null;
      signal?.throwIfAborted();
      if (!connection || connection !== socket || connection.readyState !== 1) {
        onMode('http');
        return fetcher(`${url}/generate`, { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' }, signal });
      }
      return new Promise((resolve, reject) => {
        const finish = (callback, value) => { pending.delete(id); signal?.removeEventListener('abort', aborted); callback(value); };
        const aborted = () => finish(reject, signal.reason);
        pending.set(id, { done: value => finish(resolve, value), fail: error => finish(reject, error) });
        signal?.addEventListener('abort', aborted, { once: true });
        try { connection.send(packLive({ id }, body)); } catch (error) { finish(reject, error); }
      });
    },
    close: disconnect,
  };
}
