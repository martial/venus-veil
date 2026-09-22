/** Upload the latest photo once, and reject late answers from replaced photos. */
export function createReferenceUpload({ state, onChange, onStatus = () => {}, fetcher = globalThis.fetch, now = () => performance.now() }) {
  let blob = null, upload = null, controller = null, revision = 0, retryAt = 0;
  let endpoint = state.endpoint;
  Object.assign(state, { referenceId: null, referenceCaption: '', referenceStatus: 'empty', referenceError: null });

  function reset() {
    revision++;
    controller?.abort();
    controller = upload = null;
    retryAt = 0;
    Object.assign(state, { referenceId: null, referenceCaption: '', referenceStatus: blob ? 'pending' : 'empty', referenceError: null });
    onChange();
    onStatus();
  }

  function ensure() {
    if (endpoint !== state.endpoint) { endpoint = state.endpoint; reset(); }
    if (!blob || state.referenceId || !state.references || state.status !== 'ready') return Promise.resolve();
    if (upload) return upload;
    if (now() < retryAt) return Promise.resolve();
    const current = revision;
    controller = new AbortController();
    state.referenceStatus = 'uploading';
    onStatus();
    upload = (async () => {
      try {
        const response = await fetcher(`${endpoint}/reference`, {
          method: 'POST', body: blob, headers: { 'Content-Type': blob.type },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]),
        });
        if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
        const result = await response.json();
        if (!/^[0-9a-f]{16}$/.test(result.id)) throw new Error('the service did not return a photo id');
        if (current !== revision) return;
        Object.assign(state, {
          referenceId: result.id, referenceCaption: typeof result.caption === 'string' ? result.caption : '',
          referenceStatus: 'ready', referenceError: null,
        });
      } catch (error) {
        if (current !== revision) return;
        state.referenceStatus = 'error';
        state.referenceError = error.message;
        retryAt = now() + 2000;
      } finally {
        if (current === revision) { upload = controller = null; onStatus(); }
      }
    })();
    return upload;
  }

  return {
    set(value) { blob = value || null; reset(); return ensure(); },
    ensure,
    invalidate(id) { if (id === state.referenceId) reset(); },
    get hasPhoto() { return !!blob; },
    get ready() { return !blob || !state.references || (!!state.referenceId && endpoint === state.endpoint); },
  };
}
