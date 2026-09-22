import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { LIVE_PRESETS, PRESETS, applyPreset, resolveLive } from './presets.js';
import { QUALITIES, RESOLUTIONS } from './record.js';

/**
 * Control panel. A handful of essentials and five looks by default; everything
 * else lives behind "expert controls". Controls write straight into the live
 * parameter objects, with `apply` callbacks where a value needs re-uploading.
 */
export function createUI({ wind, solver, material, studio, post, actions, sculpture, projector, quality, applyQuality, exportSettings, recording }) {
  const gui = new GUI({ title: 'venus veil', width: 290 });
  gui.domElement.classList.add('veil-gui');
  const context = { wind, solver, material, studio, post, sculpture, projector };
  const state = { look: 'limestone', expert: false };

  const refresh = () => gui.controllersRecursive().forEach(c => c.updateDisplay());

  // ---------------------------------------------------------------- essentials
  const lookOptions = Object.fromEntries(Object.entries(PRESETS).map(([key, p]) => [p.label, key]));
  const note = document.createElement('div');
  note.className = 'look-note';
  note.textContent = PRESETS[state.look].note;
  const lookController = gui.add(state, 'look', lookOptions).name('look').onChange(name => {
    const preset = applyPreset(name, context);
    note.textContent = preset.note;
    refresh();
  });
  lookController.domElement.parentElement.insertBefore(note, lookController.domElement.nextSibling);

  if (projector) {
    // resolution and rate of live projection, independent of the look
    const liveOptions = Object.fromEntries(Object.entries(LIVE_PRESETS).map(([key, p]) => [p.label, key]));
    const liveNote = document.createElement('div');
    liveNote.className = 'look-note';
    const describe = resolved => {
      const preset = LIVE_PRESETS[resolved];
      liveNote.textContent = projector.params.live === 'auto' ? `${preset.label} · ${preset.note}` : preset.note;
    };
    describe(resolveLive(projector.params.live, projector.state.device));
    const liveController = gui.add(projector.params, 'live', liveOptions).name('real time')
      .onChange(name => { projector.applyLive(name); refresh(); });
    liveController.domElement.parentElement.insertBefore(liveNote, liveController.domElement.nextSibling);
    projector.onLive = resolved => { describe(resolved); refresh(); };
    // how many new images live projection asks for; frames in between crossfade
    gui.add(projector.params, 'maxFps', 1, 60, 1).name('images per second');
  }

  gui.add(wind.params, 'speed', 0, 5, 0.01).name('wind');
  gui.add(wind.params, 'turbulence', 0, 3, 0.01).name('turbulence');
  gui.add(material, 'opacity', 0, 1, 0.01).name('veil opacity');
  gui.add(studio.params, 'keyIntensity', 0, 200, 1).name('light').onChange(studio.apply);
  if (projector) gui.add(projector.params, 'power', 0, 3, 0.01).name('projected light');
  if (sculpture) {
    gui.add(sculpture.params, 'amplitude', 0, 0.6, 0.005).name('sculpture relief')
      .onChange(v => solver.setAmplitude(v));
  }
  if (projector) {
    gui.add(projector.params, 'enabled').name('live projection').onChange(v => { projector.setEnabled(v); refresh(); });
  }

  // ---------------------------------------------------------------- expert
  const advanced = [];
  const folder = title => { const f = gui.addFolder(title); f.close(); advanced.push(f); return f; };

  const fWind = folder('Wind');
  fWind.add(wind.params, 'speed', 0, 5, 0.01).name('speed');
  fWind.add(wind.params, 'gustAmp', 0, 2, 0.01).name('gusts');
  fWind.add(wind.params, 'gustFreq', 0.02, 1, 0.01).name('gust rate');
  fWind.add(wind.params, 'turbulence', 0, 3, 0.01).name('turbulence');
  fWind.add(wind.params, 'turbScale', 0.1, 1.5, 0.01).name('eddy size');
  fWind.add(wind.params.direction, '0', -1, 1, 0.01).name('dir x');
  fWind.add(wind.params.direction, '1', -1, 1, 0.01).name('dir y');
  fWind.add(wind.params.direction, '2', -1, 1, 0.01).name('dir z');
  fWind.add(wind.params, 'wandStrength', 0, 20, 0.1).name('pointer push');

  const fCloth = folder('Cloth');
  fCloth.add(solver.params, 'kBase', 0, 120, 1).name('hover spring');
  fCloth.add(solver.params, 'bendCompliance', 0.00005, 0.02, 0.00005).name('softness');
  fCloth.add(solver.params, 'shearCompliance', 0, 0.005, 0.00005).name('shear give');
  fCloth.add(solver.params, 'damping', 0, 4, 0.01).name('air damping');
  fCloth.add(solver.params, 'gravity', -2, 0.5, 0.01).name('gravity');
  fCloth.add(solver.params, 'kDrag', 0, 4, 0.01).name('drag');
  fCloth.add(solver.params, 'kLift', 0, 1, 0.01).name('lift');
  fCloth.add(solver.params, 'iterations', 1, 12, 1).name('iterations');

  const u = material.userData.uniforms;
  const fSurf = folder('Surface');
  fSurf.add(material, 'opacity', 0, 1, 0.01).name('base opacity');
  fSurf.add(u.uFresnelAlpha, 'value', 0, 1, 0.01).name('edge glow');
  fSurf.add(u.uFresnelPower, 'value', 0.5, 8, 0.05).name('edge falloff');
  fSurf.add(u.uDensityGain, 'value', 0, 4, 0.01).name('fold opacity');
  fSurf.add(u.uBacklightStrength, 'value', 0, 1.5, 0.01).name('back-light');
  fSurf.add(u.uBacklightForward, 'value', 0, 1, 0.01).name('forward scatter');
  fSurf.add(material, 'sheen', 0, 1, 0.01).name('sheen');
  fSurf.add(material, 'sheenRoughness', 0, 1, 0.01).name('sheen rough');
  fSurf.add(material, 'roughness', 0, 1, 0.01).name('roughness');
  fSurf.add(material, 'iridescence', 0, 1, 0.01).name('iridescence');
  fSurf.add(material, 'envMapIntensity', 0, 2, 0.01).name('env reflect');
  fSurf.add(material.normalScale, 'x', 0, 1.5, 0.01).name('weave relief').onChange(v => material.normalScale.set(v, v));
  fSurf.addColor(material, 'color').name('tint');

  const fLight = folder('Light');
  fLight.add(studio.params, 'keyIntensity', 0, 400, 1).name('key (cd)').onChange(studio.apply);
  fLight.addColor(studio.params, 'keyColor').name('key color').onChange(studio.apply);
  fLight.add(studio.params, 'keyAngle', 0.1, 1.2, 0.01).name('cone angle').onChange(studio.apply);
  fLight.add(studio.params, 'keyPenumbra', 0, 1, 0.01).name('penumbra').onChange(studio.apply);
  fLight.add(studio.params, 'rimIntensity', 0, 120, 1).name('rim (cd)').onChange(studio.apply);
  fLight.add(studio.params, 'beamIntensity', 0, 0.5, 0.005).name('beam').onChange(studio.apply);
  fLight.add(studio.params, 'hazeIntensity', 0, 2, 0.01).name('haze').onChange(studio.apply);
  fLight.add(studio.params, 'environmentIntensity', 0, 1, 0.01).name('ambient').onChange(studio.apply);
  fLight.add(studio.params, 'fogDensity', 0, 0.12, 0.001).name('fog').onChange(studio.apply);
  fLight.add(studio.params, 'mirrorStrength', 0, 1, 0.01).name('floor mirror').onChange(studio.apply);
  fLight.add(studio.params, 'mirrorBlur', 0, 8, 0.1).name('mirror blur').onChange(studio.apply);
  fLight.add(post.params, 'exposure', 0.2, 3, 0.01).name('exposure').onChange(post.apply);
  fLight.add(post.params, 'bloomStrength', 0, 1.5, 0.01).name('bloom').onChange(post.apply);
  fLight.add(post.params, 'bloomThreshold', 0, 2, 0.01).name('bloom threshold').onChange(post.apply);
  fLight.add(post.params, 'grain', 0, 0.15, 0.001).name('grain').onChange(post.apply);
  fLight.add(post.params, 'vignette', 0, 1, 0.01).name('vignette').onChange(post.apply);

  let fSculpt = null;
  if (sculpture) { fSculpt = folder('Sculpture'); sculpture.buildControls(fSculpt); }

  let fProject = null;
  if (projector) { fProject = folder('Projection'); projector.buildControls(fProject); }

  if (quality) {
    const fPerf = folder('Performance');
    fPerf.add(quality.params, 'auto').name('hold frame rate');
    fPerf.add(quality.params, 'floor', 12, 60, 1).name('minimum fps');
    fPerf.add(quality.params, 'scale', 0.4, 1, 0.05).name('resolution').listen().onChange(applyQuality);
    fPerf.add(quality.params, 'level', 0, 2, 1).name('detail step').listen().onChange(applyQuality);
    fPerf.add(quality.params, 'frameMs').name('frame (ms)').listen().disable();
  }

  const setExpert = on => { for (const f of advanced) on ? f.show() : f.hide(); };
  gui.add(state, 'expert').name('expert controls').onChange(setExpert);
  setExpert(false);

  // ---------------------------------------------------------------- export
  if (exportSettings) {
    const fExport = gui.addFolder('Export');
    fExport.add(exportSettings, 'engine', { 'live · one step': 'fast', 'fine · 8 steps': 'fine', 'best · 18 steps': 'best' })
      .name('image engine').onChange(engine => {
        // a slow engine wants fewer images: every frame would take hours
        exportSettings.diffusionFps = engine === 'fast' ? exportSettings.fps : engine === 'fine' ? 6 : 2;
        if (engine !== 'fast' && exportSettings.generated > 512) exportSettings.generated = 512;
        fExport.controllers.forEach(c => c.updateDisplay());
      });
    fExport.add(exportSettings, 'steps', 0, 40, 1).name('steps (0 = engine default)');
    fExport.add(exportSettings, 'format', { 'MP4 (H.264)': 'mp4', 'WebM (VP9)': 'webm' }).name('format');
    fExport.add(exportSettings, 'resolution', Object.keys(RESOLUTIONS)).name('resolution');
    fExport.add(exportSettings, 'quality', Object.keys(QUALITIES)).name('quality');
    fExport.add(exportSettings, 'orbit', 0, 180, 1).name('camera orbit (°)');
    fExport.add(exportSettings, 'fps', [24, 25, 30, 50, 60]).name('frames per second');
    fExport.add(exportSettings, 'seconds', 1, 120, 1).name('duration (s)');
    fExport.add(exportSettings, 'hold', 0, 0.8, 0.05).name('still at start');
    if (projector) {
      fExport.add(exportSettings, 'generated', [256, 384, 512]).name('generated resolution');
      fExport.add(exportSettings, 'diffusionFps', 1, 60, 1).name('new image per second');
    }
    fExport.add({ record: () => actions.record() }, 'record').name('record a video');
    fExport.close();
  }

  // ---------------------------------------------------------------- actions
  const fActions = gui.addFolder('Actions');
  if (sculpture) {
    fActions.add({ load: () => document.getElementById('file-input')?.click() }, 'load').name('load a photo…');
    fActions.add({ sample: () => sculpture.loadSample() }, 'sample').name('load sample');
  }
  fActions.add(actions, 'pause').name('pause / resume  (space)');
  fActions.add(actions, 'reset').name('reset cloth  (R)');
  fActions.add(actions, 'capture').name('save PNG  (S)');
  fActions.add(actions, 'toggleUI').name('hide panel  (H)');

  return {
    gui, state, refresh,
    folders: { fWind, fCloth, fSurf, fLight, fSculpt, fProject, fActions },
    applyLook(name) { state.look = name; applyPreset(name, context); note.textContent = PRESETS[name].note; refresh(); },
  };
}
