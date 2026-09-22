/** Pace requests without losing a whole display frame to tiny timer jitter. */
export function createLiveClock() {
  let due = 0, windowStart = null, count = 0, fps = 0;
  return {
    take(now, rate) {
      if (!(rate > 0) || now + 0.25 < due) return false;
      const interval = 1000 / rate;
      due = Math.max(due + interval, now + interval * 0.05);
      return true;
    },
    presented(now) {
      if (windowStart === null) { windowStart = now; count = 0; return fps; }
      count++;
      const elapsed = now - windowStart;
      if (elapsed >= 750) { fps = count * 1000 / elapsed; windowStart = now; count = 0; }
      return fps;
    },
    reset() { due = 0; windowStart = null; count = fps = 0; },
  };
}
