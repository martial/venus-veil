/**
 * Sculpture worker: Depth Anything V2 (small) via @huggingface/transformers,
 * plus the whole photo → veil texture build (OffscreenCanvas), so the main
 * thread never stalls while the veil keeps flying.
 *
 * Messages (all carry an `id`):
 *   { type: 'load' }                                   -> { type: 'ready', backend }
 *   { type: 'process', bitmap, params, grid }          -> { type: 'result', ...payload }   (depth + textures)
 *   { type: 'rebuild', params, grid }                  -> { type: 'result', ...payload }   (textures only, cached depth)
 *   progress: { type: 'progress', status, file, progress, loaded, total }
 * payload: depthMs, backend, info {maskSource, inverted, width, height}, reliefGrid, maskGrid,
 *          textures {map, alpha, normal} (ImageBitmaps, flipped for WebGL), previews {photo, depth, mask} (ImageBitmaps)
 */
import { pipeline, env, RawImage } from '@huggingface/transformers';
import { analyzePhoto, buildVeilTextures, drawPreviews } from './veilTexture.js';

const MODEL = 'onnx-community/depth-anything-v2-small';
let pipe = null;
let backend = null;
let loading = null;
let photo = null;      // OffscreenCanvas, working resolution
let depth = null;      // { width, height, data }

env.allowLocalModels = false;

async function pickBackend() {
  try {
    if (typeof navigator !== 'undefined' && navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return { device: 'webgpu', dtype: adapter.features?.has('shader-f16') ? 'fp16' : 'fp32' };
    }
  } catch (err) { /* fall through to wasm */ }
  return { device: 'wasm', dtype: 'q8' };
}

function progress(p) {
  self.postMessage({ type: 'progress', status: p.status, file: p.file, progress: p.progress, loaded: p.loaded, total: p.total });
}

async function ensurePipeline() {
  if (pipe) return backend;
  if (loading) return loading;
  loading = (async () => {
    const preferred = await pickBackend();
    try {
      pipe = await pipeline('depth-estimation', MODEL, { ...preferred, progress_callback: progress });
      backend = preferred;
    } catch (err) {
      console.warn('[depth] preferred backend failed, falling back to wasm:', err?.message || err);
      backend = { device: 'wasm', dtype: 'q8' };
      pipe = await pipeline('depth-estimation', MODEL, { ...backend, progress_callback: progress });
    }
    return backend;
  })();
  try { return await loading; } finally { loading = null; }
}

function toFloat32(tensor) {
  if (tensor.type === 'float32') return new Float32Array(tensor.data);
  if (tensor.type === 'float16' && tensor.data instanceof Uint16Array) return new Float32Array(tensor.to('float32').data);
  return Float32Array.from(tensor.data);
}

async function estimateDepth(canvas) {
  await ensurePipeline();
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let image;
  if (typeof RawImage === 'function') {
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    image = new RawImage(data.data, canvas.width, canvas.height, 4);
  } else {
    image = await canvas.convertToBlob({ type: 'image/png' });
  }
  const out = await pipe(image);
  const tensor = out.predicted_depth;
  const dims = tensor.dims;
  return { height: dims[dims.length - 2], width: dims[dims.length - 1], data: toFloat32(tensor) };
}

async function toBitmap(canvas, flip) {
  return createImageBitmap(canvas, flip ? { imageOrientation: 'flipY' } : {});
}

async function buildAll(params, grid) {
  const analysis = analyzePhoto(photo, depth, params);
  const built = buildVeilTextures(analysis, grid, params);
  const pv = { photo: new OffscreenCanvas(144, 144), depth: new OffscreenCanvas(144, 144), mask: new OffscreenCanvas(144, 144) };
  drawPreviews(analysis, photo, pv);
  const [map, alpha, normal, pPhoto, pDepth, pMask] = await Promise.all([
    toBitmap(built.mapCanvas, true), toBitmap(built.alphaCanvas, true), toBitmap(built.normalCanvas, true),
    toBitmap(pv.photo, false), toBitmap(pv.depth, false), toBitmap(pv.mask, false),
  ]);
  return {
    textures: { map, alpha, normal },
    previews: { photo: pPhoto, depth: pDepth, mask: pMask },
    reliefGrid: built.reliefGrid,
    maskGrid: built.maskGrid,
    info: { maskSource: analysis.mask.source, inverted: analysis.inverted, width: analysis.w, height: analysis.h, hasDepth: !!depth },
  };
}

function postResult(id, extra, result) {
  const { textures, previews, reliefGrid, maskGrid, info } = result;
  const transfer = [textures.map, textures.alpha, textures.normal, previews.photo, previews.depth, previews.mask, reliefGrid.buffer, maskGrid.buffer];
  self.postMessage({ type: 'result', id, ...extra, textures, previews, reliefGrid, maskGrid, info, backend }, transfer);
}

self.onmessage = async (event) => {
  const { type, id } = event.data;
  try {
    if (type === 'load') {
      const b = await ensurePipeline();
      self.postMessage({ type: 'ready', id, backend: b });
    } else if (type === 'process') {
      const { bitmap, params, grid } = event.data;
      photo = new OffscreenCanvas(bitmap.width, bitmap.height);
      photo.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0);
      bitmap.close();
      depth = null;
      const t0 = performance.now();
      depth = await estimateDepth(photo);
      const depthMs = Math.round(performance.now() - t0);
      self.postMessage({ type: 'stage', id, stage: 'depth-done', depthMs, backend });
      const result = await buildAll(params, grid);
      postResult(id, { depthMs }, result);
    } else if (type === 'rebuild') {
      if (!photo) throw new Error('no photo loaded');
      const result = await buildAll(event.data.params, event.data.grid);
      postResult(id, { depthMs: 0 }, result);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err?.message || String(err) });
  }
};
