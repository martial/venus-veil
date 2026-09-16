"""Measure seconds per frame for each installed engine.

    .venv-projector/bin/python server/bench_engines.py [--sizes 512 768] [--frames 4]

Runs against a service already listening on 127.0.0.1:5193, so the numbers
include the whole round trip the browser sees.
"""
import argparse
import json
import struct
import time
import urllib.error
import urllib.request

import numpy as np

URL = 'http://127.0.0.1:5193'
PROMPT = ('a prehistoric Venus figurine, full body, heavy breasts, round belly, braided head, '
          'carved from weathered limestone, museum spotlight, black background')


def depth_map(size):
    yy, xx = np.mgrid[0:size, 0:size]
    body = ((xx - size / 2) / (size * 0.26)) ** 2 + ((yy - size / 2) / (size * 0.42)) ** 2
    return np.where(body < 1, 40 + 200 * np.clip(1 - body, 0, 1), 0).astype(np.uint8)


def request(engine, size, frame_id, reset=False, **extra):
    meta = dict(frame_id=frame_id, size=size, prompt=PROMPT, format='rgba', engine=engine,
                priority=True, reset=reset, **extra)
    header = json.dumps(meta).encode()
    body = struct.pack('<I', len(header)) + header + depth_map(size).tobytes()
    started = time.perf_counter()
    req = urllib.request.Request(f'{URL}/generate', data=body, headers={'Content-Type': 'application/octet-stream'})
    with urllib.request.urlopen(req, timeout=600) as response:
        payload = response.read()
        stages = json.loads(response.headers.get('X-Stages') or '{}')
    return (time.perf_counter() - started) * 1000, stages, len(payload)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--sizes', nargs='+', type=int, default=[512])
    parser.add_argument('--frames', type=int, default=4)
    parser.add_argument('--engines', nargs='+', default=None)
    args = parser.parse_args()
    health = json.loads(urllib.request.urlopen(f'{URL}/health', timeout=10).read())
    engines = args.engines or health.get('engines', ['fast'])
    print(f'engines: {engines} · sizes {args.sizes}', flush=True)
    for engine in engines:
        for size in args.sizes:
            if engine == 'fast' and size not in health.get('sizes', []):
                print(f'{engine} {size}px: no compiled model, skipped', flush=True)
                continue
            try:
                times = []
                for frame in range(args.frames + 1):
                    ms, stages, payload = request(engine, size, frame, reset=(frame == 0))
                    if frame:      # the first frame pays for loading and the clean start
                        times.append(ms)
                median = sorted(times)[len(times) // 2]
                print(json.dumps({'engine': engine, 'size': size, 'round_trip_ms': round(median, 1),
                                  'per_frame_s': round(median / 1000, 2), 'images_per_s': round(1000 / median, 2),
                                  'stages': stages}), flush=True)
            except urllib.error.HTTPError as error:
                print(f'{engine} {size}px failed: {error.code} {error.read()[:200]!r}', flush=True)


if __name__ == '__main__':
    main()
