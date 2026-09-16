/**
 * Offline recording. The studio is rendered frame by frame, as slowly as the
 * diffusion needs, and each finished frame is pushed into a MediaRecorder, so
 * the file plays back at its nominal frame rate however long it took to make.
 *
 * The plumbing is separated from the browser bits so the maths can be tested.
 */

export const MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

export const RESOLUTIONS = {
  'viewport': null,
  '1280 × 720': [1280, 720],
  '1920 × 1080': [1920, 1080],
  '2560 × 1440': [2560, 1440],
};

/** First supported container, or null when none of them are. */
export function pickMimeType(isSupported, candidates = MIME_CANDIDATES) {
  for (const type of candidates) if (isSupported(type)) return type;
  return null;
}

/** Frame count and timestep for a clip, with the duration clamped to something sane. */
export function exportPlan({ fps = 24, seconds = 8, maxSeconds = 120 } = {}) {
  const rate = Math.min(60, Math.max(1, Math.round(fps)));
  const length = Math.min(maxSeconds, Math.max(1 / rate, seconds));
  return { fps: rate, seconds: +length.toFixed(3), frames: Math.max(1, Math.round(length * rate)), dt: 1 / rate };
}

/** A bitrate that keeps folds clean without writing a huge file. */
export function pickBitrate(width, height, fps) {
  return Math.round(Math.min(40e6, Math.max(6e6, width * height * fps * 0.14)));
}

export function formatProgress(frame, frames, startedMs, nowMs) {
  const done = frame / frames;
  const elapsed = (nowMs - startedMs) / 1000;
  const remaining = done > 0 ? elapsed * (1 / done - 1) : 0;
  const clock = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  return { done, text: `recording ${frame} / ${frames} · ${clock(remaining)} left` };
}

/**
 * Wraps MediaRecorder over a canvas with a manually driven stream: nothing is
 * captured until frame() is called, so a slow frame never becomes a long frame.
 */
export function createVideoRecorder(canvas, { fps = 24, bitrate, mimeType } = {}) {
  const type = mimeType || pickMimeType(t => window.MediaRecorder?.isTypeSupported(t));
  if (!type) throw new Error('this browser cannot record WebM video');
  const stream = canvas.captureStream(0);
  const [track] = stream.getVideoTracks();
  const chunks = [];
  const recorder = new MediaRecorder(stream, {
    mimeType: type,
    videoBitsPerSecond: bitrate || pickBitrate(canvas.width, canvas.height, fps),
  });
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  let stopped = null;

  return {
    type,
    start() { recorder.start(); },
    /** Publish the canvas as it stands right now. */
    frame() { track.requestFrame(); },
    stop() {
      if (!stopped) {
        stopped = new Promise(resolve => {
          recorder.onstop = () => resolve(new Blob(chunks, { type }));
          recorder.stop();
          track.stop();
        });
      }
      return stopped;
    },
  };
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
