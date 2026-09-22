/**
 * CPU depth capture of the veil's triangles from the projector's point of view.
 * No GPU readback stall; perspective-correct metric depth, nearest-surface
 * z-buffer, homogeneous near/far clipping. DOM-free (unit-tested in node).
 *
 * Outputs, reused between calls:
 *   gray   Uint8Array(size²), top-left origin — the model input. 0 = no surface,
 *          otherwise 20..255, brighter = nearer (between near and far).
 *   metric Float32Array(size²), bottom-left origin (GL texture rows) — view-space
 *          distance of the nearest surface, EMPTY_DEPTH where nothing was drawn.
 *   value  Float32Array(size²), top-left origin — an optional per-vertex field
 *          (the sculpture relief) sampled at the nearest surface.
 */
export const EMPTY_DEPTH = 1e4;

export function createDepthRaster(size) {
  return {
    size,
    gray: new Uint8Array(size * size),
    value: new Float32Array(size * size),
    metric: new Float32Array(size * size),
    zbuf: new Float32Array(size * size),
    screen: null,   // per-vertex [sx, sy, ndcZ, 1/w]
    clip: null,     // per-vertex clip coords
    covered: 0,
  };
}

/**
 * positions: Float32Array (xyz per vertex, world space)
 * indices:   Uint32Array/Uint16Array triangle list
 * m:         16 numbers, column-major view-projection matrix (THREE.Matrix4.elements)
 */
export function rasterDepth(raster, positions, indices, m, near, far, values = null) {
  const { size, gray, metric, zbuf, value } = raster;
  const vertexCount = positions.length / 3;
  if (!raster.screen || raster.screen.length !== vertexCount * 4) {
    raster.screen = new Float64Array(vertexCount * 4);
    raster.clip = new Float64Array(vertexCount * 4);
  }
  const { screen, clip } = raster;
  gray.fill(0);
  metric.fill(EMPTY_DEPTH);
  value.fill(0);
  zbuf.fill(Infinity);
  raster.covered = 0;
  raster.nearest = Infinity;
  raster.farthest = -Infinity;
  const range = Math.max(1e-6, far - near);

  for (let i = 0, j = 0; i < positions.length; i += 3, j += 4) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    clip[j] = cx; clip[j + 1] = cy; clip[j + 2] = cz; clip[j + 3] = cw;
    const inv = 1 / cw;
    screen[j] = (cx * inv * 0.5 + 0.5) * size;
    screen[j + 1] = (0.5 - cy * inv * 0.5) * size;
    screen[j + 2] = cz * inv;
    screen[j + 3] = inv;
  }

  // vertex index for each screen slot, so the value channel can be interpolated
  const draw = (c, a, b, d, va = -1, vb = -1, vd = -1) => {
    const ax = c[a], ay = c[a + 1], az = c[a + 2], aw = c[a + 3];
    const bx = c[b], by = c[b + 1], bz = c[b + 2], bw = c[b + 3];
    const dx = c[d], dy = c[d + 1], dz = c[d + 2], dw = c[d + 3];
    const area = (by - dy) * (ax - dx) + (dx - bx) * (ay - dy);
    if (Math.abs(area) < 1e-12) return;
    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, dx) - 0.5));
    const x1 = Math.min(size - 1, Math.floor(Math.max(ax, bx, dx) - 0.5));
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by, dy) - 0.5));
    const y1 = Math.min(size - 1, Math.floor(Math.max(ay, by, dy) - 0.5));
    const invArea = 1 / area;
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const u = ((by - dy) * (px - dx) + (dx - bx) * (py - dy)) * invArea;
        if (u < 0) continue;
        const v = ((dy - ay) * (px - dx) + (ax - dx) * (py - dy)) * invArea;
        if (v < 0) continue;
        const w = 1 - u - v;
        if (w < 0) continue;
        const zndc = u * az + v * bz + w * dz;
        const k = y * size + x;
        if (zndc >= zbuf[k]) continue;
        if (zbuf[k] === Infinity) raster.covered++;
        zbuf[k] = zndc;
        const dist = 1 / (u * aw + v * bw + w * dw);
        const t = 1 - Math.min(1, Math.max(0, (dist - near) / range));
        gray[k] = 20 + Math.round(235 * t);
        metric[(size - 1 - y) * size + x] = dist;
        if (dist < raster.nearest) raster.nearest = dist;
        if (dist > raster.farthest) raster.farthest = dist;
        if (values && va >= 0) {
          // perspective-correct interpolation of the per-vertex field
          value[k] = (u * values[va] * aw + v * values[vb] * bw + w * values[vd] * dw) * dist;
        }
      }
    }
  };

  const clipPlane = (poly, sign) => {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const da = a[3] + sign * a[2], db = b[3] + sign * b[2];
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2]), a[3] + t * (b[3] - a[3])]);
      }
    }
    return out;
  };
  const outside = k => clip[k + 2] < -clip[k + 3] || clip[k + 2] > clip[k + 3];

  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 4, b = indices[i + 1] * 4, d = indices[i + 2] * 4;
    if (!outside(a) && !outside(b) && !outside(d)) { draw(screen, a, b, d, indices[i], indices[i + 1], indices[i + 2]); continue; }
    const tri = [
      [clip[a], clip[a + 1], clip[a + 2], clip[a + 3]],
      [clip[b], clip[b + 1], clip[b + 2], clip[b + 3]],
      [clip[d], clip[d + 1], clip[d + 2], clip[d + 3]],
    ];
    const poly = clipPlane(clipPlane(tri, 1), -1);
    if (poly.length < 3) continue;
    const c = new Float64Array(poly.length * 4);
    for (let n = 0; n < poly.length; n++) {
      const v = poly[n], inv = 1 / v[3];
      c[n * 4] = (v[0] * inv * 0.5 + 0.5) * size;
      c[n * 4 + 1] = (0.5 - v[1] * inv * 0.5) * size;
      c[n * 4 + 2] = v[2] * inv;
      c[n * 4 + 3] = inv;
    }
    for (let n = 1; n < poly.length - 1; n++) draw(c, 0, n * 4, (n + 1) * 4);
  }
  return raster;
}

