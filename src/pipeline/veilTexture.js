/**
 * Photo (+ depth) → veil textures and relief grid.
 *
 * The pure-math half (thresholds, masks, fitting, resampling) is DOM-free and
 * unit-tested. The canvas half rasterises into "ribbon space": a 5:2 canvas
 * whose (x, y) is the ribbon's (u, 1 - v), so texture UV == ribbon UV.
 */

export const TEXTURE_DEFAULTS = {
  scale: 1,
  offsetU: 0.5,
  offsetV: 0.5,
  rotate90: true,
  mirror: false,
  padding: 0.08,
  figureOpacity: 0.7,
  veilOpacity: 0.3,
  detail: 0.35,
  tintStrength: 0.35,
  feather: 4,
  invert: false,
};

export const RIBBON_ASPECT = { width: 5, height: 2 };

// ---------------------------------------------------------------- pure math

export function percentile(values, p, mask = null) {
  const arr = [];
  for (let i = 0; i < values.length; i++) if (!mask || mask[i] > 0.5) arr.push(values[i]);
  if (arr.length === 0) return 0;
  arr.sort((a, b) => a - b);
  const idx = Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))));
  return arr[idx];
}

/** Otsu threshold for values in [0, 1]. */
export function otsuThreshold(values, bins = 256) {
  const hist = new Float64Array(bins);
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    hist[Math.min(bins - 1, Math.max(0, Math.floor(v * (bins - 1))))]++;
    total++;
  }
  let sum = 0;
  for (let b = 0; b < bins; b++) sum += b * hist[b];
  let sumB = 0, wB = 0, best = 0, first = 0, last = 0;
  for (let b = 0; b < bins; b++) {
    wB += hist[b];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += b * hist[b];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best * (1 + 1e-9)) { best = between; first = b; last = b; }
    else if (Math.abs(between - best) <= best * 1e-9) last = b;
  }
  // in a clean gap the variance is flat: take the middle of the plateau
  return (first + last) / 2 / (bins - 1);
}

export function luminance(rgba, w, h, out = new Float32Array(w * h)) {
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    out[i] = (rgba[j] * 0.2126 + rgba[j + 1] * 0.7152 + rgba[j + 2] * 0.0722) / 255;
  }
  return out;
}

/** Separable box blur on a w×h float field; radius in pixels; returns a new array. */
export function boxBlur2D(src, w, h, radius) {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return Float32Array.from(src);
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0, n = 0;
    for (let x = -r; x <= r; x++) { const xx = Math.min(w - 1, Math.max(0, x)); acc += src[y * w + xx]; n++; }
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / n;
      const xOut = Math.min(w - 1, Math.max(0, x - r)), xIn = Math.min(w - 1, Math.max(0, x + r + 1));
      acc += src[y * w + xIn] - src[y * w + xOut];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0, n = 0;
    for (let y = -r; y <= r; y++) { const yy = Math.min(h - 1, Math.max(0, y)); acc += tmp[yy * w + x]; n++; }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / n;
      const yOut = Math.min(h - 1, Math.max(0, y - r)), yIn = Math.min(h - 1, Math.max(0, y + r + 1));
      acc += tmp[yIn * w + x] - tmp[yOut * w + x];
    }
  }
  return out;
}

/** Erode a binary mask by one pixel (4-neighbourhood). */
export function erode(mask, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (mask[i] < 0.5) continue;
    const l = x > 0 ? mask[i - 1] : 0, r = x < w - 1 ? mask[i + 1] : 0;
    const u = y > 0 ? mask[i - w] : 0, d = y < h - 1 ? mask[i + w] : 0;
    out[i] = (l > 0.5 && r > 0.5 && u > 0.5 && d > 0.5) ? 1 : 0;
  }
  return out;
}

/**
 * Fill holes: everything not connected to the image border through
 * background pixels becomes foreground (dark crevices inside a figure stay
 * part of the figure). 4-connected flood fill from the border.
 */
export function fillHoles(mask, w, h) {
  const out = Float32Array.from(mask);
  const visited = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => {
    const i = y * w + x;
    if (visited[i] || mask[i] > 0.5) return;
    visited[i] = 1; stack.push(i);
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i - x) / w;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  for (let i = 0; i < out.length; i++) if (!visited[i]) out[i] = 1;
  return out;
}

