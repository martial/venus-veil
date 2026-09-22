import json
import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from server import FrameError, parse_frame  # noqa: E402


def pack(meta, pixels):
    header = json.dumps(meta).encode('utf-8')
    return struct.pack('<I', len(header)) + header + pixels


class ParseFrameTest(unittest.TestCase):
    def test_valid_frame_with_unicode_prompt(self):
        body = pack({'frame_id': 7, 'size': 256, 'prompt': 'Vénus de Willendorf, drapé', 'seed': 3, 'guidance': .9,
                     'drift': .4, 'drift_phase': 2.5}, bytes(256 * 256))
        frame, pixels = parse_frame(body, (256,))
        self.assertEqual(frame['frame_id'], 7)
        self.assertEqual(frame['prompt'], 'Vénus de Willendorf, drapé')
        self.assertEqual(len(pixels), 256 * 256)
        self.assertEqual(frame['format'], 'png')
        rgba, _ = parse_frame(pack({'size': 256, 'format': 'rgba'}, bytes(256 * 256)), (256,))
        self.assertEqual(rgba['format'], 'rgba')

    def test_values_are_clamped(self):
        frame, _ = parse_frame(pack({'size': 256, 'seed': -5, 'guidance': 50, 'drift': 3}, bytes(256 * 256)), (256,))
        self.assertEqual(frame['seed'], 0)
        self.assertEqual(frame['guidance'], 2.)
        self.assertEqual(frame['drift'], 1.)

    def test_rejects_bad_sizes_and_truncation(self):
        with self.assertRaises(FrameError):
            parse_frame(pack({'size': 300}, bytes(300 * 300)), (256,))
        with self.assertRaises(FrameError):
            parse_frame(pack({'size': 256}, bytes(100)), (256,))
        with self.assertRaises(FrameError):
            parse_frame(b'\x01\x02', (256,))
        with self.assertRaises(FrameError):
            parse_frame(struct.pack('<I', 999999) + b'{}', (256,))


class EngineTest(unittest.TestCase):
    def test_engine_and_sampling_fields(self):
        frame, _ = parse_frame(pack({'size': 256, 'engine': 'best', 'steps': 18, 'cfg': 4.0,
                                     'carry': 0.45, 'cn_scale': 0.65, 'reset': True}, bytes(256 * 256)), (256,))
        self.assertEqual(frame['engine'], 'best')
        self.assertEqual(frame['steps'], 18)
        self.assertEqual(frame['cfg'], 4.0)
        self.assertEqual(frame['carry'], 0.45)
        self.assertEqual(frame['cn_scale'], 0.65)
        self.assertTrue(frame['reset'])

    def test_unknown_engine_falls_back_to_the_live_one(self):
        frame, _ = parse_frame(pack({'size': 256, 'engine': 'wishful'}, bytes(256 * 256)), (256,))
        self.assertEqual(frame['engine'], 'fast')
        frame, _ = parse_frame(pack({'size': 256}, bytes(256 * 256)), (256,))
        self.assertEqual(frame['engine'], 'fast')
        self.assertIsNone(frame['steps'])
        self.assertIsNone(frame['cfg'])

    def test_sampling_values_are_clamped(self):
        frame, _ = parse_frame(pack({'size': 256, 'engine': 'fine', 'steps': 500, 'cfg': 99,
                                     'carry': 5, 'cn_scale': 9}, bytes(256 * 256)), (256,))
        self.assertEqual(frame['steps'], 60)
        self.assertEqual(frame['cfg'], 15.)
        self.assertEqual(frame['carry'], .95)
        self.assertEqual(frame['cn_scale'], 1.6)


class MemoryGuardTest(unittest.TestCase):
    def test_free_memory_reads_a_plausible_number(self):
        from server import free_memory_gb
        free = free_memory_gb()
        self.assertTrue(free is None or 0 <= free < 1024, free)


class HealthTest(unittest.TestCase):
    def test_health_and_private_network_preflight_without_model(self):
        from fastapi.testclient import TestClient
        from server import create_app
        client = TestClient(create_app(load=False))
        health = client.get('/health').json()
        self.assertIn(health['status'], ('loading', 'ready', 'error'))
        self.assertIn('fast', health['engines'])
        self.assertIn('engine', health)
        response = client.options('/generate', headers={
            'Origin': 'https://martial.github.io', 'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type', 'Access-Control-Request-Private-Network': 'true'})
        self.assertEqual(response.headers.get('access-control-allow-private-network'), 'true')
        self.assertEqual(response.headers.get('access-control-allow-origin'), 'https://martial.github.io')
        self.assertEqual(client.post('/generate', content=b'').status_code, 503)


class GzipBodyTest(unittest.TestCase):
    def test_gzipped_body_parses_like_raw(self):
        import gzip
        raw = pack({'size': 256, 'prompt': 'stone'}, bytes(range(256)) * 256)
        a, pixels_a = parse_frame(raw, (256,))
        b, pixels_b = parse_frame(gzip.compress(raw), (256,))
        self.assertEqual(a['prompt'], b['prompt'])
        self.assertEqual(bytes(pixels_a), bytes(pixels_b))

    def test_broken_gzip_is_a_frame_error(self):
        with self.assertRaises(FrameError):
            parse_frame(b'\x1f\x8b' + b'not gzip at all', (256,))