/**
 * Build the model's structure image from a capture: depth stretched over the
 * veil's own near/far range, so the folds the wind makes read as shape instead
 * of a few grey levels inside the whole scene's range. By default that is all
 * the model sees — the cloth, not a picture painted on it. `emphasis` mixes the
 * sculpture's relief back in for a more literal figure.
 */
export function buildStructure(raster, { emphasis = 0, floor = 30 } = {}) {
  const { size, gray, value, metric } = raster;
  const near = raster.nearest, far = raster.farthest;
  const span = Math.max(1e-4, far - near);
  const scale = 255 - floor;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = y * size + x;
      if (gray[k] === 0) continue;
      const dist = metric[(size - 1 - y) * size + x];
      const depthShade = 1 - Math.min(1, Math.max(0, (dist - near) / span));
      const shade = emphasis > 0 ? depthShade * (1 - emphasis) + Math.min(1, Math.max(0, value[k])) * emphasis : depthShade;
      gray[k] = floor + Math.round(scale * shade);
    }
  }
  return gray;
}

/**
 * Box-average a gray buffer down by an integer factor (top-down rows kept).
 * Averaging only the covered samples keeps silhouette edges smooth without
 * bleeding the empty background into the surface.
 */
export function downsampleGray(src, srcSize, dst, dstSize) {
  const factor = srcSize / dstSize;
  if (!Number.isInteger(factor)) throw new Error('downsampleGray needs an integer factor');
  if (factor === 1) { dst.set(src); return dst; }
  for (let y = 0; y < dstSize; y++) {
    for (let x = 0; x < dstSize; x++) {
      let sum = 0, n = 0;
      for (let sy = 0; sy < factor; sy++) {
        const row = (y * factor + sy) * srcSize + x * factor;
        for (let sx = 0; sx < factor; sx++) {
          const v = src[row + sx];
          if (v !== 0) { sum += v; n++; }
        }
      }
      // keep a pixel empty unless the block is at least half covered
      dst[y * dstSize + x] = n * 2 >= factor * factor ? Math.round(sum / n) : 0;
    }
  }
  return dst;
}

/**
 * Quarter-turn of a square image, in array coordinates: dst(x, y) = src(y, size-1-x).
 * Works for any channel count.
 *
 * The veil is wide but a figure standing in it reads better to the model upright,
 * so the capture is turned before it is sent. Because the returned pixels are
 * stored bottom-up while the capture is top-down, the same single turn undoes it:
 * flipping vertically conjugates a quarter turn into its opposite.
 */
export function rotateQuarter(src, size, dst, channels = 1) {
  // Copy RGBA pixels as words, rather than four JS channel iterations each.
  if (channels === 4 && src.byteOffset % 4 === 0 && dst.byteOffset % 4 === 0) {
    rotateQuarter(new Uint32Array(src.buffer, src.byteOffset, size * size), size,
      new Uint32Array(dst.buffer, dst.byteOffset, size * size));
    return dst;
  }
  if (channels === 1) {
    for (let y = 0; y < size; y++) {
      let from = (size - 1) * size + y, to = y * size;
      for (let x = 0; x < size; x++, from -= size) dst[to++] = src[from];
    }
    return dst;
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = ((size - 1 - x) * size + y) * channels;
      const to = (y * size + x) * channels;
      for (let c = 0; c < channels; c++) dst[to + c] = src[from + c];
    }
  }
  return dst;
}

/** Binary request body: uint32 LE JSON length | JSON utf-8 | depth bytes. */
export function packFrame(meta, gray) {
  const header = new TextEncoder().encode(JSON.stringify(meta));
  const body = new Uint8Array(4 + header.length + gray.length);
  new DataView(body.buffer).setUint32(0, header.length, true);
  body.set(header, 4);
  body.set(gray, 4 + header.length);
  return body;
}
