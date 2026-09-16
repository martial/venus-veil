"""Venus Veil projector service: veil depth in, generated light out.

    npm run projector            (or .venv-projector/bin/python server/server.py)

Listens on 127.0.0.1:5193. Everything stays on this machine. The dev server
proxies /projector here; the published page talks to it directly.

Binary protocol (no base64, no PNG on the way in):
    POST /generate
      body   = uint32 little-endian JSON length | JSON (utf-8) | depth bytes (size × size, uint8)
      JSON   = { frame_id, size, prompt, seed, guidance, drift, drift_phase, format }
      200    → format 'png'  : image/png (top-down)
               format 'rgba' : raw RGBA bytes, rows bottom-up (ready for a GL texture)
               headers X-Frame-Id, X-Inference-Ms, X-Drift-Label, X-Stages
      429    → a frame is already being generated
      503    → model still loading or failed
"""
import json
import os
import struct
import sys
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

PORT = int(os.environ.get('VENUS_PROJECTOR_PORT', '5193'))
DEFAULT_PROMPT = ('a prehistoric Venus figurine carved from weathered limestone, draped in flowing translucent fabric, '
                  'soft museum spotlight, sculptural folds, black background')
ALLOWED_ORIGINS = ['http://127.0.0.1:5190', 'http://localhost:5190', 'https://martial.github.io']

state = {'status': 'loading', 'model': 'IDKiro/sdxs-512-dreamshaper + sketch ControlNet', 'device': 'coreml (cpu/gpu/ane)',
         'error': None, 'generated': 0, 'last_ms': None, 'sizes': [256]}
lock = threading.Lock()
generator = None


class FrameError(ValueError):
    pass


def parse_frame(body, allowed_sizes=(128, 192, 256, 384, 512)):
    """Parse the binary request. Pure: unit-testable without models."""
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
        'format': 'rgba' if meta.get('format') == 'rgba' else 'png',
        'priority': bool(meta.get('priority')),
    }
    return frame, pixels


def load_model():
    global generator
    try:
        from generator import SketchGenerator
        started = time.perf_counter()
        generator = SketchGenerator(256, compute_units=os.environ.get('VENUS_COMPUTE_UNITS', 'ALL'))
        state['sizes'] = generator.sizes or [256]
        generator.warmup(DEFAULT_PROMPT)
        state.update(status='ready', load_s=round(time.perf_counter() - started, 1))
        print(f'projector ready in {state["load_s"]} s · sizes {state["sizes"]}', flush=True)
    except Exception as error:  # noqa: BLE001 — report any load failure to the page
        state.update(status='error', error=str(error))
        print(f'projector failed to load: {error}', flush=True)


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
                       expose_headers=['X-Frame-Id', 'X-Inference-Ms', 'X-Drift-Label', 'X-Stages'])

    @app.middleware('http')
    async def private_network_access(request: Request, call_next):
        # Chrome asks before a public page (GitHub Pages) may reach 127.0.0.1.
        response = await call_next(request)
        if request.headers.get('access-control-request-private-network') == 'true':
            response.headers['Access-Control-Allow-Private-Network'] = 'true'
        return response

    @app.get('/health')
    async def health():
        return dict(state, busy=lock.locked(), prompt_drift=True, default_prompt=DEFAULT_PROMPT)

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
        acquired = await run_in_threadpool(
            lambda: lock.acquire(blocking=frame['priority'], timeout=30 if frame['priority'] else -1))
        if not acquired:
            return Response('one frame is already being generated', status_code=429)
        try:
            def work():
                import numpy as np
                from generator import encode_png
                if frame['size'] != generator.size:
                    generator.load_size(frame['size'])
                depth = np.frombuffer(pixels, dtype=np.uint8).reshape(frame['size'], frame['size'])
                rgb, stages = generator.generate(depth, frame['prompt'], frame['seed'], frame['guidance'],
                                                 frame['drift'], frame['drift_phase'])
                if frame['format'] == 'rgba':
                    rgba = np.empty((rgb.shape[0], rgb.shape[1], 4), dtype=np.uint8)
                    rgba[..., :3] = rgb[::-1]
                    rgba[..., 3] = 255
                    return rgba.tobytes(), stages
                return encode_png(rgb), stages
            payload, stages = await run_in_threadpool(work)
        except Exception as error:  # noqa: BLE001
            return Response(f'generation failed: {error}', status_code=500)
        finally:
            lock.release()
        state['generated'] += 1
        state['last_ms'] = stages['total_ms']
        return Response(payload, media_type='image/png' if frame['format'] == 'png' else 'application/octet-stream', headers={
            'X-Frame-Id': str(frame['frame_id']),
            'X-Inference-Ms': str(stages['total_ms']),
            'X-Drift-Label': generator.drift_label,
            'X-Stages': json.dumps(stages),
            'Cache-Control': 'no-store',
        })

    return app


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(create_app(), host='127.0.0.1', port=PORT, log_level='warning', access_log=False)