/** Dilate a binary mask by one pixel (4-neighbourhood). */
export function dilate(mask, w, h) {
  const out = Float32Array.from(mask);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (mask[i] > 0.5) continue;
    if ((x > 0 && mask[i - 1] > 0.5) || (x < w - 1 && mask[i + 1] > 0.5) || (y > 0 && mask[i - w] > 0.5) || (y < h - 1 && mask[i + w] > 0.5)) out[i] = 1;
  }
  return out;
}

/** Is the photo on a dark background? Looks at the border ring. */
export function hasDarkBackground(luma, w, h, threshold = 0.16) {
  const ring = [];
  const b = Math.max(1, Math.round(Math.min(w, h) * 0.03));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x < b || y < b || x >= w - b || y >= h - b) ring.push(luma[y * w + x]);
  }
  ring.sort((a, c) => a - c);
  return ring[Math.floor(ring.length * 0.5)] < threshold;
}

/**
 * Foreground mask from luminance (dark background) or depth (otherwise).
 * Returns { hard, soft, source } with soft = eroded + feathered.
 */
export function buildMask(luma, depth, w, h, { feather = 4 } = {}) {
  const dark = hasDarkBackground(luma, w, h);
  const hard = new Float32Array(w * h);
  let source;
  if (dark) {
    source = 'luma';
    const t = Math.max(0.06, Math.min(0.25, otsuThreshold(luma) * 0.6));
    for (let i = 0; i < hard.length; i++) hard[i] = luma[i] > t ? 1 : 0;
  } else if (depth) {
    source = 'depth';
    const t = otsuThreshold(depth);
    for (let i = 0; i < hard.length; i++) hard[i] = depth[i] > t ? 1 : 0;
  } else {
    source = 'none';
    hard.fill(1);
  }
  // closing (dilate → erode) bridges thin dark crevices, then fill enclosed holes
  let closed = hard;
  for (let k = 0; k < 2; k++) closed = dilate(closed, w, h);
  for (let k = 0; k < 2; k++) closed = erode(closed, w, h);
  const filled = fillHoles(closed, w, h);
  const eroded = erode(filled, w, h);
  const soft = boxBlur2D(eroded, w, h, feather);
  return { hard: filled, soft, source, dark };
}

/** Normalise depth inside the mask with robust percentiles; 0 outside. Optionally invert. */
export function normalizeDepth(depth, mask, { lo = 0.02, hi = 0.98, invert = false } = {}) {
  const out = new Float32Array(depth.length);
  const a = percentile(depth, lo, mask), b = percentile(depth, hi, mask);
  const range = Math.max(1e-6, b - a);
  for (let i = 0; i < depth.length; i++) {
    if (mask[i] < 0.5) continue;
    let v = (depth[i] - a) / range;
    v = Math.min(1, Math.max(0, v));
    out[i] = invert ? 1 - v : v;
  }
  return out;
}

/** True when the masked region is nearer (higher) than the background on average. */
export function figureIsNearer(depth, mask) {
  let inSum = 0, inN = 0, outSum = 0, outN = 0;
  for (let i = 0; i < depth.length; i++) {
    if (mask[i] > 0.5) { inSum += depth[i]; inN++; } else { outSum += depth[i]; outN++; }
  }
  if (inN === 0 || outN === 0) return true;
  return inSum / inN >= outSum / outN;
}

export function maskBounds(mask, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (mask[y * w + x] > 0.5) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return { x0: 0, y0: 0, x1: w - 1, y1: h - 1, empty: true };
  return { x0, y0, x1, y1, empty: false };
}

/**
 * Fit: maps ribbon (u, v) in [0,1]² to image pixels and back.
 * With rotate90 the figure's vertical axis lies along the ribbon length (u),
 * head toward high u. Contain-fit of the mask bounds with padding.
 */
