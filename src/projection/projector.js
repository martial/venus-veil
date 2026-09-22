import * as THREE from 'three';
import { createDepthRaster, rasterDepth, buildStructure, downsampleGray, rotateQuarter, packFrame } from './rasterDepth.js';
import { LIVE_PRESETS, pickSize, resolveLive, promptForReference } from '../presets.js';
import { createReferenceUpload } from './reference.js';
import { createLiveTransport } from './liveTransport.js';
import { createLiveClock } from './liveClock.js';
import { recordProjectedFrame } from './recording.js';

/**
 * Live projection: the veil's depth, seen from a projector at the viewer, goes
 * to a local one-step diffusion model (server/server.py); the generated image
 * comes back as light on the cloth, with fold occlusion.
 *
 * Every presented image is committed atomically with the pose, projector
 * matrix and depth buffer it was generated from, into one of two slots that
 * crossfade. Modes:
 *   woven      the image stays on the fabric points it was generated for, so the
 *              cloth keeps simulating at full frame rate while the light rides the folds
 *   projector  physical projector: the image stays fixed in projector space and the
 *              cloth moves through it (occlusion re-rasterised every frame)
 *   locked     one simulation step of 1/30 s per generated frame: every displayed
 *              pose is exactly the pose its image was generated for
 */

/**
 * Where the diffusion service lives. On this Mac (the dev server) and on the
 * published page it is the local service. Anywhere else the page was served by
 * headless/serve.mjs — a rented GPU box, say — which proxies /projector on the
 * same origin, so there is no CORS and no mixed content.
 */
/**
 * How generated frames travel. Raw RGBA costs nothing to decode and is right on
 * the loopback; across the internet it is 590 KB a frame at 384 px, so a remote
 * service answers in JPEG, about a tenth of that.
 */
export function wireFormat(endpoint) {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname) ? 'rgba' : 'jpeg';
  } catch {
    return 'rgba';
  }
}

