/**
 * Five looks. Each is a plain description of every part of the studio, applied
 * onto the live parameter objects; nothing here touches the DOM, so the set can
 * be unit-tested and extended by hand.
 */

export const PRESETS = {
  limestone: {
    label: 'Limestone',
    note: 'weathered stone, the figure the sculptor carved',
    photoStyle: 'weathered limestone sculpture, detailed surface, museum spotlight, black background',
    wind: { speed: 2.2, gustAmp: 0.6, gustFreq: 0.2, turbulence: 2.2, turbScale: 1.0 },
    cloth: { kBase: 8, bendCompliance: 5e-3, shearCompliance: 2e-3, damping: 0.6, kLift: 0.3, gravity: -0.15 },
    material: { opacity: 0.16, roughness: 0.5, sheen: 1, sheenRoughness: 0.6, iridescence: 0.1, color: '#e2ded6' },
    uniforms: { uFresnelAlpha: 1.0, uFresnelPower: 2.2, uDensityGain: 2.5, uBacklightStrength: 0.6 },
    studio: { keyIntensity: 55, keyColor: '#fff1dc', keyAngle: 0.34, beamIntensity: 0.16, hazeIntensity: 0.35, fogDensity: 0.035, mirrorStrength: 0.55 },
    post: { exposure: 1.0, bloomStrength: 0.35, bloomThreshold: 1.0, grain: 0.035, vignette: 0.35 },
    sculpture: { amplitude: 0.3, retention: 350, tintStrength: 0.35, detail: 0.35, figureOpacity: 0.7, veilOpacity: 0.3 },
    projector: {
      enabled: true, surface: 'diffusion', mode: 'woven', upright: true,
      prompt: 'a prehistoric Venus figurine, full body, heavy breasts, round belly, braided head, carved from weathered limestone, museum spotlight, black background',
      emphasis: 0, guidance: 1.1, power: 0.85, physicsRelief: 0.2, wander: false, blendMs: 90, mirror: true,
    },
  },

  bronze: {
    label: 'Bronze',
    note: 'cast metal, oxidised green and copper',
    photoStyle: 'cast bronze sculpture, oxidised turquoise and copper patina, museum spotlight, black background',
    wind: { speed: 1.6, gustAmp: 0.5, gustFreq: 0.16, turbulence: 1.7, turbScale: 0.85 },
    cloth: { kBase: 11, bendCompliance: 3.5e-3, shearCompliance: 1.6e-3, damping: 0.8, kLift: 0.22, gravity: -0.13 },
    material: { opacity: 0.18, roughness: 0.45, sheen: 0.85, sheenRoughness: 0.55, iridescence: 0.16, color: '#e6ddc8' },
    uniforms: { uFresnelAlpha: 0.9, uFresnelPower: 2.5, uDensityGain: 2.2, uBacklightStrength: 0.5 },
    studio: { keyIntensity: 48, keyColor: '#ffe4bd', keyAngle: 0.31, beamIntensity: 0.2, hazeIntensity: 0.5, fogDensity: 0.042, mirrorStrength: 0.62 },
    post: { exposure: 1.05, bloomStrength: 0.5, bloomThreshold: 0.9, grain: 0.03, vignette: 0.42 },
    sculpture: { amplitude: 0.32, retention: 420, tintStrength: 0.4, detail: 0.45, figureOpacity: 0.75, veilOpacity: 0.28 },
    projector: {
      enabled: true, surface: 'diffusion', mode: 'woven', upright: true,
      prompt: 'a cast bronze sculpture of a prehistoric Venus, oxidised turquoise and copper patina, engraved ornamental relief, museum spotlight, black background',
      emphasis: 0, guidance: 1.2, power: 1.0, physicsRelief: 0.25, wander: false, blendMs: 110, mirror: true,
    },
  },

  ivory: {
    label: 'Ivory',
    note: 'projection over the lit cloth: pearl and carved ivory',
    photoStyle: 'polished ivory and mother of pearl sculpture, luminous cream surface, museum spotlight, black background',
    wind: { speed: 1.1, gustAmp: 0.4, gustFreq: 0.11, turbulence: 1.3, turbScale: 0.7 },
    cloth: { kBase: 13, bendCompliance: 2.8e-3, shearCompliance: 1.2e-3, damping: 1.0, kLift: 0.18, gravity: -0.1 },
    material: { opacity: 0.22, roughness: 0.42, sheen: 1, sheenRoughness: 0.5, iridescence: 0.28, color: '#efe8dc' },
    uniforms: { uFresnelAlpha: 0.95, uFresnelPower: 2.7, uDensityGain: 2.0, uBacklightStrength: 0.8 },
    studio: { keyIntensity: 62, keyColor: '#fff4e8', keyAngle: 0.3, beamIntensity: 0.18, hazeIntensity: 0.4, fogDensity: 0.033, mirrorStrength: 0.58 },
    post: { exposure: 1.12, bloomStrength: 0.42, bloomThreshold: 0.95, grain: 0.028, vignette: 0.38 },
    sculpture: { amplitude: 0.26, retention: 320, tintStrength: 0.3, detail: 0.3, figureOpacity: 0.65, veilOpacity: 0.32 },
    projector: {
      enabled: true, surface: 'fabric', mode: 'woven', upright: true,
      prompt: 'a prehistoric Venus figurine carved in polished mammoth ivory and mother of pearl, luminous cream surface, fine carved relief, museum spotlight, black background',
      emphasis: 0, guidance: 1.0, power: 1.15, physicsRelief: 0.35, wander: false, blendMs: 90, mirror: true,
    },
  },

  obsidian: {
    label: 'Obsidian',
    note: 'smoked glass in a darker room',
    photoStyle: 'translucent smoky black glass sculpture, silver veins, inner light, dark museum, black background',
    wind: { speed: 3.4, gustAmp: 0.9, gustFreq: 0.3, turbulence: 2.8, turbScale: 1.2 },
    cloth: { kBase: 6, bendCompliance: 7e-3, shearCompliance: 2.8e-3, damping: 0.45, kLift: 0.42, gravity: -0.18 },
    material: { opacity: 0.12, roughness: 0.55, sheen: 0.9, sheenRoughness: 0.65, iridescence: 0.08, color: '#dcd9d2' },
    uniforms: { uFresnelAlpha: 1.0, uFresnelPower: 2.0, uDensityGain: 3.0, uBacklightStrength: 0.45 },
    studio: { keyIntensity: 32, keyColor: '#ffe7c8', keyAngle: 0.28, beamIntensity: 0.1, hazeIntensity: 0.3, fogDensity: 0.05, mirrorStrength: 0.7 },
    post: { exposure: 1.18, bloomStrength: 0.55, bloomThreshold: 0.8, grain: 0.032, vignette: 0.5 },
    sculpture: { amplitude: 0.28, retention: 300, tintStrength: 0.3, detail: 0.3, figureOpacity: 0.7, veilOpacity: 0.3 },
    projector: {
      enabled: true, surface: 'diffusion', mode: 'woven', upright: true,
      prompt: 'a prehistoric Venus figurine carved from translucent smoky black glass, silver veins, inner light, dark museum, black background',
      emphasis: 0, guidance: 1.3, power: 1.15, physicsRelief: 0.1, wander: false, blendMs: 80, mirror: true,
    },
  },

  wandering: {
    label: 'Wandering',
    note: 'the material drifts: stone, ivory, pearl, glass',
    photoStyle: 'detailed sculpture, carved relief, museum spotlight, black background',
    wind: { speed: 2.8, gustAmp: 0.8, gustFreq: 0.24, turbulence: 2.5, turbScale: 1.1 },
    cloth: { kBase: 7, bendCompliance: 6e-3, shearCompliance: 2.4e-3, damping: 0.5, kLift: 0.35, gravity: -0.15 },
    material: { opacity: 0.14, roughness: 0.5, sheen: 0.95, sheenRoughness: 0.58, iridescence: 0.14, color: '#e4e0d8' },
    uniforms: { uFresnelAlpha: 1.0, uFresnelPower: 2.2, uDensityGain: 2.4, uBacklightStrength: 0.55 },
    studio: { keyIntensity: 44, keyColor: '#ffeeda', keyAngle: 0.32, beamIntensity: 0.14, hazeIntensity: 0.38, fogDensity: 0.04, mirrorStrength: 0.6 },
    post: { exposure: 1.08, bloomStrength: 0.46, bloomThreshold: 0.88, grain: 0.03, vignette: 0.42 },
    sculpture: { amplitude: 0.3, retention: 360, tintStrength: 0.32, detail: 0.32, figureOpacity: 0.7, veilOpacity: 0.3 },
    projector: {
      enabled: true, surface: 'diffusion', mode: 'woven', upright: true,
      prompt: 'a prehistoric Venus figurine, full body, heavy breasts, round belly, braided head, carved relief, museum spotlight, black background',
      emphasis: 0, guidance: 1.15, power: 0.95, physicsRelief: 0.15, wander: true, drift: 0.65, wanderSpeed: 0.16, blendMs: 160, mirror: true,
    },
  },
};

