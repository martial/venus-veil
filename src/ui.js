import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

/**
 * lil-gui control panel. Every control writes straight into the live params
 * objects; `apply` callbacks push values that need a re-upload.
 */
export function createUI({ wind, solver, material, studio, post, actions, sculpture }) {
  const gui = new GUI({ title: 'venus veil', width: 290 });
  gui.domElement.classList.add('veil-gui');

  const fWind = gui.addFolder('Wind');
  fWind.add(wind.params, 'speed', 0, 5, 0.01).name('speed');
  fWind.add(wind.params, 'gustAmp', 0, 2, 0.01).name('gusts');
  fWind.add(wind.params, 'gustFreq', 0.02, 1, 0.01).name('gust rate');
  fWind.add(wind.params, 'turbulence', 0, 3, 0.01).name('turbulence');
  fWind.add(wind.params, 'turbScale', 0.1, 1.5, 0.01).name('eddy size');
  fWind.add(wind.params.direction, '0', -1, 1, 0.01).name('dir x');
  fWind.add(wind.params.direction, '1', -1, 1, 0.01).name('dir y');
  fWind.add(wind.params.direction, '2', -1, 1, 0.01).name('dir z');
  fWind.add(wind.params, 'wandStrength', 0, 20, 0.1).name('pointer push');

  const fCloth = gui.addFolder('Cloth');
  fCloth.add(solver.params, 'kBase', 0, 120, 1).name('hover spring');
  fCloth.add(solver.params, 'bendCompliance', 0.00005, 0.02, 0.00005).name('softness');
  fCloth.add(solver.params, 'shearCompliance', 0, 0.005, 0.00005).name('shear give');
  fCloth.add(solver.params, 'damping', 0, 4, 0.01).name('air damping');
  fCloth.add(solver.params, 'gravity', -2, 0.5, 0.01).name('gravity');
  fCloth.add(solver.params, 'kDrag', 0, 4, 0.01).name('drag');
  fCloth.add(solver.params, 'kLift', 0, 1, 0.01).name('lift');
  fCloth.add(solver.params, 'iterations', 1, 12, 1).name('iterations');
  fCloth.close();

  const u = material.userData.uniforms;
  const fSurf = gui.addFolder('Surface');
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
  fSurf.close();

  const fLight = gui.addFolder('Light');
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
  fLight.close();

  let fSculpt = null;
  if (sculpture) {
    fSculpt = gui.addFolder('Sculpture');
    sculpture.buildControls(fSculpt);
  }

  const fActions = gui.addFolder('Actions');
  fActions.add(actions, 'pause').name('pause / resume  (space)');
  fActions.add(actions, 'reset').name('reset cloth  (R)');
  fActions.add(actions, 'capture').name('save PNG  (S)');
  fActions.add(actions, 'toggleUI').name('hide UI  (H)');

  return { gui, folders: { fWind, fCloth, fSurf, fLight, fSculpt, fActions } };
}
