import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { IMAGE_ENGINES, modelLabel, modelNote } from './projection/models.js';
import { resolveExportSettings } from './projection/exportSettings.js';
import { applyModelPreset, applyMorphPreset, createModelSettingsBank, modelControlSpecs, MODEL_SETTINGS_NOTES, selectedModelPreset, selectedMorphPreset } from './projection/modelSettings.js';
import { isFluxModel } from './projection/morph.js';
import { LIVE_PRESETS, PRESETS, applyPreset, resolveLive } from './presets.js';
import { QUALITIES, RESOLUTIONS } from './record.js';
import { TURN_OPTIONS } from './projection/projector.js';

/**
 * Control panel. A handful of essentials and five looks by default; everything
 * else lives behind "expert controls". Controls write straight into the live
 * parameter objects, with `apply` callbacks where a value needs re-uploading.
 */
export function createUI({ wind, solver, material, studio, post, actions, sculpture, projector, quality, applyQuality, exportSettings, recording, veil }) {
  const gui = new GUI({ title: 'venus veil', width: 290 });
  gui.domElement.classList.add('veil-gui');
  const context = { wind, solver, material, studio, post, sculpture, projector };
  const state = { look: 'limestone', expert: false };
  const modelViews = [];
  const settingsViews = [];
  const recordingDisabled = new Map();
  if (projector) projector.onModels = () => modelViews.forEach(update => update());
  const explainUnavailableModels = controller => {
    const availability = document.createElement('div');
    availability.className = 'look-note';
    availability.setAttribute('role', 'status');
    controller.domElement.after(availability);
    const update = () => {
      const unavailable = new Map();
      const options = controller.domElement.querySelectorAll('option');
      Object.entries(IMAGE_ENGINES).forEach(([label, engine]) => {
        const option = [...options].find(option => option.textContent === label);
        const disabled = !projector.state.engines.includes(engine);
        const reason = disabled ? modelNote(engine, projector.state) : '';
        option.disabled = disabled;
        option.title = reason;
        if (disabled) {
          if (!unavailable.has(reason)) unavailable.set(reason, []);
          unavailable.get(reason).push(label.split(' · ')[0]);
        }
      });
      availability.textContent = [...unavailable].map(([reason, names]) => `${names.join(', ')}: ${reason}`).join(' ');
      availability.hidden = unavailable.size === 0;
    };
    modelViews.push(update);
    update();
  };

  const refresh = () => {
    settingsViews.forEach(update => update());
    gui.controllersRecursive().forEach(c => c.updateDisplay());
  };
  const modelControls = (parent, title, target, changed) => {
    const controls = parent.addFolder(title);
    const selection = { preset: selectedModelPreset(target), motion: selectedMorphPreset(target) };
    const preset = controls.add(selection, 'preset', { Speed: 'speed', Balanced: 'balanced', Detail: 'detail', Custom: 'custom' })
      .name('model preset').onChange(name => {
        if (name !== 'custom') { applyModelPreset(target, name); changed(); }
        refresh();
      });
    const description = document.createElement('div');
    description.className = 'look-note';
    preset.domElement.after(description);
    let currentEngine;
    const update = () => {
      if (currentEngine !== target.engine) {
        for (const control of [...controls.controllers]) if (control !== preset) control.destroy();
        if (isFluxModel(target.engine)) {
          controls.add(selection, 'motion', { Still: 'still', Gentle: 'gentle', Flow: 'flow', Dream: 'dream', Custom: 'custom' })
            .name('morph preset').onChange(name => {
              if (name !== 'custom') { applyMorphPreset(target, name); changed(); }
              refresh();
            });
        }
        for (const spec of modelControlSpecs(target.engine)) {
          const control = spec.choices ? controls.add(target, spec.key, spec.choices)
            : spec.range ? controls.add(target, spec.key, ...spec.range) : controls.add(target, spec.key);
          control.name(spec.label).onFinishChange(() => { changed(); refresh(); });
        }
        description.textContent = MODEL_SETTINGS_NOTES[target.engine];
        currentEngine = target.engine;
      }
      selection.preset = selectedModelPreset(target);
      selection.motion = selectedMorphPreset(target);
    };
    settingsViews.push(update);
    update();
    controls.close();
    return controls;
  };

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
    const liveModel = { engine: projector.params.engine };
    const modelController = gui.add(liveModel, 'engine', IMAGE_ENGINES).name('live model')
      .onChange(name => {
        if (recording?.active || !projector.setEngine(name)) liveModel.engine = projector.params.engine;
        updateLiveModel();
        refresh();
      });
    const modelDescription = document.createElement('div');
    modelDescription.className = 'look-note';
    modelController.domElement.after(modelDescription);
    const updateLiveModel = () => {
      const name = liveModel.engine;
      modelDescription.textContent = name === 'fast' ? 'Fast live generation. The scene and image update together.'
        : `${modelNote(name, projector.state)} New images arrive at the model’s measured speed; the cloth keeps moving.`;
    };
    explainUnavailableModels(modelController);
    modelViews.push(updateLiveModel);
    updateLiveModel();
    modelControls(gui, 'Live model settings', projector.params, () => projector.applyModelSettings());
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
    const screenOnly = gui.add(projector.params, 'screenOnly').name('voile blanc · écran seul')
      .onChange(() => projector.refresh());
    screenOnly.domElement.title = 'Coché : voile blanc et image sur l’écran rond. Décoché : projection aussi sur le grand voile.';
  }
  if (veil && actions.setVertical) {
    const vertical = gui.add(veil, 'vertical').name('voile vertical')
      .onChange(v => { if (!actions.setVertical(v)) veil.vertical = !v; refresh(); });
    vertical.domElement.title = 'Met le voile debout : la figure posée sur sa longueur se tient droite. Règle aussi la rotation de l’image à 0°.';
  }
  if (projector) {
    const turn = gui.add(projector.params, 'turn', TURN_OPTIONS).name('rotation image (visages)')
      .onChange(() => projector.state.resetCarry = true);
    turn.domElement.title = 'Tourne par quarts de tour l’image envoyée au modèle, puis la remet sur le voile : choisir l’angle où les visages sont à l’endroit.';
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
  let recordController;
  if (exportSettings) {
    const fExport = gui.addFolder('Export');
    const exportModel = { engine: exportSettings.useLiveModel === false ? exportSettings.engine : 'live' };
    const selectExportModel = createModelSettingsBank(exportSettings);
    const engineNote = document.createElement('div');
    engineNote.className = 'look-note';
    engineNote.setAttribute('role', 'status');
    const updateModels = () => {
      const settings = resolveExportSettings(exportSettings, projector.params);
      engineNote.textContent = `Export: ${modelLabel(settings.engine)} · ${settings.modelSize} px${settings.useLiveModel !== false ? ' · current live settings' : ' · export settings'}. ${modelNote(settings.engine, projector.state)}`;
    };
    const engineControl = fExport.add(exportModel, 'engine', { 'Same as live model + settings': 'live', ...IMAGE_ENGINES })
      .name('image engine').onChange(engine => {
        exportSettings.useLiveModel = engine === 'live';
        if (!exportSettings.useLiveModel) selectExportModel(engine);
        refresh();
      });
    engineControl.domElement.after(engineNote);
    if (projector) { explainUnavailableModels(engineControl); modelViews.push(updateModels); updateModels(); }
    const exportControls = modelControls(fExport, 'Export model settings', exportSettings, () => {});
    const updateExport = () => {
      exportModel.engine = exportSettings.useLiveModel === false ? exportSettings.engine : 'live';
      exportSettings.useLiveModel === false ? exportControls.show() : exportControls.hide();
      updateModels();
    };
    settingsViews.push(updateExport);
    updateExport();
    fExport.add(exportSettings, 'format', { 'MP4 (H.264)': 'mp4', 'WebM (VP9)': 'webm' }).name('format');
    fExport.add(exportSettings, 'resolution', Object.keys(RESOLUTIONS)).name('resolution');
    fExport.add(exportSettings, 'quality', Object.keys(QUALITIES)).name('quality');
    fExport.add(exportSettings, 'orbit', 0, 180, 1).name('camera orbit (°)');
    fExport.add(exportSettings, 'fps', [24, 25, 30, 50, 60]).name('frames per second');
    fExport.add(exportSettings, 'seconds', 1, 120, 1).name('duration (s)');
    fExport.add(exportSettings, 'hold', 0, 0.8, 0.05).name('still at start');
    if (projector) {
      fExport.add(exportSettings, 'diffusionFps', 1, 60, 1).name('new image per second');
    }
    recordController = fExport.add({ record: () => actions.record() }, 'record').name('record a video');
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
    setRecording(active) {
      recordController?.name(active ? 'stop recording' : 'record a video');
      // Export temporarily uses the projector's parameters. Prevent edits from
      // changing the model halfway through a recording or being lost on restore.
      for (const control of gui.controllersRecursive()) {
        if (control === recordController) continue;
        if (active) { recordingDisabled.set(control, control._disabled); control.disable(); }
        else if (!recordingDisabled.get(control)) control.enable();
      }
      if (!active) recordingDisabled.clear();
    },
    folders: { fWind, fCloth, fSurf, fLight, fSculpt, fProject, fActions },
    applyLook(name) { state.look = name; applyPreset(name, context); note.textContent = PRESETS[name].note; refresh(); },
  };
}
