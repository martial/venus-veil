/** Paused tabs still count; closed/crashed tabs disappear after at most 30 s. */
export function startActivity(element) {
  if (!element) return;
  const session = crypto.randomUUID();
  const url = `/projector/activity?session=${session}`;
  let timer, stopped = false, controller;
  async function update() {
    if (stopped) return;
    controller = new AbortController();
    try {
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]) });
      if (!response.ok) throw new Error('activity unavailable');
      const state = await response.json();
      if (!Number.isInteger(state.connected)) throw new Error('activity unavailable');
      if (stopped) return;
      element.dataset.status = state.status;
      element.textContent = `${state.connected} connecté${state.connected === 1 ? '' : 's'} · ${state.running ?? '—'} en cours · ${state.queued ?? '—'} en attente`;
      element.title = `Onglets actifs, y compris en pause. Traitements GPU : génération et lecture des photos. ${state.generated ?? '—'} images générées depuis le démarrage. Actualisation toutes les 2 secondes.`;
    } catch {
      if (!stopped) { element.dataset.status = 'offline'; element.textContent = 'activité indisponible'; }
    } finally {
      if (!stopped) timer = setTimeout(update, document.hidden ? 10000 : 2000);
    }
  }
  function leave() {
    stopped = true;
    clearTimeout(timer);
    controller?.abort();
    navigator.sendBeacon(`${url}&leave=1`);
  }
  function resume(event) {
    if (event.persisted) { stopped = false; update(); }
  }
  addEventListener('pagehide', leave);
  addEventListener('pageshow', resume);
  update();
  return () => { leave(); removeEventListener('pagehide', leave); removeEventListener('pageshow', resume); };
}
