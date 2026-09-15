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
 */
export const EMPTY_DEPTH = 1e4;

export function createDepthRaster(size) {
  return {
    size,
    gray: new Uint8Array(size * size),
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
export function rasterDepth(raster, positions, indices, m, near, far) {
  const { size, gray, metric, zbuf } = raster;
  const vertexCount = positions.length / 3;
  if (!raster.screen || raster.screen.length !== vertexCount * 4) {
    raster.screen = new Float64Array(vertexCount * 4);
    raster.clip = new Float64Array(vertexCount * 4);
  }
  const { screen, clip } = raster;
  gray.fill(0);
  metric.fill(EMPTY_DEPTH);
  zbuf.fill(Infinity);
  raster.covered = 0;
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

  const draw = (c, a, b, d) => {
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
    if (!outside(a) && !outside(b) && !outside(d)) { draw(screen, a, b, d); continue; }
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

/** Binary request body: uint32 LE JSON length | JSON utf-8 | depth bytes. */
export function packFrame(meta, gray) {
  const header = new TextEncoder().encode(JSON.stringify(meta));
  const body = new Uint8Array(4 + header.length + gray.length);
  new DataView(body.buffer).setUint32(0, header.length, true);
  body.set(header, 4);
  body.set(gray, 4 + header.length);
  return body;
}
