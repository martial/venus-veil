import * as THREE from 'three';
import { createSculptureWorker } from './depth.js';
import { TEXTURE_DEFAULTS } from './veilTexture.js';
import sampleUrl from '../../assets/sculptures/willendorf.png';

/**
 * The sculpture pipeline facade. All heavy work (depth estimation, mask,
 * texture rasterisation) happens in the worker; the main thread only decodes
 * the file, uploads the returned bitmaps and updates the solver's relief.
 * Owns drag-and-drop, paste, the file input, thumbnails and the reveal ramp.
 */
export function createSculpturePipeline({ solver, material, ribbon, renderer, toast, elements }) {
  const params = {
    ...TEXTURE_DEFAULTS,
    amplitude: 0.25,
    retention: 300,
    slack: 0.01,
    revealSeconds: 3,
  };
  const state = {
    name: null,
    loaded: false,
    textures: null,       // { map, alphaMap, normalMap }
    info: null,
    generation: 0,
    busy: false,
    error: null,
    reveal: { active: false, t: 0 },
    lastDepthMs: 0,
  };
  const weave = material.userData.weave || null;
  const grid = { columns: solver.columns, rows: solver.rows };

  const worker = createSculptureWorker({ onProgress: showProgress, onStage: onStage });
  let refitTimer = null;
  let refitPending = false;

  // ------------------------------------------------------------ UI helpers
  const quiet = { value: false };
  function setProgress(label, pct) {
    const el = elements.progress;
    if (!el || quiet.value) return;
    elements.progressLabel.textContent = label;
    elements.progressBar.style.width = `${pct}%`;
    el.classList.add('visible');
  }
  function hideProgress(delay = 700) { setTimeout(() => elements.progress?.classList.remove('visible'), delay); }
  function showProgress(p) {
    if (p.status === 'progress' || p.status === 'download' || p.status === 'initiate') {
      const pct = p.progress != null ? Math.round(p.progress) : null;
      setProgress(pct != null ? `downloading depth model · ${p.file || ''} ${pct}%` : `loading depth model · ${p.file || ''}`, pct ?? 5);
    } else if (p.status === 'ready') {
      setProgress('depth model ready · estimating', 60);
    }
  }
  function onStage(m) {
    if (m.stage === 'depth-done') {
      state.lastDepthMs = m.depthMs;
      setProgress(`depth ready (${m.backend?.device} ${m.backend?.dtype}, ${m.depthMs} ms) · weaving texture`, 85);
    }
  }

  // ------------------------------------------------------------ loading
  async function decode(source) {
    const full = await createImageBitmap(source);
    const ratio = Math.min(1, 1024 / Math.max(full.width, full.height));
    if (ratio === 1) return full;
    const w = Math.max(1, Math.round(full.width * ratio)), h = Math.max(1, Math.round(full.height * ratio));
    const small = await createImageBitmap(full, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
    full.close();
    return small;
  }

  /**
   * The photo itself, for a service that takes it as an image prompt: square and
   * letterboxed on black, because the image encoder crops to a centred square and
   * would cut the head or feet off a standing figure.
   */
  async function photoBlob(bitmap) {
    const side = 512;
    const scale = side / Math.max(bitmap.width, bitmap.height);
    const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(side, side);
    const context = canvas.getContext('2d');
    context.fillStyle = '#000';
    context.fillRect(0, 0, side, side);
    context.drawImage(bitmap, (side - w) / 2, (side - h) / 2, w, h);
    return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  }

  async function loadSource(source, name, generation = ++state.generation) {
    state.busy = true;
    state.error = null;
    try {
      setProgress(`reading ${name}`, 3);
      const bitmap = await decode(source);
      if (generation !== state.generation) { bitmap.close(); return; }
      state.name = name;
      // copied before the worker takes the bitmap
      const photo = await photoBlob(bitmap);
      if (generation !== state.generation) { bitmap.close(); return; }
      // Image prompting is independent of the browser's depth model. In
      // particular, a slow/failed model download must not leave the old subject.
      api.onPhoto?.(photo, name);
      setProgress(worker.ready ? 'estimating depth' : 'loading depth model', 8);
      const result = await worker.process(bitmap, snapshotParams(), grid);
      if (generation !== state.generation) { closeResult(result); return; }
      apply(result, true);
      setProgress('sculpture woven into the veil', 100);
      hideProgress();
      toast(`${name}: depth via ${result.backend?.device} in ${result.depthMs} ms`);
    } catch (err) {
      if (generation !== state.generation) return;
      state.error = err.message;
      console.error(err);
      hideProgress(0);
      toast(`could not process ${name}: ${err.message}`, 6000);
    } finally {
      if (generation === state.generation) {
        state.busy = false;
        if (refitPending) { refitPending = false; scheduleRefit(); }
      }
    }
  }

  async function loadFile(file) {
    if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) { toast('drop a PNG, JPEG or WebP image'); return; }
    await loadSource(file, file.name);
  }

  async function loadSample() {
    const generation = ++state.generation;
    state.busy = true;
    state.error = null;
    try {
      const res = await fetch(sampleUrl);
      const blob = await res.blob();
      if (generation === state.generation) await loadSource(blob, 'willendorf.png', generation);
    } catch (err) {
      if (generation === state.generation) { state.error = err.message; toast(`sample failed: ${err.message}`); }
    } finally { if (generation === state.generation) state.busy = false; }
  }

  function snapshotParams() {
    const { amplitude, retention, slack, revealSeconds, ...textureParams } = params;
    return { ...textureParams };
  }

  // ------------------------------------------------------------ apply
  function closeResult(r) {
    for (const b of Object.values(r.textures || {})) b?.close?.();
    for (const b of Object.values(r.previews || {})) b?.close?.();
  }

  function disposeTextures() {
    if (!state.textures) return;
    for (const t of Object.values(state.textures)) t?.dispose();
    state.textures = null;
  }

  function apply(result, startReveal) {
    const aniso = renderer.capabilities.getMaxAnisotropy();
    const mk = (bitmap, colorSpace) => {
      const t = new THREE.Texture(bitmap);
      t.flipY = false;                 // bitmaps were flipped in the worker
      t.colorSpace = colorSpace;
      t.anisotropy = aniso;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.needsUpdate = true;
      return t;
    };
    disposeTextures();
    state.textures = {
      map: mk(result.textures.map, THREE.SRGBColorSpace),
      alphaMap: mk(result.textures.alpha, THREE.NoColorSpace),
      normalMap: mk(result.textures.normal, THREE.NoColorSpace),
    };
    material.map = state.textures.map;
    material.alphaMap = state.textures.alphaMap;
    material.normalMap = state.textures.normalMap;
    material.normalScale.set(1, 1);
    material.needsUpdate = true;
    ribbon.setShadowAlphaMap(state.textures.alphaMap);
    state.info = result.info;
    state.loaded = true;

    if (elements.thumbs) {
      elements.thumbs.hidden = false;
      const paint = (canvas, bitmap) => { const c = canvas.getContext('2d'); c.clearRect(0, 0, canvas.width, canvas.height); c.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close(); };
      paint(elements.thumbPhoto, result.previews.photo);
      paint(elements.thumbDepth, result.previews.depth);
      paint(elements.thumbMask, result.previews.mask);
    }
    if (elements.dropHint) {
      elements.dropHint.textContent = `${state.name} · mask from ${result.info.maskSource}${result.info.inverted ? ' · depth inverted' : ''} · drop another photo to replace`;
    }
    solver.params.kRetention = params.retention;
    solver.params.reliefSlack = params.slack;
    solver.setRelief(result.reliefGrid, result.maskGrid, params.amplitude);
    if (startReveal) { state.reveal.active = true; state.reveal.t = 0; solver.params.reveal = 0; solver.refreshReveal(); }
  }

  async function rebuild() {
    if (!state.loaded) return;
    if (state.busy) { refitPending = true; return; }
    state.busy = true;
    const generation = state.generation;
    try {
      const result = await worker.rebuild(snapshotParams(), grid);
      if (generation !== state.generation) { closeResult(result); return; }
      apply(result, false);
    } catch (err) {
      console.error(err);
      toast(`refit failed: ${err.message}`);
    } finally {
      state.busy = false;
      if (refitPending) { refitPending = false; scheduleRefit(); }
    }
  }

  function scheduleRefit() {
    clearTimeout(refitTimer);
    refitTimer = setTimeout(() => { refitTimer = null; rebuild(); }, 120);
  }

  function clear() {
    state.error = null;
    clearTimeout(refitTimer); refitTimer = null; refitPending = false;
    state.generation++;
    state.busy = false;
    state.loaded = false; state.name = null; state.info = null;
    disposeTextures();
    material.map = null;
    material.alphaMap = weave?.alpha || null;
    material.normalMap = weave?.normal || null;
    material.normalScale.setScalar(material.userData.defaults?.weaveStrength ?? 0.35);
    material.needsUpdate = true;
    ribbon.setShadowAlphaMap(null);
    solver.clearRelief();
    solver.params.reveal = 1;
    if (elements.thumbs) elements.thumbs.hidden = true;
    if (elements.dropHint) elements.dropHint.textContent = 'Drop a sculpture photo anywhere · drag to orbit · move the pointer through the veil to push it';
    api.onPhoto?.(null, null);
    toast('sculpture cleared');
  }

  function update(dt) {
    if (!state.reveal.active) return;
    state.reveal.t += dt;
    const x = Math.min(1, state.reveal.t / Math.max(0.01, params.revealSeconds));
    const eased = 1 - Math.pow(1 - x, 3);
    solver.params.reveal = eased;
    solver.refreshReveal();
    if (x >= 1) state.reveal.active = false;
  }

  // ------------------------------------------------------------ inputs
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; document.body.classList.add('drag'); });
  window.addEventListener('dragover', e => { e.preventDefault(); });
  window.addEventListener('dragleave', e => { e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (dragDepth === 0) document.body.classList.remove('drag'); });
  window.addEventListener('drop', e => {
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('drag');
    const file = e.dataTransfer?.files?.[0];
    if (file) loadFile(file);
  });
  elements.fileInput?.addEventListener('change', e => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = ''; });
  window.addEventListener('paste', e => {
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (item) loadFile(item.getAsFile());
  });

  // ------------------------------------------------------------ GUI
  function buildControls(folder) {
    folder.add(params, 'amplitude', 0, 0.6, 0.005).name('relief').onChange(v => { solver.setAmplitude(v); });
    folder.add(params, 'retention', 0, 1500, 5).name('shape retention').onChange(v => { solver.params.kRetention = v; });
    folder.add(params, 'slack', 0, 0.08, 0.001).name('collider slack').onChange(v => { solver.params.reliefSlack = v; });
    folder.add(solver.params, 'collider').name('collider');
    folder.add(params, 'invert').name('invert depth').onChange(scheduleRefit);
    folder.add(params, 'scale', 0.3, 2.5, 0.01).name('figure scale').onChange(scheduleRefit);
    folder.add(params, 'offsetU', 0, 1, 0.005).name('along ribbon').onChange(scheduleRefit);
    folder.add(params, 'offsetV', 0, 1, 0.005).name('across ribbon').onChange(scheduleRefit);
    folder.add(params, 'rotate90').name('lay along length').onChange(scheduleRefit);
    folder.add(params, 'mirror').name('mirror').onChange(scheduleRefit);
    folder.add(params, 'figureOpacity', 0.2, 1, 0.01).name('figure opacity').onChange(scheduleRefit);
    folder.add(params, 'veilOpacity', 0, 1, 0.01).name('veil opacity').onChange(scheduleRefit);
    folder.add(params, 'detail', 0, 2, 0.01).name('surface detail').onChange(scheduleRefit);
    folder.add(params, 'tintStrength', 0, 1, 0.01).name('stone tint').onChange(scheduleRefit);
    folder.add(params, 'revealSeconds', 0, 8, 0.1).name('reveal (s)');
    const actions = {
      load: () => elements.fileInput?.click(),
      sample: () => loadSample(),
      replay: () => { if (state.loaded) { state.reveal.active = true; state.reveal.t = 0; solver.params.reveal = 0; solver.refreshReveal(); } },
      clear,
    };
    folder.add(actions, 'load').name('load photo…');
    folder.add(actions, 'sample').name('load sample (Willendorf)');
    folder.add(actions, 'replay').name('replay reveal');
    folder.add(actions, 'clear').name('clear sculpture');
  }

  const api = {
    params, state,
    onPhoto: null,     // (jpeg blob | null, name) => void, as soon as a photo is decoded, or cleared
    /** Hold back status messages while something else owns the progress line. */
    setQuiet(value) { quiet.value = value; },
    /** Wait for the current depth, then finish its reveal even when the cloth is paused. */
    async whenReady({ cancelled = () => false } = {}) {
      while (state.busy || refitTimer || refitPending) {
        if (cancelled()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (state.error) throw new Error(`Photo depth is not ready: ${state.error}`);
      if (state.reveal.active) update(params.revealSeconds);
    },
    get backend() { return worker.backend; },
    loadFile, loadSample, loadSource, rebuild, clear, update, buildControls,
    preload: () => worker.load().catch(err => console.warn('[depth] preload failed', err)),
    dispose() { worker.dispose(); disposeTextures(); },
  };
  return api;
}
