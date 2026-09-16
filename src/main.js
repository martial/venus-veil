import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createRestShape } from './cloth/restShape.js';
import { ClothSolver } from './cloth/solver.js';
import { createWind } from './cloth/wind.js';
import { createStepper } from './cloth/stepper.js';
import { createRibbonMesh } from './render/ribbonMesh.js';
import { createVeilMaterial, createWeaveTextures } from './render/veilMaterial.js';
import { createStudio } from './render/studio.js';
import { createPost } from './render/post.js';
import { createQuality } from './render/quality.js';
import { createUI } from './ui.js';
import { createSculpturePipeline } from './pipeline/sculpture.js';
import { createProjector } from './projection/projector.js';

const $ = id => document.getElementById(id);

function toast(message, ms = 3200) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('visible'), ms);
}

async function start() {
  const viewport = $('viewport');
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', alpha: false });
  const baseDpr = Math.min(window.devicePixelRatio || 1, 2);
  const quality = createQuality({ maxScale: 1, floor: 24, target: 50 });
  renderer.setPixelRatio(baseDpr);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;   // refreshed on a schedule (see applyQuality)
  renderer.setClearColor(0x030304, 1);
  viewport.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 80);
  camera.position.set(0, 1.7, 7.4);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.5, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = false;
  controls.minDistance = 3;
  controls.maxDistance = 16;
  controls.minPolarAngle = 0.35;
  controls.maxPolarAngle = Math.PI * 0.55;
  controls.update();

  // simulation
  const shape = createRestShape();
  const solver = new ClothSolver(shape);
  const wind = createWind();
  const { min, max } = solver.bounds();
  wind.setBounds(min, max, 1.2);
  // 4 substeps max: a slow frame must not make the next one slower still
  const stepper = createStepper({ dt: 1 / 120, maxSubsteps: 4, maxFrameDt: 1 / 10 });

  // rendering
  const weave = createWeaveTextures(512);
  weave.normal.anisotropy = weave.alpha.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const material = createVeilMaterial(weave);
  const ribbon = createRibbonMesh(solver, material);
  scene.add(ribbon.mesh);
  const studio = createStudio(scene, renderer, camera);
  const post = createPost(renderer, scene, camera);

  // sculpture pipeline (depth + texture + relief)
  const sculpture = createSculpturePipeline({ solver, material, ribbon, renderer, toast, elements: {
    progress: $('progress'), progressBar: $('progress-bar'), progressLabel: $('progress-label'),
    thumbs: $('thumbs'), thumbPhoto: $('thumb-photo'), thumbDepth: $('thumb-depth'), thumbMask: $('thumb-mask'),
    dropHint: $('drop-hint'), fileInput: $('file-input'),
  } });

  // live projection (local diffusion service, see server/server.py)
  const projector = createProjector({
    renderer, scene, viewer: camera, solver, ribbon, material, toast,
    stepFrame: seconds => {
      const steps = Math.round(seconds / stepper.dt);
      wind.update(solver.time, seconds);
      for (let s = 0; s < steps; s++) solver.step(stepper.dt, wind.sampleAt);
      solver.updateDensity();
      sculpture.update(seconds);
    },
    elements: {
      panel: $('projector-panel'), depthCanvas: $('pp-depth'), outputCanvas: $('pp-output'),
      outputLabel: $('pp-output-label'), strip: $('pp-strip'), status: $('pp-status'),
    },
  });

  // resize + frame-rate budget
  const resize = () => {
    const w = viewport.clientWidth, h = viewport.clientHeight;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    post.setSize(w, h);
  };
  const applyQuality = () => {
    const s = quality.settings;
    renderer.setPixelRatio(baseDpr * s.scale);
    studio.params.beamSteps = s.beamSteps;
    studio.params.mirrorInterval = s.mirrorInterval;
    studio.apply();
    post.params.samples = s.samples;
    post.apply();
    projector.params.liveInterval = s.liveInterval;
    resize();
  };
  new ResizeObserver(resize).observe(viewport);
  resize();

  // pointer wand: project the pointer onto a plane through the veil facing the camera
  const wandPlane = new THREE.Plane(), raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const hit = new THREE.Vector3(), lastHit = new THREE.Vector3();
  let lastHitTime = 0, hasLastHit = false;
  renderer.domElement.addEventListener('pointermove', e => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    camera.getWorldDirection(hit);
    wandPlane.setFromNormalAndCoplanarPoint(hit.negate(), controls.target);
    if (!raycaster.ray.intersectPlane(wandPlane, hit)) return;
    const now = performance.now() / 1000;
    if (hasLastHit) {
      const dt = Math.max(1 / 240, now - lastHitTime);
      const vx = (hit.x - lastHit.x) / dt, vy = (hit.y - lastHit.y) / dt, vz = (hit.z - lastHit.z) / dt;
      const speed = Math.hypot(vx, vy, vz);
      const cap = 6;
      const s = speed > cap ? cap / speed : 1;
      wind.setWand(hit.x, hit.y, hit.z, vx * s, vy * s, vz * s);
    }
    lastHit.copy(hit); lastHitTime = now; hasLastHit = true;
  });
  renderer.domElement.addEventListener('pointerleave', () => { hasLastHit = false; wind.clearWand(); });

  // actions
  let paused = false;
  const actions = {
    pause() { paused = !paused; $('state').textContent = paused ? 'paused' : 'live'; },
    reset() { solver.reset(); stepper.reset(); ribbon.sync(); toast('cloth reset'); },
    capture() {
      post.render(timer.getElapsed());
      renderer.domElement.toBlob(blob => {
        if (!blob) { toast('capture failed'); return; }
        const url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = `venus-veil-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
        a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast('PNG saved');
      }, 'image/png');
    },
    toggleUI() { document.body.classList.toggle('ui-hidden'); },
  };
  const ui = createUI({ wind, solver, material, studio, post, actions, sculpture, projector, quality, applyQuality });
  window.addEventListener('keydown', e => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space') { e.preventDefault(); actions.pause(); }
    else if (e.key === 'r' || e.key === 'R') actions.reset();
    else if (e.key === 's' || e.key === 'S') actions.capture();
    else if (e.key === 'h' || e.key === 'H') actions.toggleUI();
  });

  // loop
  const timer = new THREE.Timer();
  timer.connect(document);
  let frames = 0, fpsTime = performance.now(), fps = 0, shadowTick = 0;
  const animate = () => {
    timer.update();
    const frameDt = timer.getDelta();
    const t = timer.getElapsed();
    if (!paused && projector.locksSimulation) {
      stepper.reset();   // the projector advances 1/30 s per generated frame
    } else if (!paused) {
      const steps = stepper.advance(frameDt);
      if (steps > 0) {
        wind.update(t, frameDt);
        for (let s = 0; s < steps; s++) solver.step(stepper.dt, wind.sampleAt);
        solver.updateDensity();
        sculpture.update(frameDt);
      }
    }
    ribbon.sync();
    controls.update();
    projector.update(Math.min(frameDt, 0.1));
    studio.update(t);
    // shadows on a schedule; the key light and the veil move slowly relative to the frame rate
    renderer.shadowMap.needsUpdate = shadowTick++ % quality.settings.shadowInterval === 0;
    post.render(t);
    frames++;
    if (quality.sample(frameDt * 1000)) applyQuality();
    const now = performance.now();
    if (now - fpsTime >= 1000) {
      fps = Math.round(frames * 1000 / (now - fpsTime));
      const scale = quality.params.scale;
      $('fps').textContent = scale < 0.995 || quality.params.level > 0
        ? `${fps} fps · ${Math.round(scale * 100)}%`
        : `${fps} fps`;
      frames = 0; fpsTime = now;
    }
  };

  // compileAsync polls with a timer, and a background tab throttles timers to
  // once a minute, so the page could hang before its first frame
  renderer.compile(scene, camera);
  ribbon.sync();
  post.render(0);
  $('loading').classList.add('loaded');
  renderer.setAnimationLoop(animate);
  sculpture.loadSample();
  if (new URLSearchParams(location.search).has('projector')) {
    projector.setEnabled(true);
    ui.gui.controllersRecursive().forEach(c => c.updateDisplay());
  }

  window.__veil = {
    solver, wind, material, studio, post, camera, controls, sculpture, renderer, ribbon, stepper, projector, quality, applyQuality,
    /** Advance the simulation by `seconds` of wind and render one frame (for headless checks). */
    simulate(seconds = 3, t0 = 0) {
      const dt = stepper.dt, steps = Math.round(seconds / dt);
      for (let s = 0; s < steps; s++) {
        if (s % 2 === 0) wind.update(t0 + s * dt, dt * 2);
        solver.step(dt, wind.sampleAt);
        if (s % 8 === 0) { solver.updateDensity(); sculpture.update(dt * 8); }
      }
      ribbon.sync(); studio.update(t0 + seconds); post.render(t0 + seconds);
      return { time: solver.time, strain: solver.maxStretchStrain() };
    },
    stats: () => ({
      fps, paused, time: solver.time, particles: solver.count, constraints: solver.constraintCount,
      strain: solver.maxStretchStrain(), depthBackend: sculpture.backend, hasRelief: !!solver.relief,
      quality: { scale: +quality.params.scale.toFixed(2), level: quality.params.level, frameMs: quality.params.frameMs },
      projector: { enabled: projector.params.enabled, mode: projector.params.mode, status: projector.state.status,
        presented: projector.state.presented, generatedFps: +projector.state.fps.toFixed(1), latencyMs: Math.round(projector.state.latencyMs) },
    }),
  };

  if (import.meta.hot) import.meta.hot.dispose(() => {
    renderer.setAnimationLoop(null); controls.dispose(); projector.dispose(); studio.dispose(); post.dispose(); ribbon.dispose();
    material.dispose(); weave.normal.dispose(); weave.alpha.dispose(); sculpture.dispose(); ui.gui.destroy(); renderer.dispose();
  });
}

start().catch(err => {
  console.error(err);
  $('loading').classList.add('loaded');
  const el = $('error');
  el.hidden = false;
  el.querySelector('p').textContent = `The studio could not start: ${err.message}`;
});
