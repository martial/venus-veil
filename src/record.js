/**
 * Offline recording. The studio is rendered frame by frame, as slowly as the
 * diffusion needs, and every frame is handed to a WebCodecs encoder with its
 * exact timestamp, so a frame that took two seconds to make is still 1/60 s in
 * the file. (MediaRecorder cannot do this: it stamps frames by wall clock, so a
 * slow frame becomes a long frame and the clip plays back uneven.)
 *
 * The plumbing is separated from the browser bits so the maths can be tested.
 */
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, WebMOutputFormat } from 'mediabunny';

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
  '3840 × 2160': [3840, 2160],
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

/**
 * How many rendered frames pass between two generated images. The clip always
 * runs at its own frame rate; the diffusion simply updates more slowly beneath
 * it, exactly as it does live.
 */
export function diffusionInterval(fps, diffusionFps) {
  const rate = Math.min(fps, Math.max(0.25, diffusionFps || fps));
  return Math.max(1, Math.round(fps / rate));
}

/**
 * Camera path for a recording: still for the first `hold` of the clip, then a
 * slow orbit that eases in, so the movement never starts with a jerk.
 * Returns degrees travelled at `progress` (0..1).
 */
export function cameraAngle(progress, { hold = 0.2, degrees = 40 } = {}) {
  const p = Math.min(1, Math.max(0, progress));
  if (p <= hold) return 0;
  const u = (p - hold) / Math.max(1e-6, 1 - hold);
  return degrees * (u * u * (3 - 2 * u));
}

/**
 * Resolves once the page is visible. Chrome suspends video encoding in a hidden
 * tab, so a recording waits here rather than stalling half-written.
 */
export function whenVisible(doc = typeof document === 'undefined' ? null : document) {
  if (!doc || doc.visibilityState !== 'hidden') return Promise.resolve(false);
  return new Promise(resolve => {
    const onChange = () => {
      if (doc.visibilityState === 'hidden') return;
      doc.removeEventListener('visibilitychange', onChange);
      resolve(true);
    };
    doc.addEventListener('visibilitychange', onChange);
  });
}

/** H.264 needs even dimensions; the viewport rarely has them. */
export function evenSize(width, height) {
  return [Math.max(2, Math.floor(width / 2) * 2), Math.max(2, Math.floor(height / 2) * 2)];
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
  return Math.round(Math.min(120e6, base * factor));
}

export function formatProgress(frame, frames, startedMs, nowMs) {
  const done = frame / frames;
  const elapsed = (nowMs - startedMs) / 1000;
  const remaining = done > 0 ? elapsed * (1 / done - 1) : 0;
  const clock = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  return { done, text: `recording ${frame} / ${frames} · ${clock(remaining)} left` };
}

/**
 * Encodes the canvas frame by frame at an exact frame rate. Each frame is
 * timestamped by its index, never by the clock, and `frame()` resolves only
 * once the encoder is ready for the next one.
 */
export async function createFrameWriter(canvas, { fps = 60, format = 'mp4', bitrate, keyFrameSeconds = 2 } = {}, factories = {}) {
  const webm = format === 'webm';
  const makeOutput = factories.createOutput || (options => new Output(options));
  const makeSource = factories.createSource || ((element, config) => new CanvasSource(element, config));
  const output = makeOutput({
    target: new BufferTarget(),
    format: webm ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: 'in-memory' }),
  });
  const source = makeSource(canvas, {
    codec: webm ? 'vp9' : 'avc',
    bitrate,
    keyFrameInterval: keyFrameSeconds,
    sizeChangeBehavior: 'deny',
  });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();
  let index = 0;
  return {
    extension: webm ? 'webm' : 'mp4',
    get frames() { return index; },
    /** Encode the canvas as it stands, as frame number `index`. */
    async frame() {
      await source.add(index / fps, 1 / fps);
      index++;
    },
    async finish() {
      await output.finalize();
      return new Blob([output.target.buffer], { type: webm ? 'video/webm' : 'video/mp4' });
    },
    async cancel() { await output.cancel(); },
  };
}

/**
 * Fallback for browsers without WebCodecs: MediaRecorder over a manually driven
 * stream. Frames are timed by the clock, so a slow render shows up as a pause.
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

/**
 * Offers the finished clip. The download is attempted straight away, and the
 * same blob is left on a visible link: a browser that refuses a download it did
 * not see the user ask for still leaves the file one click away.
 */
export function offerBlob(blob, name, element) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  if (element) {
    if (element.dataset.url) URL.revokeObjectURL(element.dataset.url);
    element.href = url;
    element.download = name;
    element.dataset.url = url;
    element.textContent = `save ${name}  ·  ${(blob.size / 1e6).toFixed(1)} MB`;
    element.hidden = false;
    return;
  }
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}
