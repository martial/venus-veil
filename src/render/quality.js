/**
 * Frame-rate budget. Measures the real frame time and trades resolution, then
 * scene extras, to stay above `floor` frames per second. Pure bookkeeping: it
 * reports what to change, the caller applies it.
 *
 * Ladder (applied in order, resolution first because it is the biggest lever):
 *   level 0  full beam, reflection every frame, shadows every frame, 4× MSAA
 *   level 1  shorter beam, reflection every 2nd frame, shadows every 2nd, 2× MSAA
 *   level 2  short beam, reflection every 3rd frame, shadows every 3rd, no MSAA
 */
export const LEVELS = [
  { beamSteps: 32, mirrorInterval: 1, shadowInterval: 1, samples: 4, liveInterval: 1 },
  { beamSteps: 20, mirrorInterval: 2, shadowInterval: 2, samples: 2, liveInterval: 2 },
  { beamSteps: 14, mirrorInterval: 3, shadowInterval: 3, samples: 0, liveInterval: 3 },
];

export function createQuality({ maxScale = 1, floor = 24, target = 50, minScale = 0.55, window: windowFrames = 24 } = {}) {
  const params = { auto: true, floor, target, scale: maxScale, level: 0, maxScale, minScale, frameMs: 0 };
  let ema = 1000 / 60;
  let frames = 0;
  let cooldown = 0;

  /** Feed one frame time (ms). Returns true when the caller should re-apply settings. */
  function sample(ms) {
    if (!Number.isFinite(ms) || ms <= 0 || ms > 500) return false;
    ema = ema * 0.9 + ms * 0.1;
    params.frameMs = +ema.toFixed(2);
    if (!params.auto) return false;
    if (cooldown > 0) { cooldown--; return false; }
    if (++frames < windowFrames) return false;
    frames = 0;
    const fps = 1000 / ema;
    if (fps < params.floor) {
      if (params.scale > params.minScale + 1e-3) {
        params.scale = Math.max(params.minScale, params.scale * 0.85);
      } else if (params.level < LEVELS.length - 1) {
        params.level++;
      } else return false;
      cooldown = windowFrames;
      return true;
    }
    // A 60 Hz display cannot report 75 fps: recover when it holds the target.
    if (fps > params.target * 0.97) {
      if (params.level > 0) params.level--;
      else if (params.scale < params.maxScale - 1e-3) params.scale = Math.min(params.maxScale, params.scale * 1.08);
      else return false;
      cooldown = windowFrames * 2;
      return true;
    }
    return false;
  }

  return {
    params,
    sample,
    get settings() { return { ...LEVELS[params.level], scale: params.scale }; },
    get fps() { return 1000 / ema; },
    reset(scale = params.maxScale, level = 0) { params.scale = scale; params.level = level; ema = 1000 / 60; frames = 0; cooldown = 0; },
  };
}
