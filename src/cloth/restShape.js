/**
 * Rest shape of the veil: a rising, gently twisted S-curve strip.
 * Pure math, DOM-free, so it can be unit-tested with node --test.
 *
 * Grid convention: u (0..1) runs along the ribbon length (columns, +x),
 * v (0..1) runs across it (rows, upward at zero twist). Particle index
 * i = y * (columns + 1) + x. Front face normal is cross(du, dv), i.e. +z for
 * a flat vertical sheet facing the camera.
 */

export const DEFAULT_SHAPE = {
  width: 5,
  height: 2,
  columns: 96,
  rows: 40,
  lift: 1.9,      // height of the spine centre above the floor
  rise: 1.6,      // total vertical rise from left to right
  sway: 0.35,     // S-curve amplitude (y)
  bow: 0.6,       // depth bow (z)
  twist: 0.9,     // total twist in radians across the length
};

export function spine(u, s = DEFAULT_SHAPE, out = [0, 0, 0]) {
  out[0] = (u - 0.5) * s.width;
  out[1] = s.lift + s.rise * (u - 0.5) + s.sway * Math.sin(1.5 * Math.PI * u);
  out[2] = s.bow * Math.sin(Math.PI * u);
  return out;
}

/** Position of the strip at (u, v). */
export function ribbonPoint(u, v, s = DEFAULT_SHAPE, out = [0, 0, 0]) {
  const eps = 1e-3;
  const p = spine(u, s);
  const p0 = spine(Math.max(0, u - eps), s, [0, 0, 0]);
  const p1 = spine(Math.min(1, u + eps), s, [0, 0, 0]);
  // tangent
  let tx = p1[0] - p0[0], ty = p1[1] - p0[1], tz = p1[2] - p0[2];
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx /= tl; ty /= tl; tz /= tl;
  // binormal: world up made orthogonal to the tangent (no Frenet flips)
  let bx = -tx * ty, by = 1 - ty * ty, bz = -tz * ty;
  const bl = Math.hypot(bx, by, bz) || 1;
  bx /= bl; by /= bl; bz /= bl;
  // normal = T x B
  const nx = ty * bz - tz * by, ny = tz * bx - tx * bz, nz = tx * by - ty * bx;
  // twist the binormal around the tangent
  const th = s.twist * (u - 0.5);
  const c = Math.cos(th), sn = Math.sin(th);
  const rx = bx * c + nx * sn, ry = by * c + ny * sn, rz = bz * c + nz * sn;
  const h = (v - 0.5) * s.height;
  out[0] = p[0] + rx * h;
  out[1] = p[1] + ry * h;
  out[2] = p[2] + rz * h;
  return out;
}

/**
 * Grid normals by central differences: n = normalize(cross(du, dv)).
 * One-sided differences at the borders. Writes into `out` (count*3).
 */
export function computeGridNormals(positions, columns, rows, out) {
  const rowLength = columns + 1;
  for (let y = 0; y <= rows; y++) {
    const y0 = Math.max(0, y - 1), y1 = Math.min(rows, y + 1);
    for (let x = 0; x <= columns; x++) {
      const x0 = Math.max(0, x - 1), x1 = Math.min(columns, x + 1);
      const a = (y * rowLength + x0) * 3, b = (y * rowLength + x1) * 3;
      const c = (y0 * rowLength + x) * 3, d = (y1 * rowLength + x) * 3;
      const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
      const vx = positions[d] - positions[c], vy = positions[d + 1] - positions[c + 1], vz = positions[d + 2] - positions[c + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (l > 1e-12) { nx /= l; ny /= l; nz /= l; } else { nx = 0; ny = 0; nz = 1; }
      const k = (y * rowLength + x) * 3;
      out[k] = nx; out[k + 1] = ny; out[k + 2] = nz;
    }
  }
  return out;
}

/**
 * Builds the base grid: positions, normals and uvs for the rest strip.
 */
export function createRestShape(options = {}) {
  const s = { ...DEFAULT_SHAPE, ...options };
  const { columns, rows } = s;
  const count = (columns + 1) * (rows + 1);
  const base = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const tmp = [0, 0, 0];
  for (let y = 0; y <= rows; y++) {
    for (let x = 0; x <= columns; x++) {
      const i = y * (columns + 1) + x;
      const u = x / columns, v = y / rows;
      ribbonPoint(u, v, s, tmp);
      base[i * 3] = tmp[0]; base[i * 3 + 1] = tmp[1]; base[i * 3 + 2] = tmp[2];
      uv[i * 2] = u; uv[i * 2 + 1] = v;
    }
  }
  const nBase = computeGridNormals(base, columns, rows, new Float32Array(count * 3));
  return { ...s, count, base, nBase, uv };
}

/**
 * Displaces the base grid along its normals by depth * amplitude.
 * depthGrid: Float32Array(count) in 0..1 (1 = nearest / most raised), or null.
 * Writes the relief rest positions into `out` and returns it.
 */
export function applyRelief(shape, depthGrid, amplitude, out) {
  const { base, nBase, count } = shape;
  out.set(base);
  if (!depthGrid || amplitude === 0) return out;
  for (let i = 0; i < count; i++) {
    const d = depthGrid[i] * amplitude;
    if (d === 0) continue;
    const k = i * 3;
    out[k] += nBase[k] * d;
    out[k + 1] += nBase[k + 1] * d;
    out[k + 2] += nBase[k + 2] * d;
  }
  return out;
}

/** Separable gaussian-ish blur (3 box passes) over a grid array, in place via a scratch buffer. */
export function blurGrid(values, columns, rows, radius, scratch) {
  const rowLength = columns + 1, rowCount = rows + 1;
  const tmp = scratch || new Float32Array(values.length);
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return values;
  for (let pass = 0; pass < 3; pass++) {
    // horizontal
    for (let y = 0; y < rowCount; y++) {
      for (let x = 0; x < rowLength; x++) {
        let sum = 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const xx = x + k;
          if (xx < 0 || xx >= rowLength) continue;
          sum += values[y * rowLength + xx]; n++;
        }
        tmp[y * rowLength + x] = sum / n;
      }
    }
    // vertical
    for (let y = 0; y < rowCount; y++) {
      for (let x = 0; x < rowLength; x++) {
        let sum = 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const yy = y + k;
          if (yy < 0 || yy >= rowCount) continue;
          sum += tmp[yy * rowLength + x]; n++;
        }
        values[y * rowLength + x] = sum / n;
      }
    }
  }
  return values;
}
