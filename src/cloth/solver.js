/**
 * Position-based cloth for a hovering veil. Typed arrays, DOM-free.
 *
 * Per substep:
 *   1. grid normals (also used for shading)
 *   2. velocity predictor: aerodynamics (implicit normal drag, tangential drag,
 *      lift), gravity, damping
 *   3. rest-shape attachment: a weak world-space hover spring everywhere, and
 *      inside the sculpture mask a *shape-matching* pull toward the best rigid
 *      fit of the body's rest shape to its current position (Müller et al.),
 *      so the body keeps its form yet floats and tilts with the flow
 *   4. Gauss-Seidel iterations: stretch → shear → bend → relief collider → floor
 *   5. velocity post-pass for contacts (no inward velocity, friction)
 *
 * The rest shape is the base strip displaced along its normals by the relief
 * (sculpture depth). All constraint rest lengths are measured on that displaced
 * rest, so the relief never stretches the sheet: the sheet *is* the body.
 */
import { applyRelief, computeGridNormals } from './restShape.js';

export const DEFAULT_CLOTH = {
  kBase: 8,             // hover spring stiffness (1/s²) everywhere
  kRetention: 600,      // extra stiffness inside the sculpture mask
  reveal: 1,            // 0..1 ramp applied to relief amplitude + retention
  stretchCompliance: 0,
  shearCompliance: 2e-3,
  bendCompliance: 5e-3,
  iterations: 7,
  gravity: -0.15,
  damping: 0.6,         // 1/s
  kDrag: 0.9,
  kTan: 0.1,
  kLift: 0.3,
  floorY: 0.01,
  floorFriction: 0.3,
  collider: true,
  reliefSlack: 0.01,
  colliderFriction: 0.2,
  densitySmoothing: 0.15,
  densityGain: 3,
};

const STRETCH = 0, SHEAR = 1, BEND = 2;

export class ClothSolver {
  constructor(shape, params = {}) {
    this.shape = shape;
    this.columns = shape.columns;
    this.rows = shape.rows;
    this.count = shape.count;
    this.params = { ...DEFAULT_CLOTH, ...params };
    const n = this.count;
    this.pos = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.rest = new Float32Array(n * 3);
    this.nRest = new Float32Array(n * 3);
    this.nCur = new Float32Array(n * 3);
    this.invMass = new Float32Array(n).fill(1);
    this.mask = new Float32Array(n);
    this.relief = null;
    this.reliefRaw = null;
    this.amplitude = 0;
    this.density = new Float32Array(n);
    this.densityScratch = new Float32Array(n);
    this.crossRestU = new Float32Array(n);
    this.crossRestV = new Float32Array(n);
    this.collided = new Uint8Array(n);
    this.target = new Float32Array(n * 3);     // shape-matched rest positions (masked particles)
    this.nTarget = new Float32Array(n * 3);    // rotated rest normals
    this.rotation = [1, 0, 0, 0, 1, 0, 0, 0, 1]; // row-major 3x3, warm-started every step
    this.restCentroid = [0, 0, 0];
    this.maskWeight = 0;
    this.time = 0;
    this.windScratch = [0, 0, 0];
    this.buildConstraints();
    this.rebuildRest();
    this.reset();
  }

