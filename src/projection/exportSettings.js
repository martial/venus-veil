import { snapshotModelSettings } from './modelSettings.js';

// Resolve once when recording starts. Keep video options and any independent
// export preset intact while following the live model's current tuning.
export function resolveExportSettings(settings, live) {
  return settings.useLiveModel === false ? { ...settings } : {
    ...settings,
    engine: live.engine,
    ...snapshotModelSettings(live),
  };
}
