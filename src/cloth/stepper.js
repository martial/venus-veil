/**
 * Fixed-timestep accumulator. advance(frameDt) returns the number of
 * substeps to run this frame (capped so a hitch can't spiral), carrying
 * the remainder to the next frame.
 */
export function createStepper({ dt = 1 / 120, maxSubsteps = 4, maxFrameDt = 1 / 15 } = {}) {
  let accumulator = 0;
  return {
    dt,
    get accumulator() { return accumulator; },
    advance(frameDt) {
      if (!Number.isFinite(frameDt) || frameDt <= 0) return 0;
      accumulator += Math.min(frameDt, maxFrameDt);
      let steps = Math.floor(accumulator / dt);
      if (steps > maxSubsteps) { steps = maxSubsteps; accumulator = dt * maxSubsteps; }
      accumulator -= steps * dt;
      return steps;
    },
    reset() { accumulator = 0; },
  };
}
