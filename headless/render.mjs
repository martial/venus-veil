/**
 * Headless renderer: drives the built app in headless Chromium, one frame at a
 * time, and writes an MP4. Nothing here is Mac-specific — on a Linux box with
 * an NVIDIA card the same command runs, with the diffusion service on CUDA.
 *
 *   node headless/render.mjs --seconds 8 --engine best --out clip.mp4
 *
 * The app renders the veil; the diffusion service makes the light. Each frame
 * waits for its image, so the clip is smooth however long a frame took.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { estimate, HELP, parseArgs } from './options.mjs';
import { PAGE_API } from './page-api.mjs';
import { serveDirectory } from './serve.mjs';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));

const log = (...parts) => console.log(`[venus] ${parts.join(' ')}`);

async function waitForService(url, timeoutMs = 10 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  let reported = false;
  while (Date.now() < deadline) {
    try {
      const health = await (await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) })).json();
      if (health.status === 'ready') return health;
      if (!reported) { log(`waiting for the diffusion service (${health.status})…`); reported = true; }
    } catch {
      if (!reported) { log('waiting for the diffusion service…'); reported = true; }
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error(`the diffusion service at ${url} never became ready`);
}

async function launch(options) {
  const { chromium } = await import('playwright');
  const args = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-webgpu',
    '--autoplay-policy=no-user-gesture-required',
  ];
  if (options.gpu) {
    // headless Chromium reaches a real GPU through ANGLE/EGL; on a server this
    // needs the NVIDIA driver in the container
    args.push('--use-gl=angle', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist',
      '--enable-features=Vulkan,VaapiVideoDecoder');
  } else {
    args.push('--use-gl=swiftshader', '--enable-unsafe-swiftshader');
  }
  return chromium.launch({ headless: true, args });
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n\n${HELP}`);
    process.exit(1);
  }
  if (options.help) { console.log(HELP); return; }

  const framesDir = options.frames || path.join(path.dirname(path.resolve(options.out)), '.venus-frames');
  const dist = path.join(ROOT, 'dist');
  if (!existsSync(path.join(dist, 'index.html'))) {
    throw new Error(`no build found at ${dist} — run: npm run build`);
  }
  await mkdir(framesDir, { recursive: true });

  const health = await waitForService(options.service);
  if (!health.engines?.includes(options.engine)) {
    throw new Error(`the service offers ${health.engines?.join(', ')}, not ${options.engine}`);
  }
  log(`service ready · engines ${health.engines.join(', ')} · ${health.device || ''}`);

  const server = await serveDirectory(dist, new URL(options.page).port || 5191);
  const browser = await launch(options);
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on('console', message => {
    if (message.type() === 'error') log('page error:', message.text().slice(0, 200));
  });

  const guess = estimate(options);
  log(`${options.frameCount} frames · ${options.imageCount} generated images · about ${guess.text}`);

  try {
    await page.goto(`${options.page}/?look=${options.look}&noprojector`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction('window.__veil && document.getElementById("loading").className === "loaded"', null,
      { timeout: 180000 });

    if (options.sculpture) {
      const bytes = await readFile(options.sculpture);
      await page.evaluate(async ({ data, name }) => {
        const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
        await window.__veil.sculpture.loadSource(blob, name);
      }, { data: bytes.toString('base64'), name: path.basename(options.sculpture) });
    }
    log('waiting for the sculpture depth…');
    await page.waitForFunction('!window.__veil.sculpture.state.busy', null, { timeout: 300000 });

    // the page-side helper is injected, so the app carries no test hooks
    await page.evaluate(PAGE_API);
    await page.evaluate(settings => window.__veilHeadless.prepare(settings), {
      engine: options.engine, steps: options.steps, seed: options.seed, carry: options.carry,
      generated: options.generated, prompt: options.prompt, service: options.service,
      fps: options.fps, frames: options.frameCount, interval: options.interval,
      orbit: options.orbit, hold: options.hold,
    });

    const started = Date.now();
    for (let frame = 0; frame < options.frameCount; frame++) {
      await page.evaluate(n => window.__veilHeadless.frame(n), frame);
      const shot = await page.locator('#viewport canvas').screenshot({ type: 'png' });
      await writeFile(path.join(framesDir, `${String(frame).padStart(6, '0')}.png`), shot);
      if (frame % Math.max(1, options.interval) === 0 || frame === options.frameCount - 1) {
        const elapsed = (Date.now() - started) / 1000;
        const left = elapsed * (options.frameCount / (frame + 1) - 1);
        log(`frame ${frame + 1}/${options.frameCount} · ${Math.round(elapsed)} s elapsed · ${Math.round(left)} s left`);
      }
    }
    const stats = await page.evaluate(() => window.__veilHeadless.stats());
    log(`generated ${stats.presented} images · ${Math.round(stats.perFrameMs / 1000)} s each`);
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }

  await encode(framesDir, options);
  if (!options.keepFrames && !options.frames) await rm(framesDir, { recursive: true, force: true });
  log(`wrote ${options.out}`);
}

function encode(framesDir, options) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-framerate', String(options.fps), '-i', path.join(framesDir, '%06d.png'),
      '-c:v', 'libx264', '-preset', 'slow', '-crf', String(options.crf), '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', options.out];
    log('encoding with ffmpeg…');
    const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });
    ffmpeg.on('error', reject);
    ffmpeg.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
}

main().catch(error => {
  console.error(`[venus] ${error.message}`);
  process.exit(1);
});
