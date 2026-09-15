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


class HealthTest(unittest.TestCase):
    def test_health_and_private_network_preflight_without_model(self):
        from fastapi.testclient import TestClient
        from server import create_app
        client = TestClient(create_app(load=False))
        health = client.get('/health').json()
        self.assertIn(health['status'], ('loading', 'ready', 'error'))
        response = client.options('/generate', headers={
            'Origin': 'https://martial.github.io', 'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type', 'Access-Control-Request-Private-Network': 'true'})
        self.assertEqual(response.headers.get('access-control-allow-private-network'), 'true')
        self.assertEqual(response.headers.get('access-control-allow-origin'), 'https://martial.github.io')
        self.assertEqual(client.post('/generate', content=b'').status_code, 503)


if __name__ == '__main__':
    unittest.main()
