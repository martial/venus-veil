export const IMAGE_ENGINES = {
  'SDXS · live, one step': 'fast',
  'DreamShaper · 8 steps': 'fine',
  'DreamShaper · 18 steps': 'best',
  'SDXL Hyper · depth + photo': 'sdxl',
  'FLUX.2 Klein · experimental depth': 'klein',
  'FLUX.1 Depth · depth + text': 'flux',
};

export function modelLabel(engine) {
  return Object.entries(IMAGE_ENGINES).find(([, value]) => value === engine)?.[0].split(' · ')[0] || engine;
}

export function modelNote(engine, state) {
  const model = state.models?.[engine];
  if (model && !model.available) return model.reason;
  if (!state.engines.includes(engine)) return 'This model is unavailable on the connected service.';
  if (engine === 'klein') return 'Photo reference editing; depth fidelity is experimental. Slower than live.';
  if (engine === 'flux') return 'Dedicated depth + text. The photo caption is used; photo identity is not preserved.';
  if (engine === 'sdxl') return 'Dedicated depth + photo, generated at 768 px for finer detail.';
  return engine === 'fast' ? 'One-step image generation.' : 'Depth + photo conditioning.';
}