export const PRESET_NAMES = Object.keys(PRESETS);

/** A photo supplies the subject; built-in looks supply only the finish.
 * Custom prompts are intentional and remain exactly as written. */
export function promptForReference(prompt, caption = '') {
  const preset = Object.values(PRESETS).find(p => p.projector.prompt === prompt);
  if (!preset) return prompt;
  return `${caption.trim() || 'a detailed sculpture'}, ${preset.photoStyle}`;
}

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

/**
 * Real-time presets: how finely and how often live projection re-imagines the
 * veil. Independent of the look, which says what the veil is made of. A size the
 * service does not have falls back to the nearest one it does (pickSize).
 */
export const LIVE_PRESETS = {
  auto: { label: 'auto', note: 'chosen for the service: fluid on this Mac, sharp on a GPU server' },
  fluid: { label: 'fluid', note: '256 px · as many images a second as the service makes', size: 256, maxFps: 60 },
  balanced: { label: 'balanced', note: '384 px · up to 60 images a second', size: 384, maxFps: 60 },
  sharp: { label: 'sharp', note: '512 px · up to 60 images a second', size: 512, maxFps: 60 },
  detail: { label: 'max detail', note: '768 px · up to 30 images a second · GPU server', size: 768, maxFps: 30 },
};

/** The concrete preset behind a name: 'auto' asks what the service runs on. */
export function resolveLive(name, device) {
  if (name !== 'auto') return LIVE_PRESETS[name] ? name : 'fluid';
  return device === 'cuda' ? 'sharp' : 'fluid';
}

/** The smallest available size at least as fine as the one wanted, else the largest there is. */
export function pickSize(wanted, sizes) {
  if (!sizes?.length) return wanted;
  const finer = sizes.filter(n => n >= wanted);
  return finer.length ? Math.min(...finer) : Math.max(...sizes);
}
