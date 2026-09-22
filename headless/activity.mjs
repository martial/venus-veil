/** Ephemeral browser-tab presence. No cookies, identity, or visitor history. */
export function createActivity({ service, now = Date.now, ttl = 30000, fetcher = fetch } = {}) {
  const sessions = new Map();
  let pending, cached = null, checkedAt = -Infinity;
  function prune() {
    for (const [id, seen] of sessions) if (now() - seen >= ttl) sessions.delete(id);
  }
  return {
    touch(id) {
      prune();
      if (!/^[a-zA-Z0-9-]{16,64}$/.test(id || '')) return false;
      sessions.set(id, now());
      return true;
    },
    leave(id) { sessions.delete(id); },
    get connected() { prune(); return sessions.size; },
    async snapshot() {
      if (!pending && now() - checkedAt >= 500) {
        pending = (async () => {
          try {
            const answer = await fetcher(`${service.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(1800) });
            if (!answer.ok) throw new Error('service offline');
            const health = await answer.json();
            cached = { status: health.status, running: health.active_jobs ?? null, queued: health.queued_jobs ?? null,
              generated: health.generated ?? 0 };
          } catch { cached = { status: 'offline', running: null, queued: null, generated: null }; }
          finally { checkedAt = now(); pending = null; }
        })();
      }
      await pending;
      return { connected: this.connected, ...cached };
    },
  };
}