export function createFit(bounds, params = {}) {
  const p = { ...TEXTURE_DEFAULTS, ...params };
  const W = RIBBON_ASPECT.width, H = RIBBON_ASPECT.height;
  const bw = Math.max(1, bounds.x1 - bounds.x0 + 1), bh = Math.max(1, bounds.y1 - bounds.y0 + 1);
  const cx = (bounds.x0 + bounds.x1) / 2, cy = (bounds.y0 + bounds.y1) / 2;
  const padU = p.padding * W, padV = p.padding * H;
  // units per pixel
  const along = p.rotate90 ? bh : bw, across = p.rotate90 ? bw : bh;
  const scale = Math.min((W - 2 * padU) / along, (H - 2 * padV) / across) * p.scale;
  const cu = p.offsetU * W, cv = p.offsetV * H;
  const m = p.mirror ? -1 : 1;
  return {
    scale, cu, cv, rotate90: p.rotate90, mirror: p.mirror, cx, cy, W, H,
    toImage(u, v) {
      const pu = u * W - cu, pv = v * H - cv;
      if (p.rotate90) return [cx + (pv / scale) * m, cy - pu / scale];
      return [cx + (pu / scale) * m, cy - pv / scale];
    },
    toUV(x, y) {
      const dx = (x - cx) * m * scale, dy = -(y - cy) * scale;
      if (p.rotate90) return [(dy + cu) / W, (dx + cv) / H];
      return [(dx + cu) / W, (dy + cv) / H];
    },
  };
}

/** Bilinear sample of a w×h field at pixel coords (x, y); 0 outside. */
export function sampleBilinear(field, w, h, x, y) {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 0;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const tx = x - x0, ty = y - y0;
  const a = field[y0 * w + x0], b = field[y0 * w + x1], c = field[y1 * w + x0], d = field[y1 * w + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/**
 * Resample an image-space field onto the solver grid through the fit.
 * blurRadius (px) area-averages the field first so coarse vertices don't alias.
 */
export function resampleToGrid(field, w, h, columns, rows, fit, blurRadius = 0) {
  const src = blurRadius > 0 ? boxBlur2D(field, w, h, blurRadius) : field;
  const out = new Float32Array((columns + 1) * (rows + 1));
  for (let y = 0; y <= rows; y++) for (let x = 0; x <= columns; x++) {
    const [ix, iy] = fit.toImage(x / columns, y / rows);
    out[y * (columns + 1) + x] = sampleBilinear(src, w, h, ix, iy);
  }
  return out;
}

/** High-pass of a field (detail = field − blur(field)), scaled and centred at 0. */
export function highPass(field, w, h, radius, gain = 1) {
  const low = boxBlur2D(field, w, h, radius);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = (field[i] - low[i]) * gain;
  return out;
}

/** Sobel normal map (RGB 0..255) from a height field; strength scales the slope. */
export function normalMapFromHeight(height, w, h, strength, out = new Uint8ClampedArray(w * h * 4)) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const xl = Math.max(0, x - 1), xr = Math.min(w - 1, x + 1), yu = Math.max(0, y - 1), yd = Math.min(h - 1, y + 1);
    const tl = height[yu * w + xl], t = height[yu * w + x], tr = height[yu * w + xr];
    const l = height[y * w + xl], r = height[y * w + xr];
    const bl = height[yd * w + xl], b = height[yd * w + x], br = height[yd * w + xr];
    const dx = ((tr + 2 * r + br) - (tl + 2 * l + bl)) * strength;
    const dy = ((bl + 2 * b + br) - (tl + 2 * t + tr)) * strength;
    const len = Math.hypot(dx, dy, 1);
    const i = (y * w + x) * 4;
    out[i] = (0.5 - dx / len * 0.5) * 255;
    out[i + 1] = (0.5 + dy / len * 0.5) * 255;   // canvas y is down; tangent-space +y is up
    out[i + 2] = (0.5 + 1 / len * 0.5) * 255;
    out[i + 3] = 255;
  }
  return out;
}

/**
 * Solver grids straight from image space through the fit (no canvas):
 * relief = normalised depth × soft mask, mask = soft mask; 0 outside the figure
 * and outside the image by construction.
 */
export function computeSolverGrids({ w, h, depthNorm, maskSoft, bounds }, { columns, rows }, params = {}) {
  const fit = createFit(bounds, params);
  const cellPx = 0.5 * (RIBBON_ASPECT.width / columns) / Math.max(1e-6, fit.scale);
  const reliefImage = new Float32Array(w * h);
  for (let i = 0; i < reliefImage.length; i++) reliefImage[i] = (depthNorm ? depthNorm[i] : 0) * maskSoft[i];
  const reliefGrid = resampleToGrid(reliefImage, w, h, columns, rows, fit, cellPx);
  const maskGrid = resampleToGrid(maskSoft, w, h, columns, rows, fit, cellPx);
  return { reliefGrid, maskGrid, fit };
}

