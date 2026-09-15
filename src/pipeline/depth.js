/**
 * Main-thread wrapper around the sculpture worker (depth + texture build):
 * one promise per job, progress/stage events, backend report.
 */
export function createSculptureWorker({ onProgress, onStage } = {}) {
  const worker = new Worker(new URL('./depth.worker.js', import.meta.url), { type: 'module' });
  let nextId = 1;
  const pending = new Map();
  const api = { backend: null, ready: false };

  worker.onmessage = (event) => {
    const m = event.data;
    if (m.type === 'progress') { onProgress?.(m); return; }
    if (m.type === 'stage') { if (m.backend) { api.backend = m.backend; api.ready = true; } onStage?.(m); return; }
    const job = pending.get(m.id);
    if (!job) return;
    pending.delete(m.id);
    if (m.type === 'error') job.reject(new Error(m.message));
    else { if (m.backend) { api.backend = m.backend; api.ready = true; } job.resolve(m); }
  };
  worker.onerror = (event) => {
    for (const job of pending.values()) job.reject(new Error(event.message || 'sculpture worker crashed'));
    pending.clear();
  };

  const call = (message, transfer = []) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...message, id }, transfer);
  });

  api.load = () => call({ type: 'load' }).then(r => r.backend);
  /** bitmap is transferred and consumed by the worker. */
  api.process = (bitmap, params, grid) => call({ type: 'process', bitmap, params, grid }, [bitmap]);
  api.rebuild = (params, grid) => call({ type: 'rebuild', params, grid });
  api.dispose = () => worker.terminate();
  return api;
}
