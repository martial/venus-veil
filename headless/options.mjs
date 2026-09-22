/**
 * Command-line options for the headless renderer. Pure parsing and validation,
 * so it can be unit-tested without a browser.
 */

export const DEFAULTS = {
  look: 'limestone',
  engine: 'best',
  steps: 0,               // 0 = the engine's own default
  seconds: 8,
  fps: 60,
  imagesPerSecond: 6,
  width: 1920,
  height: 1080,
  generated: 512,
  seed: 42,
  carry: 0,
  orbit: 40,
  hold: 0.2,
  prompt: '',             // empty = the look's own prompt
  sculpture: '',          // path to a photo; empty = the bundled sample
  out: 'venus-veil.mp4',
  frames: '',             // directory to keep the PNG sequence in
  keepFrames: false,
  service: 'http://127.0.0.1:5193',
  page: 'http://127.0.0.1:5191',
  crf: 16,
  gpu: true,
  timeoutMs: 15 * 60 * 1000,
};

export const HELP = `venus-veil headless renderer

  node headless/render.mjs [options]

  --look <name>          limestone | bronze | ivory | obsidian | wandering  (${DEFAULTS.look})
  --engine <name>        fast | fine | best | sdxl | klein | flux            (${DEFAULTS.engine})
  --steps <n>            override the engine's step count
  --seconds <n>          clip length                                        (${DEFAULTS.seconds})
  --fps <n>              frames per second of the file                      (${DEFAULTS.fps})
  --images-per-second <n> generated images per second                       (${DEFAULTS.imagesPerSecond})
  --width / --height     frame size                                         (${DEFAULTS.width}x${DEFAULTS.height})
  --generated <n>        diffusion resolution: 256 | 384 | 512 | 768        (${DEFAULTS.generated})
  --seed <n>             fixed noise seed                                   (${DEFAULTS.seed})
  --carry <0..0.9>       how much of the previous frame each one starts from (${DEFAULTS.carry})
  --orbit <deg>          camera travel over the clip                        (${DEFAULTS.orbit})
  --hold <0..0.8>        fraction of the clip the camera holds still        (${DEFAULTS.hold})
  --prompt "<text>"      override the look's prompt
  --sculpture <file>     photo to weave into the veil
  --out <file.mp4>       output file                                        (${DEFAULTS.out})
  --frames <dir>         keep the PNG sequence here
  --keep-frames          do not delete the frames after encoding
  --service <url>        diffusion service                                  (${DEFAULTS.service})
  --page <url>           where the built app is served                      (${DEFAULTS.page})
  --crf <n>              x264 quality, lower is better                      (${DEFAULTS.crf})
  --no-gpu               software rendering (much slower, works anywhere)
  --help
`;

const NUMBERS = new Set(['steps', 'seconds', 'fps', 'imagesPerSecond', 'width', 'height', 'generated',
  'seed', 'carry', 'orbit', 'hold', 'crf', 'timeoutMs']);
const LOOKS = ['limestone', 'bronze', 'ivory', 'obsidian', 'wandering'];
const ENGINES = ['fast', 'fine', 'best', 'sdxl', 'klein', 'flux'];

const camel = flag => flag.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export function parseArgs(argv = []) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    if (token === '--help' || token === '-h') return { help: true, ...options };
    if (token === '--keep-frames') { options.keepFrames = true; continue; }
    if (token === '--no-gpu') { options.gpu = false; continue; }
    const key = camel(token);
    if (!(key in DEFAULTS)) throw new Error(`unknown option: ${token}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`${token} needs a value`);
    options[key] = NUMBERS.has(key) ? Number(value) : value;
    if (NUMBERS.has(key) && !Number.isFinite(options[key])) throw new Error(`${token} needs a number`);
  }
  return validate(options);
}

export function validate(options) {
  const o = { ...options };
  if (!LOOKS.includes(o.look)) throw new Error(`look must be one of: ${LOOKS.join(', ')}`);
  if (!ENGINES.includes(o.engine)) throw new Error(`engine must be one of: ${ENGINES.join(', ')}`);
  o.fps = Math.min(120, Math.max(1, Math.round(o.fps)));
  o.seconds = Math.min(600, Math.max(1 / o.fps, o.seconds));
  o.imagesPerSecond = Math.min(o.fps, Math.max(0.25, o.imagesPerSecond));
  // H.264 needs even dimensions
  o.width = Math.max(2, Math.floor(o.width / 2) * 2);
  o.height = Math.max(2, Math.floor(o.height / 2) * 2);
  if (![256, 384, 512, 768].includes(o.generated)) throw new Error('generated must be 256, 384, 512 or 768');
  o.carry = Math.min(0.9, Math.max(0, o.carry));
  o.hold = Math.min(0.8, Math.max(0, o.hold));
  o.crf = Math.min(51, Math.max(0, Math.round(o.crf)));
  o.steps = Math.max(0, Math.round(o.steps));
  o.frameCount = Math.max(1, Math.round(o.seconds * o.fps));
  o.interval = Math.max(1, Math.round(o.fps / o.imagesPerSecond));
  o.imageCount = Math.ceil(o.frameCount / o.interval);
  return o;
}

/** Rough wall-clock estimate, from measured seconds per generated image. */
export function estimate(options, secondsPerImage = { fast: 0.15, fine: 11, best: 32, sdxl: 2, klein: 3, flux: 15 }) {
  const per = secondsPerImage[options.engine] ?? 10;
  const seconds = options.imageCount * per + options.frameCount * 0.25;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return { seconds, text: hours ? `${hours} h ${String(minutes).padStart(2, '0')}` : `${minutes} min` };
}