/** Gzip a request body: a depth map is mostly smooth and mostly empty, so it shrinks several times. */
async function gzipped(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function defaultEndpoint(where = typeof location === 'undefined' ? null : location) {
  if (!where) return 'http://127.0.0.1:5193';
  const local = where.hostname.endsWith('github.io') || where.port === '5190';
  return local ? 'http://127.0.0.1:5193' : `${where.origin}/projector`;
}

export const PROJECTOR_DEFAULTS = {
  enabled: false,
  mode: 'woven',
  show: 'generated',
  running: true,
  prompt: 'a prehistoric Venus figurine, full body, heavy breasts, round belly, braided head, carved from weathered limestone, museum spotlight, black background',
  seed: 42,
  guidance: 1.1,
  emphasis: 0,        // 0 = the capture is the wind-shaped cloth alone; raise it to paint
                      //     the sculpture's relief into what the model sees
  upright: true,      // turn the capture so the figure stands up for the model
  wander: true,
  drift: 0.35,
  wanderSpeed: 0.12,       // materials per second
  size: 256,          // model resolution
  depthSize: 512,     // occlusion capture resolution (downsampled for the model)
  screenOnly: false,     // white fabric; generated light stays on the round screen
  surface: 'diffusion',   // 'diffusion' = the final image is the generated result alone
  power: 0.8,
  catch: 0.35,
  blendMs: 90,
  maxFps: 30,
  follow: true,
  mirror: true,
  engine: 'fast',      // 'fast' one-step live engine · 'fine' / 'best' multi-step, for recordings
  steps: 0,            // 0 = the engine's own default
  cfg: null,
  carry: 0,            // opt-in: recursive img2img can lose the subject over a long clip
  cnScale: 0,          // 0 = the engine's own default depth strength
  priority: false,     // a recording waits its turn on the service instead of skipping a frame
  liveInterval: 1,     // re-rasterise live occlusion every n frames (raised by the frame budget)
  physicsRelief: 0.25, // while projecting, how much of the sculpture still shapes the cloth
  live: 'auto',        // real-time preset (LIVE_PRESETS): resolution and rate of live projection
  reference: 1,        // how strongly the dropped photo shows in the image, where the service takes it (0 = not at all)
  inFlight: 0,         // requests on the wire at once; 0 = 1 on this machine, enough for the rate across the internet
};

const MAX_IN_FLIGHT = 12;

const MODE_LABELS = { woven: 'woven into fabric', projector: 'physical projector', locked: 'frame-locked pairs' };

export function createProjector({ renderer, scene, viewer, solver, ribbon, material, stepFrame, elements = {}, toast = () => {} }) {
  const params = { ...PROJECTOR_DEFAULTS };
  const sequence = crypto.randomUUID();
  const u = material.userData.uniforms;
  const geometry = ribbon.geometry;
  const indices = geometry.index.array;
  const capAttributes = [geometry.getAttribute('aCap0'), geometry.getAttribute('aCap1')];
  const state = {
    status: 'offline', error: null, model: null, device: null,
    endpoint: defaultEndpoint(),
    busy: false, inFlight: 0, roundTripMs: 0, references: false, referenceId: null, requested: 0, presented: 0, lastPresentedId: 0, liveApplied: null, fps: 0, latencyMs: 0, inferenceMs: 0, sizes: [256],
    engines: ['fast'], models: {}, engine: 'fast', perFrameMs: {},   // measured cost of each engine
    resetCarry: false,
    driftPhase: 0, driftLabel: 'base prompt', slot: 1,
    transport: 'http', displayFps: 60, displayFrameMs: 1000 / 60,
  };

  // ------------------------------------------------------------ projector camera
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 80);
  const center = new THREE.Vector3();
  let near = 3, far = 12;
  function aimAtViewer() {
    camera.position.copy(viewer.position);
    camera.quaternion.copy(viewer.quaternion);
    camera.aspect = 1;
    const halfV = THREE.MathUtils.degToRad(viewer.fov * 0.5);
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(halfV) * Math.max(1, viewer.aspect)));
    const { min, max } = solver.bounds();
    center.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    const distance = camera.position.distanceTo(center);
    const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 + 0.8;
    near = Math.max(0.1, distance - radius);
    far = distance + radius;
    camera.near = Math.max(0.05, near * 0.5);
    camera.far = far * 1.5;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }
  const viewProjection = new THREE.Matrix4();
  const currentMatrix = () => viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

  // ------------------------------------------------------------ slots
  const makeDepthTexture = size => {
    const t = new THREE.DataTexture(new Float32Array(size * size).fill(1e4), size, size, THREE.RedFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  };
  const makeImageTexture = size => {
    const t = new THREE.DataTexture(new Uint8Array(size * size * 4), size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false;
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  };
  const slots = [0, 1].map(() => ({ image: null, depth: null, canvas: null, has: false }));
  const figure = new Float32Array(solver.count);   // relief × mask, per particle
  // One capture per request in flight: across the internet several are on the wire
  // at once, each holding the pose its image will be laid back onto.
  const captures = Array.from({ length: MAX_IN_FLIGHT }, () => ({
    raster: null, model: null, turned: null, rgba: null, busy: false,
    pos: new Float32Array(solver.pos.length), matrix: new THREE.Matrix4(),
  }));
  let previewModel = null;      // scratch for the calibration grid's depth preview
  let liveRaster = null, liveDepth = null;

  /**
   * Allocate every buffer for a model resolution. Small models capture occlusion
   * at twice their size (an integer factor, so the model input is a clean
   * average); at 384 and up the capture is already fine enough on its own.
   */
  function setSize(size) {
    const n = Math.max(64, Math.round(size));
    params.size = n;
    params.depthSize = n <= 256 ? n * 2 : n;
    for (const slot of slots) {
      slot.image?.dispose();
      slot.depth?.dispose();
      slot.image = makeImageTexture(n);
      slot.canvas = null;
      slot.depth = makeDepthTexture(params.depthSize);
      slot.has = false;
    }
    liveDepth?.dispose();
    liveRaster = createDepthRaster(params.depthSize);
    liveDepth = new THREE.DataTexture(liveRaster.metric, params.depthSize, params.depthSize, THREE.RedFormat, THREE.FloatType);
    liveDepth.minFilter = liveDepth.magFilter = THREE.NearestFilter;
    liveDepth.generateMipmaps = false;
    for (const capture of captures) {
      capture.raster = createDepthRaster(params.depthSize);
      capture.model = new Uint8Array(n * n);
      capture.turned = new Uint8Array(n * n);
      capture.rgba = new Uint8Array(n * n * 4);
    }
    previewModel = new Uint8Array(n * n);
    u.uProjTexel.value = 1 / params.depthSize;
    u.uProjMix.value = state.slot;
    resizePreviews(n);
    bindSlots();
  }

  // calibration grid
  const gridCanvas = document.createElement('canvas');
  gridCanvas.width = gridCanvas.height = 512;
  {
    const g = gridCanvas.getContext('2d');
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      g.fillStyle = (x + y) % 2 ? '#d8c7a2' : '#6f8fa0';
      g.fillRect(x * 64, y * 64, 64, 64);
      g.fillStyle = '#101214';
      g.font = '15px Helvetica, Arial, sans-serif';
      g.fillText(`${x},${y}`, x * 64 + 14, y * 64 + 37);
    }
  }
  const gridTexture = new THREE.CanvasTexture(gridCanvas);
  gridTexture.colorSpace = THREE.SRGBColorSpace;

  function bindSlots() {
    const grid = params.show === 'grid';
    u.uProjMap0.value = grid ? gridTexture : slots[0].image;
    u.uProjMap1.value = slots[1].image;
    u.uProjDepth0.value = slots[0].depth;
    u.uProjDepth1.value = slots[1].depth;
    u.uProjDepthLive.value = liveDepth;
    u.uProjHas0.value = grid || slots[0].has ? 1 : 0;
    u.uProjHas1.value = !grid && slots[1].has ? 1 : 0;
    u.uProjLive.value = grid || params.mode === 'projector' ? 1 : 0;
    u.uProjPower.value = params.power;
    u.uProjCatch.value = params.catch;
    if (grid) u.uProjMix.value = 0;
  }

  // ------------------------------------------------------------ output screen (round, like the gallery reference)
  const mirror = createOutputScreen(u);
  mirror.group.visible = false;
  scene.add(mirror.group);

  // ------------------------------------------------------------ previews
  const depthCtx = elements.depthCanvas?.getContext('2d');
  const outputCtx = elements.outputCanvas?.getContext('2d');
  let depthImage = null, outputImage = null;
  const outputScratch = document.createElement('canvas');
  function resizePreviews(n) {
    depthImage = depthCtx ? depthCtx.createImageData(n, n) : null;
    outputImage = new ImageData(n, n);
    outputScratch.width = outputScratch.height = n;
    if (depthCtx) { depthCtx.canvas.width = depthCtx.canvas.height = n; }
  }
  const strip = [];
  function drawDepthPreview(src) {
    if (!depthCtx) return;
    const dst = depthImage.data;
    for (let i = 0, j = 0; i < src.length; i++, j += 4) { dst[j] = dst[j + 1] = dst[j + 2] = src[i]; dst[j + 3] = 255; }
    depthCtx.putImageData(depthImage, 0, 0);
  }
  function drawOutput(rgbaBottomUp, canvas = null) {
    const n = params.size, row = n * 4, dst = outputImage.data;
    const ctx = outputScratch.getContext('2d');
    if (canvas) {
      ctx.setTransform(1, 0, 0, -1, 0, n);
      ctx.drawImage(canvas, 0, 0);
      ctx.resetTransform();
    } else {
      for (let y = 0; y < n; y++) dst.set(rgbaBottomUp.subarray((n - 1 - y) * row, (n - y) * row), y * row);
      ctx.putImageData(outputImage, 0, 0);
    }
    outputCtx?.drawImage(outputScratch, 0, 0, outputCtx.canvas.width, outputCtx.canvas.height);
  }
  function pushStrip() {
    if (!elements.strip) return;
    const c = document.createElement('canvas');
    c.width = c.height = 96;
    c.getContext('2d').drawImage(outputScratch, 0, 0, 96, 96);
    elements.strip.prepend(c);
    strip.unshift(c);
    while (strip.length > 6) strip.pop().remove();
  }

  // ------------------------------------------------------------ service
  const controllers = new Set();
  const liveClock = createLiveClock();
  const transport = createLiveTransport({ endpoint: () => state.endpoint, onMode: mode => { state.transport = mode; } });
  let generation = 0, lastRequest = 0, lastPresent = 0, nextHealth = 0, healthBusy = false, placeQueued = false;
  let lastPhaseTime = performance.now(), gridTick = 0, liveTick = 0;
  let lastDepthPreview = 0, lastOutputPreview = 0, lastStrip = 0;

  async function health() {
    if (healthBusy) return;
    healthBusy = true;
    try {
      const response = await fetch(`${state.endpoint}/health`, { signal: AbortSignal.timeout(2500), cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const h = await response.json();
      state.status = h.status;
      state.error = h.error;
      state.model = h.model;
      state.device = h.device;
      if (Array.isArray(h.sizes) && h.sizes.length) state.sizes = h.sizes;
      if (Array.isArray(h.engines) && h.engines.length) state.engines = h.engines;
      state.models = h.models || {};
      api.onModels?.();
      state.references = !!h.references;
      if (state.status === 'ready') reference.ensure();
      // a recording (priority) owns the size until it ends
      if (state.status === 'ready' && !params.priority) {
        // the real-time preset depends on what the service runs on; apply it once that is known
        if (resolveLive(params.live, state.device) !== state.liveApplied) applyLive(params.live);
        // a service without this size would refuse every live frame: take the nearest it has
        else if (!state.sizes.includes(params.size)) { setSize(pickSize(params.size, state.sizes)); clearSlots(); }
      }
      state.engine = h.engine || state.engine;
    } catch (error) {
      state.status = 'offline';
      state.error = null;
      // a public page waits on Chrome's local-network permission before reaching 127.0.0.1
      const localPage = ['127.0.0.1', 'localhost'].includes(location.hostname);
      state.hint = !localPage && error?.name === 'TimeoutError' ? 'permission' : null;
    } finally {
      healthBusy = false;
      report();
    }
  }

  function locksSimulation() {
    return params.enabled && params.mode === 'locked' && params.show === 'generated' && params.running && state.status === 'ready';
  }

  /**
   * How many requests may be on the wire. On this machine one: the engine is the
   * limit. Across the internet a round trip costs ~300 ms whatever the GPU does, so
   * reaching `maxFps` images a second takes about rate × round trip in flight
   * (30 a second over 300 ms is 9, capped at 8).
   */
  function inFlightLimit() {
    if (params.engine !== 'fast') return 1; // expensive models get the newest pose only, never a backlog
    if (params.mode === 'locked' || params.priority) return 1;     // one pose per image, or a recording
    if (params.inFlight) return Math.max(1, Math.min(MAX_IN_FLIGHT, params.inFlight));
    if (wireFormat(state.endpoint) !== 'jpeg') return 1;
    const roundTrip = (state.roundTripMs || 300) / 1000;
    return Math.max(1, Math.min(MAX_IN_FLIGHT, Math.ceil(Math.min(params.maxFps, state.displayFps) * roundTrip) + 1));
  }

  /** Switch the real-time preset: resolution and request rate of live projection. */
  function applyLive(name = params.live) {
    params.live = name;
    const resolved = resolveLive(name, state.device);
    const preset = LIVE_PRESETS[resolved];
    state.liveApplied = resolved;
    params.maxFps = preset.maxFps;
    const size = pickSize(preset.size, state.sizes);
    if (size !== params.size) { setSize(size); clearSlots(); }
    api.onLive?.(resolved, preset);
    return resolved;
  }

  function setEngine(name) {
    if (!state.engines.includes(name)) {
      toast(state.models[name]?.reason || 'This model is unavailable on the connected service.', 6000);
      return false;
    }
    clearSlots();
    transport.close();
    params.engine = name;
    params.steps = 0;
    params.cfg = null;
    params.mode = 'woven';
    state.resetCarry = true;
    state.fps = 0;
    state.error = null;
    state.driftLabel = name;
    state.roundTripMs = 0;
    lastRequest = 0;
    liveClock.reset();
    bindSlots();
    reportTick = 0;
    report();
    return true;
  }

  // ------------------------------------------------------------ the dropped photo
  // Uploaded once to a service that takes image prompts; frames then name it by id.
  const reference = createReferenceUpload({
    state,
    onChange() { clearSlots(); state.resetCarry = true; },
    onStatus() { report(); },
  });
  const setReference = blob => reference.set(blob);

  const requests = new Set();
  function requestFrame(options) {
    const task = generateFrame(options);
    requests.add(task);
    task.then(() => requests.delete(task), () => requests.delete(task));
    return task;
  }

  async function generateFrame({ strict = false } = {}) {
    // Neither live frames nor recordings may silently fall back to Venus while
    // the new photo uploads. The live loop retries; a recording waits explicitly.
    if (params.reference > 0 && reference.hasPhoto) {
      const before = generation;
      const upload = reference.ensure();
      if (params.priority) await upload;
      if (before !== generation) return;
      if (!reference.ready) {
        if (params.priority) throw new Error(state.referenceError || 'the photo is not ready for recording');
        return;
      }
    }
    const pending = captures.find(c => !c.busy);
    if (!pending) return;
    pending.busy = true;
    const epoch = generation;
    state.inFlight++;
    state.busy = true;
    const started = performance.now();
    const controller = new AbortController();
    controllers.add(controller);
    try {
      if (locksSimulation()) stepFrame(1 / 30);
      if (params.follow || placeQueued) { aimAtViewer(); placeQueued = false; }
      const tCapture = performance.now();
      pending.matrix.copy(currentMatrix());
      pending.pos.set(solver.pos);
      const relief = solver.relief;
      const emphasis = relief ? params.emphasis : 0;
      if (emphasis > 0) {
        const reveal = solver.params.reveal;
        for (let i = 0; i < solver.count; i++) figure[i] = relief[i] * solver.mask[i] * reveal;
      }
      rasterDepth(pending.raster, pending.pos, indices, pending.matrix.elements, near, far, emphasis > 0 ? figure : null);
      if (strict && !pending.raster.covered) throw new Error('No visible cloth depth to record. Move the camera back toward the veil.');
      buildStructure(pending.raster, { emphasis });
      downsampleGray(pending.raster.gray, params.depthSize, pending.model, params.size);
      const now = performance.now();
      if (now - lastDepthPreview >= 125 || !params.running) { drawDepthPreview(pending.model); lastDepthPreview = now; }
      if (params.wander) state.driftPhase += Math.min(0.5, (now - lastPhaseTime) / 1000) * params.wanderSpeed;
      lastPhaseTime = now;
      const frameId = ++state.requested;
      const referenceId = params.reference > 0 ? state.referenceId : null;
      const body = packFrame({
        frame_id: frameId, size: params.size, sequence,
        prompt: referenceId ? promptForReference(params.prompt, state.referenceCaption) : params.prompt,
        seed: params.seed,
        guidance: params.guidance, drift: params.wander ? params.drift : 0, drift_phase: state.driftPhase,
        format: wireFormat(state.endpoint), priority: params.priority,
        engine: params.engine,
        steps: params.steps || undefined,
        cfg: params.cfg ?? undefined,
        carry: params.carry,
        cn_scale: params.cnScale || undefined,
        reset: state.resetCarry || undefined,
        reference: referenceId || undefined,
        reference_scale: params.reference,
      }, params.upright ? rotateQuarter(pending.model, params.size, pending.turned) : pending.model);
      // across the internet the upload is most of the wait: send it compressed
      const payload = wireFormat(state.endpoint) === 'jpeg' ? await gzipped(body) : body;
      const tSend = performance.now();
      const response = await transport.send(payload, {
        id: frameId, stream: !params.priority && params.engine === 'fast',
        // a multi-step engine can take a minute, and may load itself first
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(params.engine === 'fast' ? 20000 : 600000)]),
      });
      if (epoch !== generation) return;
      if (response.status === 204) return; // a newer pose replaced this one before inference
      if (response.status === 429) { lastRequest = performance.now() + 60; return; }
      if (response.status === 503) { state.status = 'loading'; return; }
      // the service restarted and forgot the photo: send it again, the next frame will have it
      if (response.status === 409) { reference.invalidate(referenceId); reference.ensure(); return; }
      if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
      const tHeaders = performance.now();
      const jpeg = response.headers.get('Content-Type')?.startsWith('image/jpeg');
      const received = jpeg ? await response.blob() : new Uint8Array(await response.arrayBuffer());
      const tBody = performance.now();
      if (!jpeg && received.length !== params.size * params.size * 4) throw new Error(`unexpected frame size ${received.length}`);
      const bitmap = jpeg ? await createImageBitmap(received, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }) : null;
      // turn the answer back onto the veil (one more quarter turn, see rotateQuarter)
      const rgba = jpeg ? null : params.upright ? rotateQuarter(received, params.size, pending.rgba, 4) : received;
      const tDecoded = performance.now();
      if (epoch !== generation) { bitmap?.close(); return; }
      // with several on the wire an older image can land after a newer one: drop it
      if (frameId < state.lastPresentedId) { bitmap?.close(); return; }
      state.lastPresentedId = frameId;

      // ---- atomic present: image + capture pose + matrix + depth into the older slot
      const s = 1 - state.slot;
      const slot = slots[s];
      const attribute = capAttributes[s];
      attribute.array.set(pending.pos);
      attribute.needsUpdate = true;
      slot.depth.image.data.set(pending.raster.metric);
      slot.depth.needsUpdate = true;
      (s === 0 ? u.uProjMat0 : u.uProjMat1).value.copy(pending.matrix);
      if (bitmap) {
        if (slot.image.isDataTexture) {
          slot.image.dispose();
          slot.canvas = new OffscreenCanvas(params.size, params.size);
          slot.image = new THREE.CanvasTexture(slot.canvas);
          slot.image.colorSpace = THREE.SRGBColorSpace;
          slot.image.flipY = false;
          slot.image.minFilter = slot.image.magFilter = THREE.LinearFilter;
          slot.image.generateMipmaps = false;
        }
        const ctx = slot.canvas.getContext('2d');
        // JPEG rows are already bottom-up. Rotate the bitmap without reading
        // pixels back to JS, then upload the canvas directly as the GL texture.
        ctx.setTransform(params.upright ? 0 : 1, params.upright ? 1 : 0,
          params.upright ? -1 : 0, params.upright ? 0 : 1, params.upright ? params.size : 0, 0);
        ctx.drawImage(bitmap, 0, 0);
        ctx.resetTransform();
        bitmap.close();
      } else {
        if (!slot.image.isDataTexture) { slot.image.dispose(); slot.canvas = null; slot.image = makeImageTexture(params.size); }
        slot.image.image.data.set(rgba);
      }
      slot.image.needsUpdate = true;
      slot.has = true;
      state.slot = s;
      if (params.blendMs <= 0) u.uProjMix.value = s;
      bindSlots();

      mirror.setCropFromGray(pending.model, params.size);
      state.presented++;
      const t = performance.now();
      if (t - lastOutputPreview >= 125 || !params.running) {
        drawOutput(rgba, slot.canvas); lastOutputPreview = t;
        if (t - lastStrip >= 500) { pushStrip(); lastStrip = t; }
      }
      state.fps = liveClock.presented(t);
      lastPresent = t;
      state.latencyMs = t - started;
      state.roundTripMs = state.roundTripMs ? state.roundTripMs * 0.8 + state.latencyMs * 0.2 : state.latencyMs;
      state.perFrameMs[params.engine] = state.perFrameMs[params.engine]
        ? state.perFrameMs[params.engine] * 0.7 + (t - started) * 0.3
        : t - started;
      state.timings = {
        step: tCapture - started, capture: tSend - tCapture, server: tHeaders - tSend, body: tBody - tHeaders,
        decode: tDecoded - tBody, present: t - tDecoded, inference: Number(response.headers.get('X-Inference-Ms')) || 0,
      };
      state.inferenceMs = Number(response.headers.get('X-Inference-Ms')) || 0;
      state.driftLabel = response.headers.get('X-Drift-Label') || state.driftLabel;
      state.error = null;
      state.resetCarry = false;
      return frameId;
    } catch (error) {
      if (error.name === 'AbortError' || epoch !== generation) return;
      if (error.name === 'TypeError' || error.name === 'TimeoutError') { state.status = 'offline'; state.error = null; }
      else state.error = error.message;
      if (strict) throw error;
    } finally {
      controllers.delete(controller);
      pending.busy = false;
      state.inFlight--;
      state.busy = state.inFlight > 0;
      report();
    }
  }

  // ------------------------------------------------------------ lifecycle
  function clearSlots() {
    generation++;
    for (const controller of controllers) controller.abort();
    state.lastPresentedId = 0;
    for (const slot of slots) {
      slot.has = false;
      if (slot.canvas) slot.canvas.getContext('2d').clearRect(0, 0, params.size, params.size);
      else slot.image.image.data.fill(0);
      slot.image.needsUpdate = true;
    }
    state.slot = 1;
    u.uProjMix.value = 0;
    lastPresent = 0;
    state.fps = 0;
    liveClock.reset();
    if (outputCtx) { outputCtx.fillStyle = '#060607'; outputCtx.fillRect(0, 0, outputCtx.canvas.width, outputCtx.canvas.height); }
    bindSlots();
  }

  function applySurface() {
    const defines = { ...(material.defines || {}) };
    if (params.screenOnly) defines.VEIL_WHITE = '';
    else delete defines.VEIL_WHITE;
    if (params.enabled && !params.screenOnly) defines.VEIL_PROJECTION = '';
    else delete defines.VEIL_PROJECTION;
    const only = params.enabled && !params.screenOnly && params.surface === 'diffusion';
    if (only) defines.VEIL_PROJECTION_ONLY = '';
    else delete defines.VEIL_PROJECTION_ONLY;
    material.defines = defines;
    material.needsUpdate = true;
    mirror.group.visible = params.enabled && (params.mirror || params.screenOnly);
  }

  function applyPhysicsRelief() {
    // While the diffusion carries the figure, the cloth can fly free: the relief
    // still guides the model (it is rasterised as a field), but holds the sheet less.
    solver.params.reliefScale = params.enabled ? params.physicsRelief : 1;
    solver.refreshReveal();
  }

  function setEnabled(on) {
    params.enabled = on;
    if (on) {
      material.defines = { ...(material.defines || {}), VEIL_PROJECTION: '' };
      aimAtViewer();
      health();
    } else {
      const { VEIL_PROJECTION, VEIL_PROJECTION_ONLY, ...rest } = material.defines || {};
      material.defines = rest;
      clearSlots();
    }
    applySurface();
    applyPhysicsRelief();
    mirror.group.visible = on && (params.mirror || params.screenOnly);
    if (elements.panel) elements.panel.hidden = !on;
    bindSlots();
    report();
  }

  function update(dt) {
    if (!params.enabled) return;
    const now = performance.now();
    if (dt > 0 && dt < 0.1) {
      state.displayFrameMs = state.displayFrameMs * 0.9 + dt * 1000 * 0.1;
      state.displayFps = 1000 / state.displayFrameMs;
    }
    if (now >= nextHealth) { nextHealth = now + (state.status === 'ready' ? 8000 : 2500); health(); }
    // crossfade toward the newest slot
    if (params.show === 'generated' && params.blendMs > 0) {
      const k = 1 - Math.exp(-(dt * 1000) / params.blendMs);
      u.uProjMix.value += (state.slot - u.uProjMix.value) * k;
    }
    const live = params.show === 'grid' || params.mode === 'projector';
    if (live && (params.liveInterval <= 1 || liveTick++ % params.liveInterval === 0)) {
      if (params.show === 'grid') {
        if (params.follow || placeQueued) { aimAtViewer(); placeQueued = false; }
        u.uProjMat0.value.copy(currentMatrix());
      }
      const m = params.show === 'grid' ? u.uProjMat0.value : (state.slot === 0 ? u.uProjMat0.value : u.uProjMat1.value);
      rasterDepth(liveRaster, solver.pos, indices, m.elements, near, far);
      liveDepth.needsUpdate = true;
      if (params.show === 'grid' && gridTick++ % 3 === 0) {
        downsampleGray(liveRaster.gray, params.depthSize, previewModel, params.size);
        drawDepthPreview(previewModel);
      }
    }
    const requestRate = Math.min(params.maxFps, state.displayFps);
    if (params.show === 'generated' && params.running && state.status === 'ready' && state.inFlight < inFlightLimit()
      && document.visibilityState !== 'hidden' && now >= lastRequest
      && liveClock.take(now, requestRate)) {
      lastRequest = now;
      requestFrame();
    }
    mirror.update(dt, params);
  }

  let reportTick = 0;
  function report() {
    const el = elements.status;
    if (!el) return;
    if (++reportTick % (params.engine === 'fast' ? 4 : 1) !== 0 && state.status === 'ready' && !state.error && !state.referenceError && state.referenceStatus !== 'uploading') return;
    let text;
    if (state.referenceError && params.reference > 0) text = `photo upload failed · ${state.referenceError} · retrying`;
    else if (state.referenceStatus === 'uploading' && params.reference > 0) text = 'reading the new photo…';
    else if (state.error) text = `projector error · ${state.error}`;
    else if (state.status === 'offline' && state.hint === 'permission') text = 'projector: allow local network access in Chrome (address bar), and run  npm run projector';
    else if (state.status === 'offline') text = 'projector offline · run  npm run projector';
    else if (state.status === 'loading') text = 'projector loading the model…';
    else if (state.status === 'error') text = 'projector failed to load · see server log';
    else if (params.show === 'grid') text = 'calibration grid · live occlusion';
    else if (!params.running) text = `held · frame ${state.presented}`;
    else if (params.engine !== 'fast' && state.fps === 0) text = `${params.engine} · preparing the first image…`;
    else text = `${MODE_LABELS[params.mode]} · ${state.fps.toFixed(1)} generated fps · ${Math.round(state.latencyMs)} ms · ${state.driftLabel}`;
    el.textContent = text;
    el.dataset.transport = state.transport;
    el.dataset.inferenceMs = String(state.inferenceMs);
    el.dataset.engine = params.engine;
    if (elements.outputLabel) elements.outputLabel.textContent = state.presented ? `output · frame ${state.presented}` : 'output';
  }

  // ------------------------------------------------------------ GUI
  function buildControls(folder) {
    folder.add(params, 'enabled').name('live projection').onChange(setEnabled);
    folder.add(params, 'mode', { 'woven into fabric': 'woven', 'physical projector': 'projector', 'frame-locked pairs': 'locked' })
      .name('mode').onChange(() => { bindSlots(); report(); });
    folder.add(params, 'show', { 'generated light': 'generated', 'calibration grid': 'grid' }).name('show')
      .onChange(() => { bindSlots(); report(); });
    folder.add(params, 'surface', { 'diffusion only': 'diffusion', 'fabric + light': 'fabric' }).name('final image')
      .onChange(applySurface);
    folder.add(u.uProjSoft, 'value', 0, 4, 0.1).name('occlusion softness');
    folder.add(params, 'running').name('running');
    folder.add(params, 'prompt').name('prompt');
    folder.add(params, 'wander').name('material wandering');
    folder.add(params, 'drift', 0, 1, 0.01).name('wander amount');
    folder.add(params, 'wanderSpeed', 0, 1, 0.01).name('wander speed');
    folder.add(params, 'guidance', 0.3, 2, 0.01).name('edge strength');
    folder.add(params, 'emphasis', 0, 1, 0.01).name('sculpture in depth map');
    folder.add(params, 'carry', 0, 0.9, 0.05).name('carry previous frame');
    folder.add(params, 'upright').name('figure upright for model');
    folder.add(params, 'size', [256, 384, 512, 768]).name('generated resolution').onChange(value => {
      const n = Number(value);
      if (!state.sizes.includes(n)) {
        toast(`the service has no ${n} px model · npm run projector:setup -- --sizes ${n}`);
        params.size = state.sizes[state.sizes.length - 1];
        folder.controllers.forEach(c => c.updateDisplay());
      }
      setSize(params.size);
      clearSlots();
    });
    folder.add(params, 'physicsRelief', 0, 1, 0.01).name('sculpture in physics').onChange(applyPhysicsRelief);
    folder.add(params, 'seed', 0, 9999, 1).name('seed');
    folder.add(params, 'power', 0, 4, 0.01).name('brightness').onChange(bindSlots);
    folder.add(params, 'catch', 0, 1, 0.01).name('fabric catch').onChange(bindSlots);
    folder.add(params, 'blendMs', 0, 400, 1).name('frame blend (ms)');
    folder.add(params, 'maxFps', 1, 60, 1).name('images per second');
    folder.add(params, 'follow').name('follow viewer');
    folder.add({ place: () => { placeQueued = true; params.follow = false; folder.controllers.forEach(c => c.updateDisplay()); toast('projector placed at this view'); } }, 'place').name('project from this view');
    folder.add(params, 'mirror').name('round output screen').onChange(v => { mirror.group.visible = params.enabled && (v || params.screenOnly); });
    folder.add(state, 'endpoint').name('service').onFinishChange(v => { state.endpoint = String(v).replace(/\/$/, ''); health(); });
    folder.add({ clear: clearSlots }, 'clear').name('clear projected frames');
  }

  setSize(params.size);

  const api = {
    params, state, camera, buildControls, setEnabled, update, health, clearSlots, setSize, applyLive, setReference, setEngine,
    onLive: null,       // (name, preset) => void, when the real-time preset is applied
    /** Re-apply params that were changed in bulk (a look preset). */
    refresh() { bindSlots(); applySurface(); applyPhysicsRelief(); report(); },
    /** Request and present one frame now (debug / headless checks). */
    frame: options => requestFrame(options),
    recordFrame: () => recordProjectedFrame(api),
    /** Stop live work before changing export resolution or capturing frame zero. */
    async prepareRecording() {
      params.running = false;
      params.priority = true;
      clearSlots();
      transport.close();
      await Promise.allSettled([...requests]);
      state.resetCarry = true;
      await health();
    },
    get locksSimulation() { return locksSimulation(); },
    dispose() {
      transport.close();
      solver.params.reliefScale = 1;
      clearSlots();
      for (const slot of slots) { slot.image?.dispose(); slot.depth?.dispose(); }
      liveDepth?.dispose(); gridTexture.dispose(); mirror.dispose();
      scene.remove(mirror.group);
    },
  };
  return api;
}