// ---------------------------------------------------------------- canvas half (browser only)

function makeCanvas(w, h) {
  if (typeof document === 'undefined' && typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/**
 * Analyse a working-resolution photo canvas + raw depth → masks and normalised depth.
 */
export function analyzePhoto(photoCanvas, depth, params = {}) {
  const p = { ...TEXTURE_DEFAULTS, ...params };
  const w = photoCanvas.width, h = photoCanvas.height;
  const ctx = photoCanvas.getContext('2d', { willReadFrequently: true });
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const luma = luminance(rgba, w, h);
  let rawDepth = null;
  if (depth && depth.width === w && depth.height === h) rawDepth = depth.data;
  else if (depth) {
    // resample depth to the working size
    rawDepth = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      rawDepth[y * w + x] = sampleBilinear(depth.data, depth.width, depth.height, x / (w - 1) * (depth.width - 1), y / (h - 1) * (depth.height - 1));
    }
  }
  const mask = buildMask(luma, rawDepth, w, h, { feather: p.feather });
  let depthNorm = null, inverted = false;
  if (rawDepth) {
    const nearer = figureIsNearer(rawDepth, mask.hard);
    inverted = (!nearer) !== !!p.invert;
    depthNorm = normalizeDepth(rawDepth, mask.hard, { invert: inverted });
  }
  const bounds = maskBounds(mask.hard, w, h);
  return { w, h, rgba, luma, rawDepth, depthNorm, mask, bounds, inverted };
}

/**
 * Build ribbon-space textures (map / alphaMap / normalMap canvases) plus the
 * relief + mask grids for the solver.
 */
export function buildVeilTextures(analysis, { columns, rows }, params = {}) {
  const p = { ...TEXTURE_DEFAULTS, ...params };
  const { w, h, rgba, luma, depthNorm, mask, bounds } = analysis;
  const fit = createFit(bounds, p);

  // ---- per-pixel figure layers in image space
  const tint = makeCanvas(w, h), dens = makeCanvas(w, h), height = makeCanvas(w, h);
  const tintData = tint.getContext('2d').createImageData(w, h);
  const densData = dens.getContext('2d').createImageData(w, h);
  const heightData = height.getContext('2d').createImageData(w, h);
  const detail = highPass(luma, w, h, 6, 1);
  const lo = percentile(luma, 0.05, mask.hard), hi = percentile(luma, 0.95, mask.hard);
  const range = Math.max(1e-3, hi - lo);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const a = Math.round(mask.soft[i] * 255);
    // tint: desaturated, lifted, warmed stone
    const r = rgba[j] / 255, g = rgba[j + 1] / 255, b = rgba[j + 2] / 255;
    const y = luma[i];
    const lift = 0.3 + 0.6 * Math.min(1, (y - lo) / range + 0.15);
    const mix = (c, warm) => (y * (1 - p.tintStrength * 0.6) + c * p.tintStrength * 0.6) * lift * warm;
    tintData.data[j] = Math.min(255, mix(r, 1.0) * 255 + 14);
    tintData.data[j + 1] = Math.min(255, mix(g, 0.95) * 255 + 9);
    tintData.data[j + 2] = Math.min(255, mix(b, 0.86) * 255 + 3);
    tintData.data[j + 3] = a;
    // density: contrast-enhanced luma, 0.6..1
    const c = Math.min(1, Math.max(0, (y - lo) / range));
    const d = Math.round((0.6 + 0.4 * c) * p.figureOpacity * 255);
    densData.data[j] = d; densData.data[j + 1] = d; densData.data[j + 2] = d; densData.data[j + 3] = a;
    // height: R = detail (centred at 128), G = depth (relief), B unused
    heightData.data[j] = Math.min(255, Math.max(0, 128 + detail[i] * 255 * 2));
    heightData.data[j + 1] = depthNorm ? Math.round(depthNorm[i] * 255) : 0;
    heightData.data[j + 2] = 0;
    heightData.data[j + 3] = a;
  }
  tint.getContext('2d').putImageData(tintData, 0, 0);
  dens.getContext('2d').putImageData(densData, 0, 0);
  height.getContext('2d').putImageData(heightData, 0, 0);

  // ---- rasterise into ribbon space
  const RW = 2048, RH = Math.round(RW * RIBBON_ASPECT.height / RIBBON_ASPECT.width);
  const drawFitted = (ctx, source) => {
    // ribbon canvas: x = u * RW, y = (1 - v) * RH ; image → uv via fit
    ctx.save();
    // pixel of ribbon canvas per image pixel
    const s = fit.scale * RW / RIBBON_ASPECT.width;
    const [cx0, cy0] = fit.toUV(fit.cx, fit.cy);         // uv of the image centre
    ctx.translate(cx0 * RW, (1 - cy0) * RH);
    if (fit.rotate90) ctx.rotate(fit.mirror ? Math.PI / 2 : -Math.PI / 2);
    if (fit.mirror && !fit.rotate90) ctx.scale(-1, 1);
    ctx.scale(s, s);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, -fit.cx, -fit.cy);
    ctx.restore();
  };

  const mapCanvas = makeCanvas(RW, RH);
  const mctx = mapCanvas.getContext('2d');
  mctx.fillStyle = '#f3ede2'; mctx.fillRect(0, 0, RW, RH);
  drawFitted(mctx, tint);

  const alphaCanvas = makeCanvas(RW, RH);
  const actx = alphaCanvas.getContext('2d');
  const vo = Math.round(p.veilOpacity * 255);
  actx.fillStyle = `rgb(${vo},${vo},${vo})`; actx.fillRect(0, 0, RW, RH);
  drawFitted(actx, dens);

  // height/relief/mask canvas stays TRANSPARENT outside the figure: alpha is the mask
  const heightCanvas = makeCanvas(RW, RH);
  const hctx = heightCanvas.getContext('2d', { willReadFrequently: true });
  drawFitted(hctx, height);
  const hd = hctx.getImageData(0, 0, RW, RH).data;
  const heightField = new Float32Array(RW * RH);
  for (let i = 0, j = 0; i < RW * RH; i++, j += 4) {
    const a = hd[j + 3] / 255;
    heightField[i] = a > 0 ? ((hd[j] - 128) / 255) * p.detail * a + (hd[j + 1] / 255) * 0.35 * a : 0;
  }
  const normalCanvas = makeCanvas(RW, RH);
  const nctx = normalCanvas.getContext('2d');
  const nImg = nctx.createImageData(RW, RH);
  normalMapFromHeight(heightField, RW, RH, 3.5, nImg.data);
  nctx.putImageData(nImg, 0, 0);

  // ---- solver grids from image space through the same fit (pure, tested)
  const { reliefGrid, maskGrid } = computeSolverGrids({ w, h, depthNorm, maskSoft: mask.soft, bounds }, { columns, rows }, p);

  return { mapCanvas, alphaCanvas, normalCanvas, reliefGrid, maskGrid, fit, size: [RW, RH] };
}

