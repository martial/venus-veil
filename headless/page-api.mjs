/**
 * The page half of the headless renderer. This source is injected into the
 * browser by render.mjs, so the app itself stays free of test hooks: it only
 * uses what `window.__veil` already exposes.
 */
export const PAGE_API = /* js */`
window.__veilHeadless = (() => {
  const veil = window.__veil;
  const state = { fps: 60, interval: 1, frames: 1, orbit: 0, hold: 0.2, started: 0, orbitStart: null };

  const angle = (progress, hold, degrees) => {
    const p = Math.min(1, Math.max(0, progress));
    if (p <= hold) return 0;
    const u = (p - hold) / Math.max(1e-6, 1 - hold);
    return degrees * (u * u * (3 - 2 * u));
  };

  return {
    async prepare(settings) {
      const { projector, solver, quality, post, studio, camera, controls, ui } = veil;
      if (settings.service) projector.state.endpoint = settings.service;
      await veil.sculpture.whenReady();
      veil.renderer.setAnimationLoop(null);
      await projector.prepareRecording();
      Object.assign(state, {
        fps: settings.fps, interval: settings.interval, frames: settings.frames,
        orbit: settings.orbit, hold: settings.hold,
      });
      if (!projector.setEngine(settings.engine)) throw new Error('Requested image model is unavailable');
      projector.params.steps = settings.steps || 0;
      projector.params.seed = settings.seed;
      projector.params.carry = settings.carry;
      projector.params.priority = true;
      projector.params.running = false;      // frames are requested one at a time
      projector.params.wander = false;
      if (settings.prompt) projector.params.prompt = settings.prompt;
      if (settings.generated && projector.params.size !== settings.generated) projector.setSize(settings.generated);
      projector.state.resetCarry = true;
      if (!projector.params.enabled) projector.setEnabled(true);
      // a frame is a screenshot of the canvas's rectangle, which would include
      // the panel, the title and the previews floating over it: keep only the canvas
      const bare = document.createElement('style');
      bare.textContent = 'body > :not(#viewport) { visibility: hidden !important; }';
      document.head.appendChild(bare);
      // full detail: a headless render is never in a hurry
      quality.params.auto = false;
      quality.reset(1, 0);
      veil.applyQuality();
      state.orbitStart = {
        x: camera.position.x - controls.target.x,
        y: camera.position.y - controls.target.y,
        z: camera.position.z - controls.target.z,
      };
      state.started = performance.now();
      return { engine: projector.params.engine, size: projector.params.size, endpoint: projector.state.endpoint };
    },

    async frame(index) {
      const { projector, solver, wind, ribbon, studio, post, stepper, sculpture, camera, controls } = veil;
      const dt = 1 / state.fps;
      if (state.orbit) {
        // rotate the starting offset about the world up axis, without needing three
        const radians = angle(index / state.frames, state.hold, state.orbit) * Math.PI / 180;
        const cos = Math.cos(radians), sin = Math.sin(radians);
        const start = state.orbitStart;
        camera.position.set(
          controls.target.x + start.x * cos + start.z * sin,
          controls.target.y + start.y,
          controls.target.z - start.x * sin + start.z * cos,
        );
        camera.lookAt(controls.target);
        camera.updateMatrixWorld();
      }
      const steps = Math.max(1, Math.round(dt / stepper.dt));
      wind.update(solver.time, dt);
      for (let s = 0; s < steps; s++) solver.step(stepper.dt, wind.sampleAt);
      solver.updateDensity();
      sculpture.update(dt);
      if (index % state.interval === 0) await projector.recordFrame(index / state.fps);
      ribbon.sync();
      projector.update(dt);
      studio.update(index * dt);
      veil.renderer.shadowMap.needsUpdate = true;
      post.render(index * dt);
      return { index, presented: projector.state.presented, error: projector.state.error };
    },

    stats() {
      const { projector } = veil;
      return {
        presented: projector.state.presented,
        perFrameMs: projector.state.perFrameMs?.[projector.params.engine] || 0,
        error: projector.state.error,
        elapsedMs: performance.now() - state.started,
      };
    },
  };
})();
`;