/** Round screen on a slim stand that shows the latest generated frame (shares the slot uniforms). */
function createOutputScreen(u) {
  const group = new THREE.Group();
  const radius = 1.05;
  // left of the veil, where the default view (and the GUI on the right) leaves room
  group.position.set(-4.1, 1.8, -2.6);
  group.rotation.y = 0.6;

  const crop = new THREE.Vector3(0.5, 0.5, 0.5);       // centre uv, half extent (smoothed)
  const cropTarget = new THREE.Vector3(0.5, 0.5, 0.5);
  const discMaterial = new THREE.ShaderMaterial({
    uniforms: {
      map0: u.uProjMap0, map1: u.uProjMap1, has0: u.uProjHas0, has1: u.uProjHas1, mixv: u.uProjMix,
      intensity: { value: 1.0 }, crop: { value: crop },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      void main() {
        vUv = uv;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D map0;
      uniform sampler2D map1;
      uniform float has0, has1, mixv, intensity;
      uniform vec3 crop;
      varying vec2 vUv;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      void main() {
        vec2 c = vUv - 0.5;
        float r = length(c) * 2.0;
        vec2 uv = crop.xy + c * 2.0 * crop.z;
        vec3 a = has0 > 0.5 ? texture(map0, uv).rgb : vec3(0.0);
        vec3 b = has1 > 0.5 ? texture(map1, uv).rgb : vec3(0.0);
        vec3 image = mix(a, b, mixv);
        vec3 V = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - abs(dot(V, vNormalW)), 4.0);
        vec3 glass = vec3(0.010, 0.011, 0.013) * (1.0 - 0.5 * r) + vec3(0.05, 0.05, 0.055) * fres;
        float vignette = 1.0 - smoothstep(0.6, 1.0, r) * 0.55;
        gl_FragColor = vec4(glass + image * intensity * vignette, 1.0);
      }`,
  });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(radius, 96), discMaterial);
  group.add(disc);

  const metal = new THREE.MeshStandardMaterial({ color: '#1b1b1d', metalness: 1, roughness: 0.32 });
  const frame = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.032, 16, 160), metal);
  group.add(frame);
  const back = new THREE.Mesh(new THREE.CircleGeometry(radius, 64), new THREE.MeshStandardMaterial({ color: '#0c0c0d', metalness: 0.6, roughness: 0.5 }));
  back.rotation.y = Math.PI;
  back.position.z = -0.01;
  group.add(back);
  const standHeight = group.position.y - radius;
  const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, standHeight, 20), metal);
  stand.position.y = -radius - standHeight / 2;
  group.add(stand);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.03, 40), metal);
  base.position.y = -group.position.y + 0.015;
  group.add(base);
  for (const m of [frame, stand, base]) m.castShadow = true;

  return {
    group,
    /** Frame the veil's silhouette (gray is top-down) so the figure fills the disc. */
    setCropFromGray(gray, size) {
      let x0 = size, y0 = size, x1 = -1, y1 = -1;
      for (let y = 0; y < size; y += 2) {
        const row = y * size;
        for (let x = 0; x < size; x += 2) {
          if (gray[row + x] === 0) continue;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      if (x1 < 0) return;
      const cu = (x0 + x1 + 2) / 2 / size, cv = 1 - (y0 + y1 + 2) / 2 / size;
      const half = Math.min(0.5, Math.max((x1 - x0 + 2), (y1 - y0 + 2)) / 2 / size * 1.12);
      cropTarget.set(cu, cv, half);
    },
    update(dt) {
      crop.lerp(cropTarget, 1 - Math.exp(-dt * 3));
    },
    dispose() {
      group.traverse(o => { o.geometry?.dispose(); if (o.material && o.material !== metal) o.material.dispose(); });
      metal.dispose();
    },
  };
}
