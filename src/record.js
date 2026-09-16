/**
 * Offline recording. The studio is rendered frame by frame, as slowly as the
 * diffusion needs, and each finished frame is pushed into a MediaRecorder, so
 * the file plays back at its nominal frame rate however long it took to make.
 *
 * The plumbing is separated from the browser bits so the maths can be tested.
 */

// H.264 in MP4 first: it drops straight into any editor. WebM/VP9 is the
// fallback for browsers that cannot record MP4.
export const MIME_CANDIDATES = {
  mp4: ['video/mp4;codecs=avc1.640033', 'video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.42E01E', 'video/mp4'],
  webm: ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'],
};

/** Roughly: standard for a preview, master for grading or a big screen. */
export const QUALITIES = { standard: 1, high: 2, master: 4 };

export const RESOLUTIONS = {
  'viewport': null,
  '1280 × 720': [1280, 720],
  '1920 × 1080': [1920, 1080],
  '2560 × 1440': [2560, 1440],
};

/**
 * First supported container for the wanted format, falling back to the other
 * one, so a recording is still possible when MP4 is unavailable.
 */
export function pickMimeType(isSupported, format = 'mp4', table = MIME_CANDIDATES) {
  const order = format === 'webm' ? ['webm', 'mp4'] : ['mp4', 'webm'];
  for (const key of order) {
    for (const type of table[key] || []) if (isSupported(type)) return type;
  }
  return null;
}

export function extensionFor(mimeType = '') {
  return mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
}

/** Frame count and timestep for a clip, with the duration clamped to something sane. */
export function exportPlan({ fps = 24, seconds = 8, maxSeconds = 120 } = {}) {
  const rate = Math.min(60, Math.max(1, Math.round(fps)));
  const length = Math.min(maxSeconds, Math.max(1 / rate, seconds));
  return { fps: rate, seconds: +length.toFixed(3), frames: Math.max(1, Math.round(length * rate)), dt: 1 / rate };
}

/** A bitrate that keeps folds clean without writing a huge file. */
export function pickBitrate(width, height, fps, quality = 'high') {
  const factor = QUALITIES[quality] ?? QUALITIES.high;
  const base = Math.min(60e6, Math.max(2e6, width * height * fps * 0.1));
  return Math.round(Math.min(200e6, base * factor));
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
export function createVideoRecorder(canvas, { fps = 24, bitrate, mimeType, format = 'mp4', quality = 'high' } = {}) {
  const type = mimeType || pickMimeType(t => window.MediaRecorder?.isTypeSupported(t), format);
  if (!type) throw new Error('this browser cannot record video');
  const stream = canvas.captureStream(0);
  const [track] = stream.getVideoTracks();
  const chunks = [];
  const recorder = new MediaRecorder(stream, {
    mimeType: type,
    videoBitsPerSecond: bitrate || pickBitrate(canvas.width, canvas.height, fps, quality),
  });
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  let stopped = null;

  return {
    type,
    extension: extensionFor(type),
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
