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
import { createUI } from './ui.js';
import { createSculpturePipeline } from './pipeline/sculpture.js';

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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
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
  const stepper = createStepper({ dt: 1 / 120, maxSubsteps: 8, maxFrameDt: 1 / 10 });

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

  // resize
  const resize = () => {
    const w = viewport.clientWidth, h = viewport.clientHeight;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    post.setSize(w, h);
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
  const ui = createUI({ wind, solver, material, studio, post, actions, sculpture });
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
  let frames = 0, fpsTime = performance.now(), fps = 0;
  const animate = () => {
    timer.update();
    const frameDt = timer.getDelta();
    const t = timer.getElapsed();
    if (!paused) {
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
    studio.update(t);
    post.render(t);
    frames++;
    const now = performance.now();
    if (now - fpsTime >= 1000) {
      fps = Math.round(frames * 1000 / (now - fpsTime));
      $('fps').textContent = `${fps} fps`;
      frames = 0; fpsTime = now;
    }
  };

  await renderer.compileAsync(scene, camera);
  ribbon.sync();
  post.render(0);
  $('loading').classList.add('loaded');
  renderer.setAnimationLoop(animate);
  sculpture.loadSample();

  window.__veil = {
    solver, wind, material, studio, post, camera, controls, sculpture, renderer, ribbon, stepper,
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
    }),
  };

  if (import.meta.hot) import.meta.hot.dispose(() => {
    renderer.setAnimationLoop(null); controls.dispose(); studio.dispose(); post.dispose(); ribbon.dispose();
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
