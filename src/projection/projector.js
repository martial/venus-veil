import * as THREE from 'three';
import { createDepthRaster, rasterDepth, downsampleGray, packFrame } from './rasterDepth.js';

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

export const PROJECTOR_DEFAULTS = {
  enabled: false,
  mode: 'woven',
  show: 'generated',
  running: true,
  prompt: 'a prehistoric Venus figurine carved from weathered limestone, draped in flowing translucent fabric, soft museum spotlight, sculptural folds, black background',
  seed: 42,
  guidance: 0.85,
  wander: true,
  drift: 0.35,
  wanderSpeed: 0.12,       // materials per second
  size: 256,          // model resolution
  depthSize: 512,     // occlusion capture resolution (downsampled for the model)
  surface: 'diffusion',   // 'diffusion' = the final image is the generated result alone
  power: 0.8,
  catch: 0.35,
  blendMs: 90,
  maxFps: 30,
  follow: true,
  mirror: true,
  liveInterval: 1,     // re-rasterise live occlusion every n frames (raised by the frame budget)
};

const MODE_LABELS = { woven: 'woven into fabric', projector: 'physical projector', locked: 'frame-locked pairs' };

export function createProjector({ renderer, scene, viewer, solver, ribbon, material, stepFrame, elements = {}, toast = () => {} }) {
  const params = { ...PROJECTOR_DEFAULTS };
  const u = material.userData.uniforms;
  const geometry = ribbon.geometry;
  const indices = geometry.index.array;
  const capAttributes = [geometry.getAttribute('aCap0'), geometry.getAttribute('aCap1')];
  const state = {
    status: 'offline', error: null, model: null, device: null,
    endpoint: 'http://127.0.0.1:5193',   // direct (the dev proxy /projector adds a hop)
    busy: false, requested: 0, presented: 0, fps: 0, latencyMs: 0, inferenceMs: 0,
    driftPhase: 0, driftLabel: 'base prompt', slot: 1,
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
  const slots = [0, 1].map(() => ({ image: makeImageTexture(params.size), depth: makeDepthTexture(params.depthSize), has: false }));
  const liveRaster = createDepthRaster(params.depthSize);
  const liveDepth = new THREE.DataTexture(liveRaster.metric, params.depthSize, params.depthSize, THREE.RedFormat, THREE.FloatType);
  liveDepth.minFilter = liveDepth.magFilter = THREE.NearestFilter;
  liveDepth.generateMipmaps = false;
  const pending = {
    raster: createDepthRaster(params.depthSize),
    model: new Uint8Array(params.size * params.size),
    pos: new Float32Array(solver.pos.length),
    matrix: new THREE.Matrix4(),
  };
  u.uProjTexel.value = 1 / params.depthSize;

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
  const depthImage = depthCtx ? depthCtx.createImageData(params.size, params.size) : null;
  const strip = [];
  function drawDepthPreview(src) {
    if (!depthCtx) return;
    const dst = depthImage.data;
    for (let i = 0, j = 0; i < src.length; i++, j += 4) { dst[j] = dst[j + 1] = dst[j + 2] = src[i]; dst[j + 3] = 255; }
    depthCtx.putImageData(depthImage, 0, 0);
  }
  const outputImage = new ImageData(params.size, params.size);
  const outputScratch = document.createElement('canvas');
  outputScratch.width = outputScratch.height = params.size;
  function drawOutput(rgbaBottomUp) {
    const n = params.size, row = n * 4, dst = outputImage.data;
    for (let y = 0; y < n; y++) dst.set(rgbaBottomUp.subarray((n - 1 - y) * row, (n - y) * row), y * row);
    outputScratch.getContext('2d').putImageData(outputImage, 0, 0);
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
  let generation = 0, abort = null, lastRequest = 0, lastPresent = 0, nextHealth = 0, healthBusy = false, placeQueued = false;
  let lastPhaseTime = performance.now(), gridTick = 0, liveTick = 0;

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

  async function requestFrame() {
    const epoch = generation;
    state.busy = true;
    const started = performance.now();
    const controller = new AbortController();
    abort = controller;
    try {
      if (locksSimulation()) stepFrame(1 / 30);
      if (params.follow || placeQueued) { aimAtViewer(); placeQueued = false; }
      const tCapture = performance.now();
      pending.matrix.copy(currentMatrix());
      pending.pos.set(solver.pos);
      rasterDepth(pending.raster, pending.pos, indices, pending.matrix.elements, near, far);
      downsampleGray(pending.raster.gray, params.depthSize, pending.model, params.size);
      if (state.requested % 2 === 0) drawDepthPreview(pending.model);
      const now = performance.now();
      if (params.wander) state.driftPhase += Math.min(0.5, (now - lastPhaseTime) / 1000) * params.wanderSpeed;
      lastPhaseTime = now;
      const frameId = ++state.requested;
      const body = packFrame({
        frame_id: frameId, size: params.size, prompt: params.prompt, seed: params.seed,
        guidance: params.guidance, drift: params.wander ? params.drift : 0, drift_phase: state.driftPhase, format: 'rgba',
      }, pending.model);
      const tSend = performance.now();
      const response = await fetch(`${state.endpoint}/generate`, {
        method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
      });
      if (epoch !== generation) return;
      if (response.status === 429) { lastRequest = performance.now() + 60; return; }
      if (response.status === 503) { state.status = 'loading'; return; }
      if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
      const tHeaders = performance.now();
      const rgba = new Uint8Array(await response.arrayBuffer());
      const tBody = performance.now();
      if (rgba.length !== params.size * params.size * 4) throw new Error(`unexpected frame size ${rgba.length}`);
      const tDecoded = performance.now();
      if (epoch !== generation) return;

      // ---- atomic present: image + capture pose + matrix + depth into the older slot
      const s = 1 - state.slot;
      const slot = slots[s];
      const attribute = capAttributes[s];
      attribute.array.set(pending.pos);
      attribute.needsUpdate = true;
      slot.depth.image.data.set(pending.raster.metric);
      slot.depth.needsUpdate = true;
      (s === 0 ? u.uProjMat0 : u.uProjMat1).value.copy(pending.matrix);
      slot.image.image.data.set(rgba);
      slot.image.needsUpdate = true;
      slot.has = true;
      state.slot = s;
      if (params.blendMs <= 0) u.uProjMix.value = s;
      bindSlots();

      mirror.setCropFromGray(pending.model, params.size);
      state.presented++;
      if (state.presented % 2 === 1 || !params.running) drawOutput(rgba);
      if (state.presented % 12 === 1) pushStrip();
      const t = performance.now();
      const instant = lastPresent ? 1000 / (t - lastPresent) : 0;
      state.fps = state.fps ? state.fps * 0.85 + instant * 0.15 : instant;
      lastPresent = t;
      state.latencyMs = t - started;
      state.timings = {
        step: tCapture - started, capture: tSend - tCapture, server: tHeaders - tSend, body: tBody - tHeaders,
        decode: tDecoded - tBody, present: t - tDecoded, inference: Number(response.headers.get('X-Inference-Ms')) || 0,
      };
      state.inferenceMs = Number(response.headers.get('X-Inference-Ms')) || 0;
      state.driftLabel = response.headers.get('X-Drift-Label') || state.driftLabel;
      state.error = null;
    } catch (error) {
      if (error.name === 'AbortError' || epoch !== generation) return;
      if (error.name === 'TypeError' || error.name === 'TimeoutError') { state.status = 'offline'; state.error = null; }
      else state.error = error.message;
    } finally {
      if (abort === controller) abort = null;
      state.busy = false;
      report();
    }
  }

  // ------------------------------------------------------------ lifecycle
  function clearSlots() {
    generation++;
    abort?.abort();
    for (const slot of slots) { slot.has = false; slot.image.image.data.fill(0); slot.image.needsUpdate = true; }
    state.slot = 1;
    u.uProjMix.value = 0;
    lastPresent = 0;
    state.fps = 0;
    if (outputCtx) { outputCtx.fillStyle = '#060607'; outputCtx.fillRect(0, 0, outputCtx.canvas.width, outputCtx.canvas.height); }
    bindSlots();
  }

  function applySurface() {
    const defines = { ...(material.defines || {}) };
    const only = params.enabled && params.surface === 'diffusion';
    if (only) defines.VEIL_PROJECTION_ONLY = '';
    else delete defines.VEIL_PROJECTION_ONLY;
    material.defines = defines;
    material.needsUpdate = true;
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
    mirror.group.visible = on && params.mirror;
    if (elements.panel) elements.panel.hidden = !on;
    bindSlots();
    report();
  }

  function update(dt) {
    if (!params.enabled) return;
    const now = performance.now();
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
        downsampleGray(liveRaster.gray, params.depthSize, pending.model, params.size);
        drawDepthPreview(pending.model);
      }
    }
    if (params.show === 'generated' && params.running && state.status === 'ready' && !state.busy
      && document.visibilityState !== 'hidden' && now - lastRequest >= 1000 / params.maxFps) {
      lastRequest = now;
      requestFrame();
    }
    mirror.update(dt, params);
  }

  let reportTick = 0;
  function report() {
    const el = elements.status;
    if (!el) return;
    if (++reportTick % 4 !== 0 && state.status === 'ready' && !state.error) return;
    let text;
    if (state.error) text = `projector error · ${state.error}`;
    else if (state.status === 'offline' && state.hint === 'permission') text = 'projector: allow local network access in Chrome (address bar), and run  npm run projector';
    else if (state.status === 'offline') text = 'projector offline · run  npm run projector';
    else if (state.status === 'loading') text = 'projector loading the model…';
    else if (state.status === 'error') text = 'projector failed to load · see server log';
    else if (params.show === 'grid') text = 'calibration grid · live occlusion';
    else if (!params.running) text = `held · frame ${state.presented}`;
    else text = `${MODE_LABELS[params.mode]} · ${state.fps.toFixed(1)} generated fps · ${Math.round(state.latencyMs)} ms · ${state.driftLabel}`;
    el.textContent = text;
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
    folder.add(params, 'guidance', 0.3, 1.8, 0.01).name('fold guidance');
    folder.add(params, 'seed', 0, 9999, 1).name('seed');
    folder.add(params, 'power', 0, 4, 0.01).name('brightness').onChange(bindSlots);
    folder.add(params, 'catch', 0, 1, 0.01).name('fabric catch').onChange(bindSlots);
    folder.add(params, 'blendMs', 0, 400, 1).name('frame blend (ms)');
    folder.add(params, 'maxFps', 2, 30, 1).name('max generated fps');
    folder.add(params, 'follow').name('follow viewer');
    folder.add({ place: () => { placeQueued = true; params.follow = false; folder.controllers.forEach(c => c.updateDisplay()); toast('projector placed at this view'); } }, 'place').name('project from this view');
    folder.add(params, 'mirror').name('round output screen').onChange(v => { mirror.group.visible = params.enabled && v; });
    folder.add(state, 'endpoint').name('service').onFinishChange(v => { state.endpoint = String(v).replace(/\/$/, ''); health(); });
    folder.add({ clear: clearSlots }, 'clear').name('clear projected frames');
  }

  bindSlots();

  return {
    params, state, camera, buildControls, setEnabled, update, health, clearSlots,
    /** Request and present one frame now (debug / headless checks). */
    frame: () => requestFrame(),
    get locksSimulation() { return locksSimulation(); },
    dispose() {
      clearSlots();
      for (const slot of slots) { slot.image.dispose(); slot.depth.dispose(); }
      liveDepth.dispose(); gridTexture.dispose(); mirror.dispose();
      scene.remove(mirror.group);
    },
  };
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
