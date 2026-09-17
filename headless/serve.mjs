/**
 * The smallest static file server that can serve the built app: no dependency,
 * no configuration, and it stops when the render is done.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

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

export async function serveDirectory(root, port = 5191) {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      // the built app lives under /venus-veil/ when it was built for Pages
      const clean = decodeURIComponent(url.pathname).replace(/^\/venus-veil/, '') || '/';
      let file = path.join(root, clean === '/' ? 'index.html' : clean);
      if (!file.startsWith(root)) { response.writeHead(403).end('no'); return; }
      let info = await stat(file).catch(() => null);
      if (info?.isDirectory()) { file = path.join(file, 'index.html'); info = await stat(file).catch(() => null); }
      if (!info) { file = path.join(root, 'index.html'); info = await stat(file).catch(() => null); }
      if (!info) { response.writeHead(404).end('not found'); return; }
      response.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': 'no-store',
      });
      createReadStream(file).pipe(response);
    } catch (error) {
      response.writeHead(500).end(String(error.message));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