/** Draw the preview thumbnails (photo / depth / mask). */
export function drawPreviews(analysis, photoCanvas, canvases) {
  const { w, h, depthNorm, mask } = analysis;
  const draw = (canvas, paint) => {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0a0a0c'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const s = Math.min(canvas.width / w, canvas.height / h);
    const dw = w * s, dh = h * s, ox = (canvas.width - dw) / 2, oy = (canvas.height - dh) / 2;
    paint(ctx, ox, oy, dw, dh);
  };
  draw(canvases.photo, (ctx, ox, oy, dw, dh) => ctx.drawImage(photoCanvas, ox, oy, dw, dh));
  const field = (values, mapper) => {
    const c = makeCanvas(w, h), ctx = c.getContext('2d'), img = ctx.createImageData(w, h);
    for (let i = 0, j = 0; i < w * h; i++, j += 4) { const v = mapper(values ? values[i] : 0); img.data[j] = img.data[j + 1] = img.data[j + 2] = v; img.data[j + 3] = 255; }
    ctx.putImageData(img, 0, 0);
    return c;
  };
  const depthImg = field(depthNorm, v => Math.round(v * 255));
  const maskImg = field(mask.soft, v => Math.round(v * 255));
  draw(canvases.depth, (ctx, ox, oy, dw, dh) => ctx.drawImage(depthImg, ox, oy, dw, dh));
  draw(canvases.mask, (ctx, ox, oy, dw, dh) => ctx.drawImage(maskImg, ox, oy, dw, dh));
}
