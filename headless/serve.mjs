/**
 * The smallest static file server that can serve the built app: no dependency,
 * no configuration, and it stops when the render is done.
 *
 * It can also stand in front of the diffusion service. Served that way, the page
 * and the service share one origin and one port, which means no CORS, no mixed
 * content, and a single URL to expose from a rented GPU box:
 *
 *   node headless/serve.mjs --port 5191 --service http://127.0.0.1:5193 --token secret
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { attachLive } from './live.mjs';
import { createActivity } from './activity.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
};

/** Forward /projector/... to the diffusion service, so the page stays same-origin. */
async function proxy(request, response, service, url) {
  const target = service.replace(/\/$/, '') + (url.pathname.replace(/^\/projector/, '') || '/') + url.search;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const answer = await fetch(target, {
    method: request.method,
    headers: { 'Content-Type': request.headers['content-type'] || 'application/octet-stream' },
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
  const headers = {};
  for (const [key, value] of answer.headers) if (!/^(content-encoding|transfer-encoding)$/i.test(key)) headers[key] = value;
  response.writeHead(answer.status, headers);
  response.end(Buffer.from(await answer.arrayBuffer()));
}

export async function serveDirectory(root, port = 5191, { service = '', token = '', host = '127.0.0.1' } = {}) {
  const authorized = (request, url) => {
    const cookie = /(?:^|;\s*)venus_token=([^;]+)/.exec(request.headers.cookie || '')?.[1];
    return !token || (url.searchParams.get('token') || request.headers['x-venus-token'] || cookie) === token;
  };
  const activity = createActivity({ service });
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const cookieHeaders = {};
      if (token) {
        if (!authorized(request, url)) {
          response.writeHead(401, { 'Content-Type': 'text/plain' }).end('this renderer is protected: open it with ?token=…');
          return;
        }
        // the link carries the token once; afterwards the browser sends it as a cookie,
        // so scripts, images and generation requests all pass
        if (url.searchParams.get('token') === token) {
          cookieHeaders['Set-Cookie'] = `venus_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`;
        }
      }
      if (service && url.pathname === '/projector/activity') {
        const session = url.searchParams.get('session');
        if (request.method === 'POST' && url.searchParams.get('leave') === '1') {
          activity.leave(session);
          response.writeHead(204).end();
        } else if (request.method === 'GET') {
          if (session && !activity.touch(session)) { response.writeHead(400).end('invalid session'); return; }
          const snapshot = await activity.snapshot();
          if (snapshot.queued !== null) snapshot.queued += live.queued;
          response.writeHead(200, { ...cookieHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          response.end(JSON.stringify(snapshot));
        } else response.writeHead(405, { Allow: 'GET, POST' }).end();
        return;
      }
      if (service && url.pathname.startsWith('/projector')) {
        await proxy(request, response, service, url);
        return;
      }
      // the built app lives under /venus-veil/ when it was built for Pages
      const clean = decodeURIComponent(url.pathname).replace(/^\/venus-veil/, '') || '/';
      let file = path.join(root, clean === '/' ? 'index.html' : clean);
      if (!file.startsWith(root)) { response.writeHead(403).end('no'); return; }
      let info = await stat(file).catch(() => null);
      if (info?.isDirectory()) { file = path.join(file, 'index.html'); info = await stat(file).catch(() => null); }
      if (!info) { file = path.join(root, 'index.html'); info = await stat(file).catch(() => null); }
      if (!info) { response.writeHead(404).end('not found'); return; }
      response.writeHead(200, {
        ...cookieHeaders,
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': 'no-store',
      });
      createReadStream(file).pipe(response);
    } catch (error) {
      response.writeHead(500).end(String(error.message));
    }
  });
  const live = attachLive(server, { service, authorized });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  port = server.address().port;
  return {
    port,
    host,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
    close: () => { live.close(); return new Promise(resolve => server.close(resolve)); },
  };
}

// run directly: node headless/serve.mjs --port 5191 --service http://127.0.0.1:5193 [--token secret]
if (import.meta.url === `file://${process.argv[1]}`) {
  const flag = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index > -1 ? process.argv[index + 1] : fallback;
  };
  const root = path.resolve(flag('root', 'dist'));
  const server = await serveDirectory(root, Number(flag('port', 5191)), {
    service: flag('service', 'http://127.0.0.1:5193'),
    token: flag('token', process.env.VENUS_TOKEN || ''),
    host: flag('host', '0.0.0.0'),        // reachable from outside when run directly
  });
  console.log(`[venus] serving ${root} on port ${server.port} · /projector proxied to the diffusion service`);
}
