/**
 * Wind field: base flow × gust envelope + curl-noise turbulence + pointer wand.
 * Turbulence is the curl of a 3-component simplex potential, so it is
 * divergence-free by construction (eddies, no sources/sinks).
 *
 * The field is evaluated once per frame on a coarse lattice over the veil's
 * bounding box; particles sample it by trilinear interpolation. DOM-free.
 */
import { createNoise3D, createNoise4D } from 'simplex-noise';
import alea from 'alea';

export const DEFAULT_WIND = {
  speed: 2.2,
  direction: [1, 0.17, 0.1],
  gustAmp: 0.6,
  gustFreq: 0.2,
  turbulence: 2.5,
  turbScale: 1.0,
  turbSpeed: 0.25,
  wandStrength: 6,
  wandRadius: 1.2,
  wandDecay: 4,
  curlEps: 0.002,     // finite-difference step in noise space (smaller = more divergence-free)
};

export function createWind(options = {}, seed = 'venus') {
  const params = { ...DEFAULT_WIND, ...options, direction: [...(options.direction || DEFAULT_WIND.direction)] };
  const n3 = createNoise3D(alea(seed + ':gust'));
  const nA = createNoise4D(alea(seed + ':a'));
  const nB = createNoise4D(alea(seed + ':b'));
  const nC = createNoise4D(alea(seed + ':c'));

  const lattice = {
    nx: 24, ny: 12, nz: 6,
    min: [-3.5, -0.5, -2.5], max: [3.5, 4.5, 2.5],
    data: null,
  };
  lattice.data = new Float32Array(lattice.nx * lattice.ny * lattice.nz * 3);

  const wand = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  let gustValue = 1;
  let time = 0;

  function gust(t) {
    return 1 + params.gustAmp * (0.5 + 0.5 * n3(t * params.gustFreq, 7.3, 0));
  }

  /** Curl of the potential (nA, nB, nC) at (x, y, z, t). */
  function curl(x, y, z, t, out = [0, 0, 0]) {
    const s = params.turbScale, eps = params.curlEps;
    const X = x * s, Y = y * s, Z = z * s, T = t * params.turbSpeed;
    const inv = 1 / (2 * eps);
    const dAdy = (nA(X, Y + eps, Z, T) - nA(X, Y - eps, Z, T)) * inv;
    const dAdz = (nA(X, Y, Z + eps, T) - nA(X, Y, Z - eps, T)) * inv;
    const dBdx = (nB(X + eps, Y, Z, T) - nB(X - eps, Y, Z, T)) * inv;
    const dBdz = (nB(X, Y, Z + eps, T) - nB(X, Y, Z - eps, T)) * inv;
    const dCdx = (nC(X + eps, Y, Z, T) - nC(X - eps, Y, Z, T)) * inv;
    const dCdy = (nC(X, Y + eps, Z, T) - nC(X, Y - eps, Z, T)) * inv;
    out[0] = dCdy - dBdz;
    out[1] = dAdz - dCdx;
    out[2] = dBdx - dAdy;
    return out;
  }

  function baseVector(out = [0, 0, 0]) {
    const [dx, dy, dz] = params.direction;
    const l = Math.hypot(dx, dy, dz) || 1;
    const m = params.speed * gustValue;
    out[0] = dx / l * m; out[1] = dy / l * m; out[2] = dz / l * m;
    return out;
  }

  function setBounds(min, max, margin = 1) {
    lattice.min = [min[0] - margin, min[1] - margin, min[2] - margin];
    lattice.max = [max[0] + margin, max[1] + margin, max[2] + margin];
  }

  const tmpCurl = [0, 0, 0], tmpBase = [0, 0, 0];

  /** Re-evaluate the lattice for time t; dt is used to decay the wand. */
  function update(t, dt = 0) {
    time = t;
    gustValue = gust(t);
    baseVector(tmpBase);
    const { nx, ny, nz, min, max, data } = lattice;
    const turb = params.turbulence;
    let k = 0;
    for (let iz = 0; iz < nz; iz++) {
      const z = min[2] + (max[2] - min[2]) * iz / (nz - 1);
      for (let iy = 0; iy < ny; iy++) {
        const y = min[1] + (max[1] - min[1]) * iy / (ny - 1);
        for (let ix = 0; ix < nx; ix++) {
          const x = min[0] + (max[0] - min[0]) * ix / (nx - 1);
          if (turb > 0) curl(x, y, z, t, tmpCurl); else { tmpCurl[0] = tmpCurl[1] = tmpCurl[2] = 0; }
          data[k++] = tmpBase[0] + turb * tmpCurl[0];
          data[k++] = tmpBase[1] + turb * tmpCurl[1];
          data[k++] = tmpBase[2] + turb * tmpCurl[2];
        }
      }
    }
    if (dt > 0) {
      const decay = Math.exp(-params.wandDecay * dt);
      wand.vx *= decay; wand.vy *= decay; wand.vz *= decay;
    }
  }

  /** Trilinear sample of the lattice plus the wand's local push. */
  function sampleAt(x, y, z, out) {
    const { nx, ny, nz, min, max, data } = lattice;
    let fx = (x - min[0]) / (max[0] - min[0]) * (nx - 1);
    let fy = (y - min[1]) / (max[1] - min[1]) * (ny - 1);
    let fz = (z - min[2]) / (max[2] - min[2]) * (nz - 1);
    fx = Math.min(nx - 1.000001, Math.max(0, fx));
    fy = Math.min(ny - 1.000001, Math.max(0, fy));
    fz = Math.min(nz - 1.000001, Math.max(0, fz));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
    const tx = fx - x0, ty = fy - y0, tz = fz - z0;
    const sx = 3, sy = nx * 3, sz = nx * ny * 3;
    const b = x0 * sx + y0 * sy + z0 * sz;
    for (let c = 0; c < 3; c++) {
      const c000 = data[b + c], c100 = data[b + sx + c];
      const c010 = data[b + sy + c], c110 = data[b + sx + sy + c];
      const c001 = data[b + sz + c], c101 = data[b + sx + sz + c];
      const c011 = data[b + sy + sz + c], c111 = data[b + sx + sy + sz + c];
      const c00 = c000 + (c100 - c000) * tx, c10 = c010 + (c110 - c010) * tx;
      const c01 = c001 + (c101 - c001) * tx, c11 = c011 + (c111 - c011) * tx;
      const c0 = c00 + (c10 - c00) * ty, c1 = c01 + (c11 - c01) * ty;
      out[c] = c0 + (c1 - c0) * tz;
    }
    const wv = wand.vx * wand.vx + wand.vy * wand.vy + wand.vz * wand.vz;
    if (wv > 1e-8) {
      const dx = x - wand.x, dy = y - wand.y, dz = z - wand.z;
      const r2 = params.wandRadius * params.wandRadius;
      const f = params.wandStrength * Math.exp(-(dx * dx + dy * dy + dz * dz) / r2);
      out[0] += wand.vx * f; out[1] += wand.vy * f; out[2] += wand.vz * f;
    }
    return out;
  }

  function setWand(x, y, z, vx, vy, vz) {
    wand.x = x; wand.y = y; wand.z = z;
    wand.vx = vx; wand.vy = vy; wand.vz = vz;
  }

  function clearWand() { wand.vx = wand.vy = wand.vz = 0; }

  return {
    params, lattice, wand,
    gust, curl, baseVector, update, sampleAt, setBounds, setWand, clearWand,
    get gustValue() { return gustValue; },
    get time() { return time; },
  };
}
