// Model inference controls. Scene looks, playback rate and output video quality
// are separate; changing a model must not copy another model's tuning into it.
export const MODEL_SETTING_KEYS = ['seed', 'steps', 'cfg', 'guidance', 'cnScale', 'reference', 'carry', 'negative', 'modelSize'];
export const isAdvancedModel = engine => ['sdxl', 'klein', 'flux'].includes(engine);

const common = { seed: 42, steps: 0, cfg: null, guidance: 1.1, cnScale: 0.65, reference: 1, carry: 0, negative: '', modelSize: 512 };
export const MODEL_DEFAULTS = {
  fast: { ...common, steps: 1, modelSize: 384 },
  fine: { ...common, steps: 8, cfg: 4 },
  best: { ...common, steps: 18, cfg: 4 },
  sdxl: { ...common, steps: 4, cfg: 0, cnScale: 0.7, modelSize: 768 },
  klein: { ...common, steps: 4, cfg: 1, modelSize: 768 },
  flux: { ...common, steps: 20, cfg: 10, modelSize: 768 },
};

export const MODEL_PRESETS = {
  fast: { speed: { modelSize: 256 }, balanced: { modelSize: 384 }, detail: { modelSize: 512 } },
  fine: { speed: { modelSize: 384, steps: 4 }, balanced: { modelSize: 512, steps: 8 }, detail: { modelSize: 768, steps: 12 } },
  best: { speed: { modelSize: 512, steps: 12 }, balanced: { modelSize: 512, steps: 18 }, detail: { modelSize: 768, steps: 28 } },
  sdxl: { speed: { modelSize: 512 }, balanced: { modelSize: 768 }, detail: { modelSize: 1024 } },
  klein: { speed: { modelSize: 512 }, balanced: { modelSize: 768 }, detail: { modelSize: 1024 } },
  flux: { speed: { modelSize: 512, steps: 12 }, balanced: { modelSize: 768, steps: 20 }, detail: { modelSize: 1024, steps: 30 } },
};

export function modelSettings(engine, preset = 'balanced') {
  if (!MODEL_DEFAULTS[engine] || !MODEL_PRESETS[engine][preset]) throw new Error('Unknown model or preset');
  return { ...MODEL_DEFAULTS[engine], ...MODEL_PRESETS[engine][preset] };
}

export function snapshotModelSettings(target) {
  return Object.fromEntries(MODEL_SETTING_KEYS.map(key => [key, target[key]]));
}

export function applyModelPreset(target, preset) {
  // A preset changes performance/conditioning, not the chosen random seed or text.
  const { seed, negative, ...settings } = modelSettings(target.engine, preset);
  Object.assign(target, settings);
}

export function selectedModelPreset(target) {
  for (const name of Object.keys(MODEL_PRESETS[target.engine])) {
    const { seed, negative, ...settings } = modelSettings(target.engine, name);
    if (Object.entries(settings).every(([key, value]) => target[key] === value)) return name;
  }
  return 'custom';
}

export function createModelSettingsBank(target) {
  const saved = new Map();
  return engine => {
    if (!MODEL_DEFAULTS[engine]) throw new Error(`Unknown model: ${engine}`);
    saved.set(target.engine, snapshotModelSettings(target));
    Object.assign(target, saved.get(engine) || modelSettings(engine), { engine });
  };
}

export function modelControlSpecs(engine) {
  const advanced = isAdvancedModel(engine);
  const controls = [
    { key: 'modelSize', label: advanced ? 'model resolution' : 'generated resolution', choices: advanced ? [512, 768, 1024] : [256, 384, 512, 768] },
    { key: 'seed', label: 'seed', range: [0, 999999, 1] },
  ];
  if (['fine', 'best', 'flux'].includes(engine)) controls.push({ key: 'steps', label: 'diffusion steps', range: [1, 40, 1] });
  if (['fine', 'best', 'sdxl', 'flux'].includes(engine)) controls.push({ key: 'cfg', label: 'prompt strength', range: [0, 15, 0.1] });
  if (engine === 'fast') controls.push({ key: 'guidance', label: 'edge strength', range: [0.1, 2, 0.05] });
  if (['fine', 'best', 'sdxl'].includes(engine)) controls.push({ key: 'cnScale', label: 'depth strength', range: [0.2, 1.6, 0.05] });
  if (engine === 'klein') controls.push({ key: 'reference', label: 'use uploaded photo', choices: { on: 1, off: 0 } });
  else if (engine !== 'flux') controls.push({ key: 'reference', label: 'photo strength', range: [0, 2, 0.05] });
  if (['fine', 'best'].includes(engine)) controls.push({ key: 'carry', label: 'previous frame influence', range: [0, 0.8, 0.05] });
  if (['fine', 'best', 'sdxl'].includes(engine)) controls.push({ key: 'negative', label: 'negative prompt' });
  return controls;
}

export const MODEL_SETTINGS_NOTES = {
  fast: 'One diffusion step. Resolution controls speed and detail.',
  fine: 'Fresh depth and photo per image. Keep previous frame influence at 0 to avoid losing detail in long clips.',
  best: 'More steps take longer. Keep previous frame influence at 0 to preserve the subject throughout an export.',
  sdxl: 'Four-step Hyper model. Prompt strength 0 is the default; negative prompts apply only above 1.',
  klein: 'Four-step image editing. Photo reference can be switched off; depth adherence is experimental.',
  flux: 'Native depth conditioning. The photo provides a caption, not visual identity; there is no independent depth strength.',
};
