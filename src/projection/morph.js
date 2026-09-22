export const isFluxModel = engine => engine === 'klein' || engine === 'flux';

export function createMorphTimeline() {
  const phases = new Map();
  return {
    advance(dt, params, active = true) {
      if (!active || !isFluxModel(params.engine) || !params.morph || !Number.isFinite(dt) || dt <= 0) return;
      phases.set(params.engine, (phases.get(params.engine) || 0) + Math.min(dt, 0.1) / Math.max(2, params.morphSeconds));
    },
    phase(params, videoTime) {
      if (!isFluxModel(params.engine) || !params.morph) return 0;
      return videoTime === undefined ? phases.get(params.engine) || 0
        : Math.max(0, videoTime) / Math.max(2, params.morphSeconds);
    },
    reset() { phases.clear(); },
  };
}

export function morphFrame(params, phase) {
  return isFluxModel(params.engine) && params.morph && params.morphAmount > 0
    ? { morph_amount: params.morphAmount, morph_phase: phase }
    : { morph_amount: 0, morph_phase: 0 };
}
