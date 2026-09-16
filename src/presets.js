/**
 * Five looks. Each is a plain description of every part of the studio, applied
 * onto the live parameter objects; nothing here touches the DOM, so the set can
 * be unit-tested and extended by hand.
 */

export const PRESETS = {
  veil: {
    label: 'Veil',
    note: 'sheer organza turning in quiet air',
    wind: { speed: 2.2, gustAmp: 0.6, gustFreq: 0.2, turbulence: 2.5, turbScale: 1.0 },
    cloth: { kBase: 8, bendCompliance: 5e-3, shearCompliance: 2e-3, damping: 0.6, kLift: 0.3, gravity: -0.15 },
    material: { opacity: 0.16, roughness: 0.5, sheen: 1, sheenRoughness: 0.6, iridescence: 0.12, color: '#e2ded6' },
    uniforms: { uFresnelAlpha: 1.0, uFresnelPower: 2.2, uDensityGain: 2.5, uBacklightStrength: 0.6 },
    studio: { keyIntensity: 60, keyColor: '#fff1dc', keyAngle: 0.34, beamIntensity: 0.18, hazeIntensity: 0.35, fogDensity: 0.035, mirrorStrength: 0.55 },
    post: { exposure: 1.0, bloomStrength: 0.35, bloomThreshold: 1.0, grain: 0.035, vignette: 0.35 },
    sculpture: { amplitude: 0.25, retention: 300, tintStrength: 0.35, detail: 0.35, figureOpacity: 0.7, veilOpacity: 0.3 },
    projector: { enabled: false },
  },

  breath: {
    label: 'Breath',
    note: 'barely moving air, long slow folds',
    wind: { speed: 0.9, gustAmp: 0.35, gustFreq: 0.09, turbulence: 1.1, turbScale: 0.6 },
    cloth: { kBase: 14, bendCompliance: 2.5e-3, shearCompliance: 1e-3, damping: 1.1, kLift: 0.15, gravity: -0.1 },
    material: { opacity: 0.2, roughness: 0.45, sheen: 1, sheenRoughness: 0.5, iridescence: 0.2, color: '#ece6da' },
    uniforms: { uFresnelAlpha: 0.9, uFresnelPower: 2.6, uDensityGain: 2.0, uBacklightStrength: 0.75 },
    studio: { keyIntensity: 45, keyColor: '#ffe9cf', keyAngle: 0.3, beamIntensity: 0.22, hazeIntensity: 0.55, fogDensity: 0.045, mirrorStrength: 0.6 },
    post: { exposure: 1.1, bloomStrength: 0.45, bloomThreshold: 0.9, grain: 0.03, vignette: 0.4 },
    sculpture: { amplitude: 0.2, retention: 260, tintStrength: 0.3, detail: 0.3, figureOpacity: 0.65, veilOpacity: 0.32 },
    projector: { enabled: false },
  },

  storm: {
    label: 'Storm',
    note: 'hard wind, crisp snapping folds',
    wind: { speed: 4.2, gustAmp: 1.1, gustFreq: 0.4, turbulence: 3.0, turbScale: 1.3 },
    cloth: { kBase: 5, bendCompliance: 8e-3, shearCompliance: 3e-3, damping: 0.35, kLift: 0.5, gravity: -0.2 },
    material: { opacity: 0.14, roughness: 0.55, sheen: 0.9, sheenRoughness: 0.7, iridescence: 0.08, color: '#dcd9d2' },
    uniforms: { uFresnelAlpha: 1.0, uFresnelPower: 1.9, uDensityGain: 3.2, uBacklightStrength: 0.5 },
    studio: { keyIntensity: 90, keyColor: '#fff4e4', keyAngle: 0.4, beamIntensity: 0.14, hazeIntensity: 0.25, fogDensity: 0.025, mirrorStrength: 0.45 },
    post: { exposure: 0.95, bloomStrength: 0.28, bloomThreshold: 1.15, grain: 0.045, vignette: 0.3 },
    sculpture: { amplitude: 0.18, retention: 200, tintStrength: 0.35, detail: 0.4, figureOpacity: 0.7, veilOpacity: 0.28 },
    projector: { enabled: false },
  },

  relic: {
    label: 'Relic',
    note: 'the body holds its form under the cloth',
    wind: { speed: 1.4, gustAmp: 0.5, gustFreq: 0.15, turbulence: 1.6, turbScale: 0.8 },
    cloth: { kBase: 12, bendCompliance: 3e-3, shearCompliance: 1.5e-3, damping: 0.8, kLift: 0.2, gravity: -0.12 },
    material: { opacity: 0.3, roughness: 0.55, sheen: 0.8, sheenRoughness: 0.65, iridescence: 0.05, color: '#e8dfcd' },
    uniforms: { uFresnelAlpha: 0.75, uFresnelPower: 2.8, uDensityGain: 1.8, uBacklightStrength: 0.45 },
    studio: { keyIntensity: 75, keyColor: '#ffeeda', keyAngle: 0.32, beamIntensity: 0.12, hazeIntensity: 0.3, fogDensity: 0.03, mirrorStrength: 0.5 },
    post: { exposure: 1.0, bloomStrength: 0.25, bloomThreshold: 1.1, grain: 0.03, vignette: 0.35 },
    sculpture: { amplitude: 0.45, retention: 900, tintStrength: 0.75, detail: 0.8, figureOpacity: 0.9, veilOpacity: 0.25 },
    projector: { enabled: false },
  },

  apparition: {
    label: 'Apparition',
    note: 'the diffusion result alone, cloth set free (needs the projector service)',
    wind: { speed: 2.6, gustAmp: 0.7, gustFreq: 0.22, turbulence: 2.2, turbScale: 1.0 },
    cloth: { kBase: 7, bendCompliance: 6e-3, shearCompliance: 2.5e-3, damping: 0.5, kLift: 0.35, gravity: -0.15 },
    material: { opacity: 0.12, roughness: 0.5, sheen: 0.9, sheenRoughness: 0.6, iridescence: 0.1, color: '#e2ded6' },
    uniforms: { uFresnelAlpha: 1.0, uFresnelPower: 2.2, uDensityGain: 2.2, uBacklightStrength: 0.5 },
    studio: { keyIntensity: 38, keyColor: '#ffe7c8', keyAngle: 0.3, beamIntensity: 0.1, hazeIntensity: 0.3, fogDensity: 0.04, mirrorStrength: 0.65 },
    post: { exposure: 1.15, bloomStrength: 0.5, bloomThreshold: 0.85, grain: 0.03, vignette: 0.45 },
    sculpture: { amplitude: 0.3, retention: 400, tintStrength: 0.3, detail: 0.3, figureOpacity: 0.7, veilOpacity: 0.3 },
    projector: { enabled: true, surface: 'diffusion', mode: 'woven', emphasis: 0.8, physicsRelief: 0.15, power: 0.9, mirror: true },
  },
};

