"""Small loopback bridge; the live service never imports the optional pipelines."""
import base64
import io
import json
import os
import time
import urllib.error
import urllib.request

from advanced_models import catalog

URL = 'http://127.0.0.1:' + os.environ.get('VENUS_ADVANCED_PORT', '5194')
_cached = None
_checked = 0.


def models():
    global _cached, _checked
    if _cached is not None and time.monotonic() - _checked < 5:
        return _cached
    result = catalog()
    try:
        with urllib.request.urlopen(URL + '/health', timeout=.5) as response:
            result = json.load(response)['models']
    except (OSError, ValueError, KeyError):
        for spec in result.values():
            spec.update(available=False, reason='Optional model service is not running.')
    _cached, _checked = result, time.monotonic()
    return result


def generate(frame, depth, embedding=None, photo=None):
    import numpy as np
    from PIL import Image
    body = {'frame': frame, 'depth': base64.b64encode(depth.tobytes()).decode('ascii')}
    if embedding is not None and frame['engine'] == 'sdxl':
        body['embedding'] = base64.b64encode(embedding.detach().cpu().numpy().astype(np.float16).tobytes()).decode('ascii')
    if photo is not None and frame['engine'] == 'klein':
        body['photo'] = base64.b64encode(photo).decode('ascii')
    request = urllib.request.Request(URL + '/generate', data=json.dumps(body).encode(),
                                     headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=590) as response:
            stages = json.loads(response.headers['X-Stages'])
            return np.array(Image.open(io.BytesIO(response.read())).convert('RGB')), stages
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode('utf-8')[:1500]) from error
    except OSError as error:
        raise RuntimeError('Optional model service is unavailable. Check the advanced worker log.') from error
