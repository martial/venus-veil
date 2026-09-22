"""Venus Veil projector service: veil depth in, generated light out.

    npm run projector            (or .venv-projector/bin/python server/server.py)

Listens on 127.0.0.1:5193. Everything stays on this machine. The dev server
proxies /projector here; the published page talks to it directly.

Binary protocol (no base64, no PNG on the way in):
    POST /generate
      body   = uint32 little-endian JSON length | JSON (utf-8) | depth bytes (size × size, uint8)
      JSON   = { frame_id, size, prompt, seed, guidance, drift, drift_phase, format,
                 engine ('fast' | 'fine' | 'best'), steps, cfg, carry, negative }
      200    → format 'png'  : image/png (top-down)
               format 'rgba' : raw RGBA bytes, rows bottom-up (ready for a GL texture)
               headers X-Frame-Id, X-Inference-Ms, X-Drift-Label, X-Stages
      429    → a frame is already being generated
      503    → model still loading or failed
"""
import gc
import gzip
import json
import os
import re
import struct
import subprocess
import sys
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

PORT = int(os.environ.get('VENUS_PROJECTOR_PORT', '5193'))
DEFAULT_PROMPT = ('a prehistoric Venus figurine carved from weathered limestone, draped in flowing translucent fabric, '
                  'soft museum spotlight, sculptural folds, black background')
# VENUS_ALLOWED_ORIGINS adds origins for a hosted page (a rented GPU box, say).
# Serving the page through headless/serve.mjs avoids the question entirely: the
# page and the service then share one origin.
ALLOWED_ORIGINS = ['http://127.0.0.1:5190', 'http://localhost:5190', 'http://127.0.0.1:5191',
                   'https://martial.github.io']
ALLOWED_ORIGINS += [o.strip() for o in os.environ.get('VENUS_ALLOWED_ORIGINS', '').split(',') if o.strip()]
NEGATIVE_PROMPT = ('blurry, low quality, jpeg artifacts, text, watermark, signature, frame, border, '
                   'flat, washed out, duplicated limbs, deformed hands, cartoon')

ENGINES = ('fast', 'fine', 'best')      # fast = one step (Core ML, or PyTorch on a server), the others multi-step
LIVE_STEPS = 4                          # live frames on a box without the one-step weights
LIVE_WAIT_S = 0.25                      # how long a live frame waits for the engine before it is dropped
ROOMY = sys.platform != 'darwin'        # a server card holds every engine at once; a laptop holds one
IDLE_RELEASE_S = 180                    # the quality engine gives its memory back when unused

state = {'status': 'loading', 'model': 'IDKiro/sdxs-512-dreamshaper + sketch ControlNet', 'device': 'coreml (cpu/gpu/ane)',
         'error': None, 'generated': 0, 'last_ms': None, 'sizes': [256], 'engine': 'fast',
         'engines': ['fast'], 'engine_error': None, 'references': False}
from jobs import Jobs, JobBusy

lock = threading.Lock()
jobs = Jobs()
REFERENCE_ID = re.compile(r'[0-9a-f]{16}')
generator = None          # the fast engine (Core ML on a Mac, PyTorch on a server)
photos = None             # dropped photos as image prompts (reference.py), on a server
quality = None            # the multi-step engine, loaded on demand
last_quality_use = 0.0


class FrameError(ValueError):
    pass


class UnknownReference(LookupError):
    """A frame names a photo this service does not hold (it restarted): the page uploads it again."""