export const PRESET_NAMES = Object.keys(PRESETS);

/** Parameters that only change pixels in the sculpture's textures, not physics. */
const TEXTURE_KEYS = ['tintStrength', 'detail', 'figureOpacity', 'veilOpacity'];

/**
 * ctx: { wind, solver, material, studio, post, sculpture, projector }
 * Everything is optional, so this also runs in tests with plain stand-ins.
 */
export function applyPreset(name, ctx = {}) {
  const preset = PRESETS[name];
  if (!preset) throw new Error(`unknown preset: ${name}`);
  const { wind, solver, material, studio, post, sculpture, projector } = ctx;

  if (wind) Object.assign(wind.params, preset.wind);
  if (solver) Object.assign(solver.params, preset.cloth);

  if (material) {
    for (const [key, value] of Object.entries(preset.material)) {
      if (key === 'color') material.color.set(value);
      else material[key] = value;
    }
    const uniforms = material.userData?.uniforms;
    if (uniforms) for (const [key, value] of Object.entries(preset.uniforms)) if (uniforms[key]) uniforms[key].value = value;
  }

  if (studio) { Object.assign(studio.params, preset.studio); studio.apply?.(); }
  if (post) { Object.assign(post.params, preset.post); post.apply?.(); }

  if (sculpture) {
    const before = TEXTURE_KEYS.map(key => sculpture.params[key]);
    Object.assign(sculpture.params, preset.sculpture);
    solver?.setAmplitude?.(sculpture.params.amplitude);
    if (solver) solver.params.kRetention = sculpture.params.retention;
    const textureChanged = TEXTURE_KEYS.some((key, i) => sculpture.params[key] !== before[i]);
    if (textureChanged && sculpture.state?.loaded) sculpture.rebuild?.();
  }

  if (projector) {
    const { enabled, ...rest } = preset.projector;
    Object.assign(projector.params, rest);
    if (projector.params.enabled !== enabled) projector.setEnabled?.(enabled);
    else projector.refresh?.();
  }
  return preset;
}