  buildConstraints() {
    const { columns, rows } = this;
    const rowLength = columns + 1;
    const a = [], b = [], type = [];
    const add = (i, j, t) => { a.push(i); b.push(j); type.push(t); };
    for (let y = 0; y <= rows; y++) {
      for (let x = 0; x <= columns; x++) {
        const i = y * rowLength + x;
        if (x < columns) add(i, i + 1, STRETCH);
        if (y < rows) add(i, i + rowLength, STRETCH);
      }
    }
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const i = y * rowLength + x;
        add(i, i + rowLength + 1, SHEAR);
        add(i + 1, i + rowLength, SHEAR);
      }
    }
    for (let y = 0; y <= rows; y++) {
      for (let x = 0; x <= columns; x++) {
        const i = y * rowLength + x;
        if (x < columns - 1) add(i, i + 2, BEND);
        if (y < rows - 1) add(i, i + 2 * rowLength, BEND);
      }
    }
    this.cA = Int32Array.from(a);
    this.cB = Int32Array.from(b);
    this.cType = Uint8Array.from(type);
    this.cL = new Float32Array(a.length);
    this.constraintCount = a.length;
  }

  /** Recompute rest positions, rest normals and all rest lengths. Does not move particles. */
  rebuildRest() {
    const { rest, nRest, cA, cB, cL, columns, rows } = this;
    const amp = this.amplitude * this.params.reveal;
    applyRelief(this.shape, this.relief, amp, rest);
    computeGridNormals(rest, columns, rows, nRest);
    for (let k = 0; k < this.constraintCount; k++) {
      const i = cA[k] * 3, j = cB[k] * 3;
      cL[k] = Math.hypot(rest[j] - rest[i], rest[j + 1] - rest[i + 1], rest[j + 2] - rest[i + 2]);
    }
    // weighted rest centroid of the masked cluster (for shape matching)
    let wsum = 0, cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < this.count; i++) {
      const w = this.mask[i];
      if (w <= 0) continue;
      wsum += w; cx += w * rest[i * 3]; cy += w * rest[i * 3 + 1]; cz += w * rest[i * 3 + 2];
    }
    this.maskWeight = wsum;
    if (wsum > 0) { this.restCentroid[0] = cx / wsum; this.restCentroid[1] = cy / wsum; this.restCentroid[2] = cz / wsum; }
    this.target.set(rest);
    this.nTarget.set(nRest);
    const rowLength = columns + 1;
    for (let y = 0; y <= rows; y++) {
      for (let x = 0; x <= columns; x++) {
        const i = y * rowLength + x;
        const xa = Math.max(0, x - 1), xb = Math.min(columns, x + 1);
        const ya = Math.max(0, y - 1), yb = Math.min(rows, y + 1);
        const a = (y * rowLength + xa) * 3, b = (y * rowLength + xb) * 3;
        const c = (ya * rowLength + x) * 3, d = (yb * rowLength + x) * 3;
        this.crossRestU[i] = Math.hypot(rest[b] - rest[a], rest[b + 1] - rest[a + 1], rest[b + 2] - rest[a + 2]) || 1;
        this.crossRestV[i] = Math.hypot(rest[d] - rest[c], rest[d + 1] - rest[c + 1], rest[d + 2] - rest[c + 2]) || 1;
      }
    }
  }

  /**
   * depthGrid: Float32Array(count) in 0..1 or null; mask: Float32Array(count) in 0..1 or null.
   * amplitude: world-unit displacement for depth = 1.
   */
  setRelief(depthGrid, mask, amplitude) {
    this.relief = depthGrid ? Float32Array.from(depthGrid, v => Math.min(1, Math.max(0, v))) : null;
    if (mask) this.mask.set(mask); else this.mask.fill(0);
    this.amplitude = amplitude;
    this.rebuildRest();
  }

  setAmplitude(amplitude) {
    this.amplitude = amplitude;
    this.rebuildRest();
  }

  /** Call after changing params.reveal so the relief follows the ramp. */
  refreshReveal() { this.rebuildRest(); }

  clearRelief() { this.setRelief(null, null, 0); }

  reset() {
    this.rotation = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    this.pos.set(this.rest);
    this.prev.set(this.rest);
    this.density.fill(0);
    this.collided.fill(0);
    this.time = 0;
  }

  /** Axis-aligned bounds of the rest shape (for the wind lattice). */
  bounds() {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const r = this.rest;
    for (let i = 0; i < r.length; i += 3) {
      for (let c = 0; c < 3; c++) { if (r[i + c] < min[c]) min[c] = r[i + c]; if (r[i + c] > max[c]) max[c] = r[i + c]; }
    }
    return { min, max };
  }

  /**
   * Advance one fixed substep. windSampler(x, y, z, out) writes the wind
   * velocity at a point (may be null for still air).
   */
  step(dt, windSampler = null) {
    if (!Number.isFinite(dt) || dt <= 0 || dt > 1 / 30) throw new Error('ClothSolver.step needs a small fixed timestep');
    const P = this.params;
    const { pos, prev, rest, nRest, nCur, invMass, mask, count, columns, rows } = this;
    const w = this.windScratch;

    computeGridNormals(pos, columns, rows, nCur);

    // 2. predictor
    const damp = Math.exp(-P.damping * dt);
    const gy = P.gravity * dt;
    for (let i = 0; i < count; i++) {
      const k = i * 3;
      if (invMass[i] === 0) { prev[k] = pos[k]; prev[k + 1] = pos[k + 1]; prev[k + 2] = pos[k + 2]; continue; }
      let vx = (pos[k] - prev[k]) / dt, vy = (pos[k + 1] - prev[k + 1]) / dt, vz = (pos[k + 2] - prev[k + 2]) / dt;
      if (windSampler) {
        windSampler(pos[k], pos[k + 1], pos[k + 2], w);
        const rx = w[0] - vx, ry = w[1] - vy, rz = w[2] - vz;
        const speed = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (speed > 1e-9) {
          const nx = nCur[k], ny = nCur[k + 1], nz = nCur[k + 2];
          const rn = rx * nx + ry * ny + rz * nz;
          // implicit normal drag: move the normal velocity toward the wind's, never past it
          const s = Math.min(1, P.kDrag * speed * dt);
          vx += s * rn * nx; vy += s * rn * ny; vz += s * rn * nz;
          // tangential (skin) drag
          const tk = Math.min(1, P.kTan * speed * dt);
          vx += tk * (rx - rn * nx); vy += tk * (ry - rn * ny); vz += tk * (rz - rn * nz);
          // lift: proportional to sin(aoa) * cos(aoa) * speed², perpendicular to the flow
          if (P.kLift > 0) {
            const ux = rx / speed, uy = ry / speed, uz = rz / speed;
            const nu = nx * ux + ny * uy + nz * uz;
            const lx = nx - nu * ux, ly = ny - nu * uy, lz = nz - nu * uz;
            const lift = P.kLift * speed * speed * nu * dt;
            vx += lift * lx; vy += lift * ly; vz += lift * lz;
          }
        }
      }
      vx *= damp; vy *= damp; vz *= damp;
      vy += gy;
      prev[k] = pos[k]; prev[k + 1] = pos[k + 1]; prev[k + 2] = pos[k + 2];
      pos[k] += vx * dt; pos[k + 1] += vy * dt; pos[k + 2] += vz * dt;
    }

    // 3a. weak world-space hover spring everywhere (implicit, unconditionally stable)
    const dt2 = dt * dt;
    const kBase = P.kBase, kRet = P.kRetention * P.reveal;
    if (kBase > 0) {
      const s = kBase * dt2 / (1 + kBase * dt2);
      for (let i = 0; i < count; i++) {
        if (invMass[i] === 0) continue;
        const k = i * 3;
        pos[k] += s * (rest[k] - pos[k]);
        pos[k + 1] += s * (rest[k + 1] - pos[k + 1]);
        pos[k + 2] += s * (rest[k + 2] - pos[k + 2]);
      }
    }
    // 3b. shape matching of the sculpture cluster: rigid fit of the rest body to
    //     its current placement, then a mask-weighted pull toward that fit
    const { target, nTarget } = this;
    const shaped = this.relief !== null && this.maskWeight > 0 && P.reveal > 0;
    if (shaped) {
      this.updateShapeTarget();
      if (kRet > 0) {
        for (let i = 0; i < count; i++) {
          const w = mask[i];
          if (w <= 0 || invMass[i] === 0) continue;
          const kk = kRet * w;
          const s = kk * dt2 / (1 + kk * dt2);
          const k = i * 3;
          pos[k] += s * (target[k] - pos[k]);
          pos[k + 1] += s * (target[k + 1] - pos[k + 1]);
          pos[k + 2] += s * (target[k + 2] - pos[k + 2]);
        }
      }
    }

    // 4. constraints
    const { cA, cB, cType, cL, constraintCount } = this;
    const alphaTilde = [P.stretchCompliance / dt2, P.shearCompliance / dt2, P.bendCompliance / dt2];
    const collided = this.collided;
    collided.fill(0);
    const useCollider = P.collider && shaped && this.amplitude * P.reveal > 0;
    const slack = P.reliefSlack;
    const floorY = P.floorY;
    for (let it = 0; it < P.iterations; it++) {
      const reverse = (it & 1) === 1;
      for (let n = 0; n < constraintCount; n++) {
        const c = reverse ? constraintCount - 1 - n : n;
        const ia = cA[c], ib = cB[c];
        const wa = invMass[ia], wb = invMass[ib];
        const wsum = wa + wb;
        if (wsum === 0) continue;
        const a = ia * 3, b = ib * 3;
        const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-9) continue;
        const C = len - cL[c];
        const s = C / ((wsum + alphaTilde[cType[c]]) * len);
        const cx = dx * s, cy = dy * s, cz = dz * s;
        pos[a] += cx * wa; pos[a + 1] += cy * wa; pos[a + 2] += cz * wa;
        pos[b] -= cx * wb; pos[b + 1] -= cy * wb; pos[b + 2] -= cz * wb;
      }
      if (useCollider) {
        for (let i = 0; i < count; i++) {
          if (invMass[i] === 0 || mask[i] <= 0) continue;
          const k = i * 3;
          const d = (pos[k] - target[k]) * nTarget[k] + (pos[k + 1] - target[k + 1]) * nTarget[k + 1] + (pos[k + 2] - target[k + 2]) * nTarget[k + 2];
          if (d < -slack) {
            const push = d + slack;
            pos[k] -= nTarget[k] * push; pos[k + 1] -= nTarget[k + 1] * push; pos[k + 2] -= nTarget[k + 2] * push;
            collided[i] = 1;
          }
        }
      }
      for (let i = 0; i < count; i++) {
        const k = i * 3 + 1;
        if (pos[k] < floorY) { pos[k] = floorY; collided[i] |= 2; }
      }
    }

    // 5. contact velocity post-pass
    const muR = P.colliderFriction, muF = P.floorFriction;
    for (let i = 0; i < count; i++) {
      const flags = collided[i];
      if (!flags) continue;
      const k = i * 3;
      let vx = (pos[k] - prev[k]) / dt, vy = (pos[k + 1] - prev[k + 1]) / dt, vz = (pos[k + 2] - prev[k + 2]) / dt;
      if (flags & 1) {
        const nx = nTarget[k], ny = nTarget[k + 1], nz = nTarget[k + 2];
        const vn = vx * nx + vy * ny + vz * nz;
        if (vn < 0) { vx -= vn * nx; vy -= vn * ny; vz -= vn * nz; }
        const f = 1 - muR;
        const vn2 = vx * nx + vy * ny + vz * nz;
        vx = vn2 * nx + (vx - vn2 * nx) * f; vy = vn2 * ny + (vy - vn2 * ny) * f; vz = vn2 * nz + (vz - vn2 * nz) * f;
      }
      if (flags & 2) {
        if (vy < 0) vy = 0;
        vx *= 1 - muF; vz *= 1 - muF;
      }
      prev[k] = pos[k] - vx * dt; prev[k + 1] = pos[k + 1] - vy * dt; prev[k + 2] = pos[k + 2] - vz * dt;
    }

    this.time += dt;
  }

  /**
   * Shape matching: best rigid transform (R, c) of the masked rest cluster onto
   * its current positions. Rotation extracted with the robust iterative method of
   * Müller et al. 2016, warm-started from the previous step. Writes target/nTarget.
   */
  updateShapeTarget() {
    const { pos, rest, nRest, mask, count, target, nTarget } = this;
    const q0 = this.restCentroid;
    let wsum = 0, cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < count; i++) {
      const w = mask[i];
      if (w <= 0) continue;
      const k = i * 3;
      wsum += w; cx += w * pos[k]; cy += w * pos[k + 1]; cz += w * pos[k + 2];
    }
    if (wsum <= 0) return;
    cx /= wsum; cy /= wsum; cz /= wsum;
    // A = sum w (p - c) (q - q0)^T
    let a00 = 0, a01 = 0, a02 = 0, a10 = 0, a11 = 0, a12 = 0, a20 = 0, a21 = 0, a22 = 0;
    for (let i = 0; i < count; i++) {
      const w = mask[i];
      if (w <= 0) continue;
      const k = i * 3;
      const px = pos[k] - cx, py = pos[k + 1] - cy, pz = pos[k + 2] - cz;
      const qx = rest[k] - q0[0], qy = rest[k + 1] - q0[1], qz = rest[k + 2] - q0[2];
      a00 += w * px * qx; a01 += w * px * qy; a02 += w * px * qz;
      a10 += w * py * qx; a11 += w * py * qy; a12 += w * py * qz;
      a20 += w * pz * qx; a21 += w * pz * qy; a22 += w * pz * qz;
    }
    const R = this.rotation;
    for (let iter = 0; iter < 8; iter++) {
      // columns of R and A
      let ox = 0, oy = 0, oz = 0, denom = 0;
      for (let c = 0; c < 3; c++) {
        const rx = R[c], ry = R[3 + c], rz = R[6 + c];
        const ax = c === 0 ? a00 : c === 1 ? a01 : a02;
        const ay = c === 0 ? a10 : c === 1 ? a11 : a12;
        const az = c === 0 ? a20 : c === 1 ? a21 : a22;
        ox += ry * az - rz * ay; oy += rz * ax - rx * az; oz += rx * ay - ry * ax;
        denom += rx * ax + ry * ay + rz * az;
      }
      const inv = 1 / (Math.abs(denom) + 1e-9);
      ox *= inv; oy *= inv; oz *= inv;
      const ang = Math.sqrt(ox * ox + oy * oy + oz * oz);
      if (ang < 1e-6) break;
      // R = Rot(axis, ang) * R  (Rodrigues)
      const ux = ox / ang, uy = oy / ang, uz = oz / ang;
      const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
      const m00 = t * ux * ux + c, m01 = t * ux * uy - s * uz, m02 = t * ux * uz + s * uy;
      const m10 = t * ux * uy + s * uz, m11 = t * uy * uy + c, m12 = t * uy * uz - s * ux;
      const m20 = t * ux * uz - s * uy, m21 = t * uy * uz + s * ux, m22 = t * uz * uz + c;
      const r00 = R[0], r01 = R[1], r02 = R[2], r10 = R[3], r11 = R[4], r12 = R[5], r20 = R[6], r21 = R[7], r22 = R[8];
      R[0] = m00 * r00 + m01 * r10 + m02 * r20; R[1] = m00 * r01 + m01 * r11 + m02 * r21; R[2] = m00 * r02 + m01 * r12 + m02 * r22;
      R[3] = m10 * r00 + m11 * r10 + m12 * r20; R[4] = m10 * r01 + m11 * r11 + m12 * r21; R[5] = m10 * r02 + m11 * r12 + m12 * r22;
      R[6] = m20 * r00 + m21 * r10 + m22 * r20; R[7] = m20 * r01 + m21 * r11 + m22 * r21; R[8] = m20 * r02 + m21 * r12 + m22 * r22;
    }
    for (let i = 0; i < count; i++) {
      if (mask[i] <= 0) continue;
      const k = i * 3;
      const qx = rest[k] - q0[0], qy = rest[k + 1] - q0[1], qz = rest[k + 2] - q0[2];
      target[k] = R[0] * qx + R[1] * qy + R[2] * qz + cx;
      target[k + 1] = R[3] * qx + R[4] * qy + R[5] * qz + cy;
      target[k + 2] = R[6] * qx + R[7] * qy + R[8] * qz + cz;
      const nx = nRest[k], ny = nRest[k + 1], nz = nRest[k + 2];
      nTarget[k] = R[0] * nx + R[1] * ny + R[2] * nz;
      nTarget[k + 1] = R[3] * nx + R[4] * ny + R[5] * nz;
      nTarget[k + 2] = R[6] * nx + R[7] * ny + R[8] * nz;
    }
  }

  /** Fold compression 0..1 per particle for shading; smoothed in time and space. */
  updateDensity() {
    const { pos, columns, rows, count, crossRestU, crossRestV, density, densityScratch } = this;
    const P = this.params;
    const rowLength = columns + 1;
    const ema = P.densitySmoothing, gain = P.densityGain;
    for (let y = 0; y <= rows; y++) {
      const ya = Math.max(0, y - 1), yb = Math.min(rows, y + 1);
      for (let x = 0; x <= columns; x++) {
        const i = y * rowLength + x;
        const xa = Math.max(0, x - 1), xb = Math.min(columns, x + 1);
        const a = (y * rowLength + xa) * 3, b = (y * rowLength + xb) * 3;
        const c = (ya * rowLength + x) * 3, d = (yb * rowLength + x) * 3;
        const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
        const vx = pos[d] - pos[c], vy = pos[d + 1] - pos[c + 1], vz = pos[d + 2] - pos[c + 2];
        const lu = Math.sqrt(ux * ux + uy * uy + uz * uz) / crossRestU[i];
        const lv = Math.sqrt(vx * vx + vy * vy + vz * vz) / crossRestV[i];
        const raw = Math.min(1, Math.max(0, (1 - 0.5 * (lu + lv)) * gain));
        densityScratch[i] = raw;
      }
    }
    // 3x3 box blur + temporal EMA
    for (let y = 0; y <= rows; y++) {
      for (let x = 0; x <= columns; x++) {
        let sum = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy > rows) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx > columns) continue;
            sum += densityScratch[yy * rowLength + xx]; n++;
          }
        }
        const i = y * rowLength + x;
        density[i] += (sum / n - density[i]) * ema;
      }
    }
    return density;
  }

  /** Max relative strain over stretch constraints (diagnostics / tests). */
  maxStretchStrain() {
    const { pos, cA, cB, cType, cL, constraintCount } = this;
    let worst = 0;
    for (let c = 0; c < constraintCount; c++) {
      if (cType[c] !== STRETCH) continue;
      const a = cA[c] * 3, b = cB[c] * 3;
      const len = Math.hypot(pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]);
      const strain = Math.abs(len - cL[c]) / cL[c];
      if (strain > worst) worst = strain;
    }
    return worst;
  }

  kineticEnergy(dt) {
    const { pos, prev, count } = this;
    let e = 0;
    for (let i = 0; i < count * 3; i += 3) {
      const vx = (pos[i] - prev[i]) / dt, vy = (pos[i + 1] - prev[i + 1]) / dt, vz = (pos[i + 2] - prev[i + 2]) / dt;
      e += vx * vx + vy * vy + vz * vz;
    }
    return 0.5 * e;
  }
}