def parse_frame(body, allowed_sizes=(128, 192, 256, 384, 512)):
    """Parse the binary request. Pure: unit-testable without models."""
    if body[:2] == b'\x1f\x8b':
        # a page across the internet gzips its depth map. Unambiguous: a raw body
        # starts with its header length, which can never be 0x8b1f
        try:
            body = gzip.decompress(body)
        except (OSError, EOFError) as error:
            raise FrameError(f'bad gzip body: {error}') from error
    if len(body) < 4:
        raise FrameError('empty request')
    (length,) = struct.unpack('<I', body[:4])
    if length <= 0 or length > 16_000 or 4 + length > len(body):
        raise FrameError('bad header length')
    try:
        meta = json.loads(body[4:4 + length].decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise FrameError(f'bad header: {error}') from error
    size = meta.get('size')
    if size not in allowed_sizes:
        raise FrameError(f'size must be one of {allowed_sizes}')
    pixels = body[4 + length:]
    if len(pixels) != size * size:
        raise FrameError(f'expected {size * size} depth bytes, got {len(pixels)}')
    prompt = str(meta.get('prompt') or DEFAULT_PROMPT)[:1000]
    frame = {
        'frame_id': int(meta.get('frame_id', 0)),
        'size': size,
        'prompt': prompt,
        'seed': max(0, min(2 ** 32 - 1, int(meta.get('seed', 42)))),
        'guidance': max(.1, min(2., float(meta.get('guidance', .85)))),
        'drift': max(0., min(1., float(meta.get('drift', 0)))),
        'drift_phase': max(0., min(1e6, float(meta.get('drift_phase', 0)))),
        'format': meta.get('format') if meta.get('format') in ('rgba', 'jpeg') else 'png',
        'priority': bool(meta.get('priority')),
        'engine': meta.get('engine') if meta.get('engine') in ENGINES else 'fast',
        'cn_scale': max(0.2, min(1.6, float(meta['cn_scale']))) if meta.get('cn_scale') is not None else None,
        'steps': max(1, min(60, int(meta.get('steps') or 0))) if meta.get('steps') else None,
        'cfg': max(0., min(15., float(meta['cfg']))) if meta.get('cfg') is not None else None,
        'carry': max(0., min(0.95, float(meta['carry']))) if meta.get('carry') is not None else None,
        'negative': str(meta.get('negative'))[:600] if meta.get('negative') else None,
        'reset': bool(meta.get('reset')),
        # the dropped photo, by the id /reference gave it, and how strongly it shows
        'reference': meta['reference'] if isinstance(meta.get('reference'), str)
                     and REFERENCE_ID.fullmatch(meta['reference']) else None,
        'reference_scale': max(0., min(2., float(meta.get('reference_scale', 1.)))),
    }
    return frame, pixels


def load_model():
    global generator
    try:
        started = time.perf_counter()
        try:
            from generator import SketchGenerator
        except Exception as error:  # noqa: BLE001 — Core ML is macOS only
            return load_without_coreml(str(error))
        generator = SketchGenerator(256, compute_units=os.environ.get('VENUS_COMPUTE_UNITS', 'ALL'))
        state['sizes'] = generator.sizes or [256]
        generator.warmup(DEFAULT_PROMPT)
        state.update(status='ready', load_s=round(time.perf_counter() - started, 1))
        try:
            import quality as quality_module
            if quality_module.available():
                state['engines'] = list(ENGINES)
        except Exception as error:  # noqa: BLE001
            state['engine_error'] = str(error)
        print(f'projector ready in {state["load_s"]} s · sizes {state["sizes"]} · engines {state["engines"]}', flush=True)
    except Exception as error:  # noqa: BLE001 — report any load failure to the page
        state.update(status='error', error=str(error))
        print(f'projector failed to load: {error}', flush=True)


def free_memory_gb():
    """Free + inactive pages, in GB. The quality engine needs real headroom."""
    if sys.platform != 'darwin':
        return None          # the guard is for a laptop sharing memory with a browser
    try:
        out = subprocess.run(['vm_stat'], capture_output=True, text=True, timeout=5).stdout
        pages = 0
        for line in out.splitlines():
            if line.startswith(('Pages free', 'Pages inactive', 'Pages speculative')):
                pages += int(line.split(':')[1].strip().rstrip('.'))
        return pages * 16384 / (1024 ** 3)
    except Exception:  # noqa: BLE001 — a missing vm_stat must not block a request
        return None


def load_without_coreml(reason):
    """No Core ML (a Linux box, say): the same one-step models run in PyTorch, next to the multi-step ones."""
    import fast_torch
    import quality as quality_module
    engines = (['fast'] if fast_torch.available() else []) + (['fine', 'best'] if quality_module.available() else [])
    if not engines:
        state.update(status='error', error=f'no engine available: {reason}')
        print(f'projector has no engine: {reason}', flush=True)
        return
    started = time.perf_counter()
    import reference
    state.update(engines=engines, engine='unloaded', device=quality_module.pick_device(), sizes=[256, 384, 512, 768],
                 references=reference.available(),
                 model='SDXS DreamShaper + sketch ControlNet (live) · DreamShaper 8 + depth ControlNet (recording)')
    # load them now rather than on the first frame: over a proxy that first frame
    # would time out while the weights come off disk
    global photos
    with lock:
        for name in [e for e in ('fine', 'fast') if e in engines]:
            use_engine(name)
        if state['references']:
            photos = reference.ReferenceStore()     # the photo encoder too: the first drop answers at once
    state.update(status='ready', load_s=round(time.perf_counter() - started, 1))
    print(f'projector ready in {state["load_s"]} s · engines {", ".join(engines)} · {state["device"]} (no Core ML here)',
          flush=True)


def use_engine(name, preset_reset=False):
    """Make `name` the resident engine, unloading the other. Called on a worker thread."""
    global generator, quality, last_quality_use
    if name == 'fast' and 'fast' not in state['engines']:
        name = state['engines'][0]      # no Core ML here: use the multi-step engine
    if name == 'fast':
        if quality is not None and not ROOMY:
            quality.unload()
            quality = None
            print('quality engine released', flush=True)
        if generator is None:
            started = time.perf_counter()
            if ROOMY:
                from fast_torch import TorchSketchGenerator
                generator = TorchSketchGenerator(256)
                generator.warmup(DEFAULT_PROMPT)
            else:
                from generator import SketchGenerator
                generator = SketchGenerator(256, compute_units=os.environ.get('VENUS_COMPUTE_UNITS', 'ALL'))
                state['sizes'] = generator.sizes or [256]
            print(f'fast engine ready in {time.perf_counter() - started:.1f} s', flush=True)
        state['engine'] = 'fast'
        return generator
    if name not in state['engines']:
        raise ValueError(f'engine {name} is not installed; run npm run projector:setup')
    if quality is None:
        free = free_memory_gb()
        # measured: the pipeline loads and runs with ~1.5 GB free, leaning on
        # compression; below that the machine starts thrashing instead
        if free is not None and free < 1.2:
            raise MemoryError(f'only {free:.1f} GB free: close a few windows before recording with {name}')
    import quality as quality_module
    if generator is not None and not ROOMY:
        # on a laptop the two engines are mutually exclusive
        generator.loaded.clear()
        generator = None
        gc.collect()
        print('fast engine released', flush=True)
    if quality is None:
        started = time.perf_counter()
        quality = quality_module.TorchDepthGenerator(preset=name)
        quality.warmup(DEFAULT_PROMPT)
        print(f'quality engine ready in {time.perf_counter() - started:.1f} s ({quality.device})', flush=True)
    quality.set_preset(name)
    if preset_reset:
        quality.reset_carry()
    last_quality_use = time.time()
    state['engine'] = name
    return quality


def encode_png(rgb):
    """Kept here, not in generator.py: that module needs Core ML, which Linux does not have."""
    import io
    from PIL import Image
    buffer = io.BytesIO()
    Image.fromarray(rgb).save(buffer, format='PNG', compress_level=1)
    return buffer.getvalue()


def encode_jpeg(rgb, quality=92):
    import io
    from PIL import Image
    buffer = io.BytesIO()
    # full-resolution colour: chroma subsampling would soften the fine stone detail
    Image.fromarray(rgb).save(buffer, format='JPEG', quality=quality, subsampling=0)
    return buffer.getvalue()


def release_idle_engine():
    """Give the quality engine's memory back when nothing has used it for a while."""
    global quality
    if quality is None or time.time() - last_quality_use < IDLE_RELEASE_S:
        return
    if sys.platform != 'darwin':
        return          # a server card holds it for good: nothing else wants the memory
    if not lock.acquire(blocking=False):
        return
    try:
        quality.unload()
        quality = None
        state['engine'] = 'unloaded'
        print('quality engine released (idle)', flush=True)
    finally:
        lock.release()


def create_app(load=True):
    from fastapi import FastAPI, Request, Response
    from fastapi.middleware.cors import CORSMiddleware
    from starlette.concurrency import run_in_threadpool

    @asynccontextmanager
    async def lifespan(app):
        if load:
            threading.Thread(target=load_model, daemon=True).start()
        yield

    app = FastAPI(title='Venus Veil projector', lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=['GET', 'POST'],
                       allow_headers=['Content-Type'],
                       expose_headers=['X-Frame-Id', 'X-Inference-Ms', 'X-Drift-Label', 'X-Stages', 'X-Engine'])

    @app.middleware('http')
    async def private_network_access(request: Request, call_next):
        # Chrome asks before a public page (GitHub Pages) may reach 127.0.0.1.
        response = await call_next(request)
        if request.headers.get('access-control-request-private-network') == 'true':
            response.headers['Access-Control-Allow-Private-Network'] = 'true'
        return response

    @app.post('/reference')
    async def add_reference(request: Request):
        """A dropped photo, encoded once; frames then name it by the id returned here."""
        if not state.get('references'):
            return Response('this service takes no photo prompts (it needs a GPU server with the adapter)', status_code=501)
        data = await request.body()
        if not data or len(data) > 8_000_000:
            return Response('send one image, up to 8 MB', status_code=400)
        try:
            def work():
                global photos
                if photos is None:
                    import reference
                    photos = reference.ReferenceStore()
                key = photos.add(data)
                return {'id': key, 'caption': photos.describe(key)}
            result = await run_in_threadpool(jobs.run, lock, work)
        except Exception as error:  # noqa: BLE001
            return Response(f'could not read the photo: {error}', status_code=400)
        return result

    @app.get('/health')
    async def health():
        release_idle_engine()
        return dict(state, **jobs.snapshot(), busy=lock.locked(), prompt_drift=True, default_prompt=DEFAULT_PROMPT,
                    negative_prompt=NEGATIVE_PROMPT)

    @app.post('/generate')
    async def generate(request: Request):
        if state['status'] != 'ready':
            return Response(state['error'] or 'model is still loading', status_code=503)
        try:
            frame, pixels = parse_frame(await request.body(), tuple(state['sizes']))
        except FrameError as error:
            return Response(str(error), status_code=400)
        # A recording waits its turn; live frames are dropped rather than queued.
        # The wait happens on a worker thread: blocking here would stall every
        # other request, health included.
        # loading a multi-step engine takes half a minute and happens under this
        # lock, so a waiting recording must be patient
        # A live frame may wait a moment: a page across the internet keeps several
        # requests on the wire, and they arrive a few milliseconds apart.
        try:
            def work():
                import numpy as np
                engine = use_engine(frame['engine'], preset_reset=frame['reset'])
                depth = np.frombuffer(pixels, dtype=np.uint8).reshape(frame['size'], frame['size'])
                photo = None
                if frame['reference']:
                    photo = photos.get(frame['reference']) if photos else None
                    if photo is None:
                        raise UnknownReference(frame['reference'])
                with_photo = {'photo': photo, 'photo_scale': frame['reference_scale']} if photos else {}
                if state['engine'] == 'fast':
                    if frame['size'] != engine.size:
                        engine.load_size(frame['size'])
                    rgb, stages = engine.generate(depth, frame['prompt'], frame['seed'], frame['guidance'],
                                                  frame['drift'], frame['drift_phase'], **with_photo)
                else:
                    # a live frame on a box without Core ML: the multi-step engine stands in,
                    # at the few steps LCM needs, so live projection keeps moving
                    steps = frame['steps'] or (LIVE_STEPS if frame['engine'] == 'fast' else None)
                    rgb, stages = engine.generate(depth, frame['prompt'], frame['seed'], frame['guidance'],
                                                  frame['drift'], frame['drift_phase'], steps=steps,
                                                  cfg=frame['cfg'], carry=frame['carry'], negative=frame['negative'],
                                                  cn_scale=frame['cn_scale'], **with_photo)
                if frame['format'] == 'rgba':
                    rgba = np.empty((rgb.shape[0], rgb.shape[1], 4), dtype=np.uint8)
                    rgba[..., :3] = rgb[::-1]
                    rgba[..., 3] = 255
                    return rgba.tobytes(), stages
                if frame['format'] == 'jpeg':
                    # for a page across the internet: a tenth of the bytes, rows in the
                    # same bottom-up order as rgba so the page treats both alike
                    return encode_jpeg(np.ascontiguousarray(rgb[::-1])), stages
                return encode_png(rgb), stages
            payload, stages = await run_in_threadpool(jobs.run, lock, work, 300 if frame['priority'] else LIVE_WAIT_S)
        except JobBusy:
            return Response('one frame is already being generated', status_code=429)
        except UnknownReference:
            return Response('unknown reference: upload the photo again', status_code=409)
        except Exception as error:  # noqa: BLE001
            return Response(f'generation failed: {error}', status_code=500)
        state['generated'] += 1
        state['last_ms'] = stages['total_ms']
        engine_object = quality if frame['engine'] != 'fast' else generator
        media = {'png': 'image/png', 'jpeg': 'image/jpeg'}.get(frame['format'], 'application/octet-stream')
        return Response(payload, media_type=media, headers={
            'X-Frame-Id': str(frame['frame_id']),
            'X-Inference-Ms': str(stages['total_ms']),
            'X-Engine': frame['engine'],
            'X-Drift-Label': getattr(engine_object, 'drift_label', frame['engine']),
            'X-Stages': json.dumps(stages),
            'Cache-Control': 'no-store',
        })

    return app


if __name__ == '__main__':
    import uvicorn
    # bind to the loopback: expose the page server instead, which proxies /projector
    uvicorn.run(create_app(), host=os.environ.get('VENUS_HOST', '127.0.0.1'), port=PORT,
                log_level='warning', access_log=False)