class ReferenceFieldTest(unittest.TestCase):
    def test_reference_upload_returns_the_caption_for_that_photo(self):
        from unittest.mock import patch, Mock
        from fastapi.testclient import TestClient
        import server
        photos = Mock()
        photos.add.return_value = '0123456789abcdef'
        photos.describe.return_value = 'a green dragon'
        with patch.dict(server.state, references=True), patch.object(server, 'photos', photos):
            client = TestClient(server.create_app(load=False))
            response = client.post('/reference', content=b'photo bytes')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'id': '0123456789abcdef', 'caption': 'a green dragon'})
        photos.add.assert_called_once_with(b'photo bytes')
        photos.describe.assert_called_once_with('0123456789abcdef')

    def test_photo_id_and_strength(self):
        frame, _ = parse_frame(pack({'size': 256, 'reference': '0123456789abcdef', 'reference_scale': 5}, bytes(256 * 256)), (256,))
        self.assertEqual(frame['reference'], '0123456789abcdef')
        self.assertEqual(frame['reference_scale'], 2.0)
        for bad in ('../etc/passwd', 'ABCDEF0123456789', 123, '0123'):
            frame, _ = parse_frame(pack({'size': 256, 'reference': bad}, bytes(256 * 256)), (256,))
            self.assertIsNone(frame['reference'], bad)
        self.assertEqual(frame['reference_scale'], 1.0)

    def test_reference_refused_without_adapter(self):
        from fastapi.testclient import TestClient
        from server import create_app
        client = TestClient(create_app(load=False))
        self.assertEqual(client.post('/reference', content=b'\xff\xd8 not really').status_code, 501)


class EncodeTest(unittest.TestCase):
    def test_png_without_core_ml(self):
        # a Linux service has no coremltools: answering must not import generator.py
        import numpy as np
        from server import encode_png
        png = encode_png(np.zeros((8, 8, 3), dtype=np.uint8))
        self.assertTrue(png.startswith(b'\x89PNG'))
        self.assertNotIn('generator', sys.modules)

    def test_jpeg_for_remote_pages(self):
        import numpy as np
        from server import encode_jpeg
        frame, _ = parse_frame(pack({'size': 256, 'format': 'jpeg'}, bytes(256 * 256)), (256,))
        self.assertEqual(frame['format'], 'jpeg')
        jpeg = encode_jpeg(np.full((64, 64, 3), 128, dtype=np.uint8))
        self.assertTrue(jpeg.startswith(b'\xff\xd8'))


class SketchEdgesTest(unittest.TestCase):
    def test_torch_edges_match_the_core_ml_engine(self):
        # the pod's one-step engine must trace depth exactly as the Mac's does,
        # or the same look would render differently there
        import numpy as np
        import torch
        from fast_torch import sketch_edges
        rng = np.random.default_rng(3)
        depth = (rng.random((64, 64)) * 255).astype(np.uint8)
        depth[:8] = 0
        gray = depth.astype(np.float32) / 255
        padded = np.pad(gray, 1)
        gx = np.abs(padded[1:-1, 2:] - padded[1:-1, :-2])
        gy = np.abs(padded[2:, 1:-1] - padded[:-2, 1:-1])
        for guidance in (.5, .85, 1.4):
            expected = np.clip((gx + gy) * 7 * (guidance / .85), 0, 1)
            got = sketch_edges(torch.from_numpy(gray), guidance).numpy()
            np.testing.assert_allclose(got, expected, atol=1e-6)


class PhotoCarryTest(unittest.TestCase):
    def test_a_new_photo_resets_recording_history_and_colour(self):
        from unittest.mock import Mock
        import numpy as np
        from PIL import Image
        from quality import TorchDepthGenerator, PRESETS
        engine = TorchDepthGenerator.__new__(TorchDepthGenerator)
        engine.device = 'cpu'
        engine.prompt = None
        engine.preset = 'best'
        engine.referencing = False
        engine.defaults = PRESETS['best']
        engine.previous = Image.new('RGB', (64, 64), 'red')
        engine.previous_photo = object()
        engine.anchor = (np.ones(3), np.ones(3))
        engine.hold_colour = True
        engine.pipe = Mock(return_value=Mock(images=[np.full((64, 64, 3), 0.5, dtype=np.float32)]))
        photo = object()
        engine.generate(np.full((64, 64), 160, dtype=np.uint8), 'a dragon', photo=photo, carry=0.45)
        self.assertEqual(engine.pipe.call_args.kwargs['strength'], 1.0)
        self.assertIs(engine.previous_photo, photo)
        engine.generate(np.full((64, 64), 160, dtype=np.uint8), 'a dragon', photo=photo, carry=0.45)
        self.assertAlmostEqual(engine.pipe.call_args.kwargs['strength'], 0.55)
        engine.generate(np.full((64, 64), 160, dtype=np.uint8), 'a sculpture', photo=None, carry=0.45)
        self.assertEqual(engine.pipe.call_args.kwargs['strength'], 1.0)


if __name__ == '__main__':
    unittest.main()
