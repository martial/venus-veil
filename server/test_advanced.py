import unittest
from unittest.mock import Mock, patch

import numpy as np
from fastapi.testclient import TestClient

import server
from test_server import pack


class AdvancedRoutingTest(unittest.TestCase):
    def test_different_browsers_do_not_carry_each_others_images(self):
        engine = Mock()
        engine.generate.return_value = (np.zeros((256, 256, 3), dtype=np.uint8), {'total_ms': 100})
        with patch.dict(server.state, status='ready', engine='fine', sizes=[256]), \
                patch.object(server, 'quality_sequence', None), patch.object(server, 'photos', None), \
                patch.object(server, 'use_engine', return_value=engine):
            client = TestClient(server.create_app(load=False))
            for sequence in ('browser-a', 'browser-a', 'browser-b', 'browser-a'):
                response = client.post('/generate', content=pack(
                    {'engine': 'fine', 'size': 256, 'sequence': sequence}, bytes(256 * 256)))
                self.assertEqual(response.status_code, 200)
        self.assertEqual(engine.reset_carry.call_count, 3)

    def test_optional_engines_are_preserved_in_frame_protocol(self):
        for name in ('sdxl', 'klein', 'flux'):
            frame, _ = server.parse_frame(pack({'engine': name, 'size': 256}, bytes(256 * 256)))
            self.assertEqual(frame['engine'], name)

    def test_model_controls_survive_frame_protocol_and_resolution_is_bounded(self):
        for requested, expected in ((512, 512), (1024, 1024), (999999, 1024), (-5, 512)):
            frame, _ = server.parse_frame(pack({'engine': 'sdxl', 'size': 256,
                'render_size': requested, 'cfg': 0, 'cn_scale': 1.2, 'reference_scale': 0.4,
                'negative': 'plastic'}, bytes(256 * 256)))
            self.assertEqual(frame['render_size'], expected)
            self.assertEqual(frame['cfg'], 0)
            self.assertEqual(frame['cn_scale'], 1.2)
            self.assertEqual(frame['reference_scale'], 0.4)
            self.assertEqual(frame['negative'], 'plastic')

    def test_unavailable_model_does_not_silently_use_live_engine(self):
        import advanced_client
        with patch.object(advanced_client, 'models', return_value={'flux': {'label': 'FLUX', 'available': False, 'reason': 'Need weights'}}):
            with self.assertRaisesRegex(ValueError, 'Need weights'):
                server.use_engine('flux')

    def test_bridge_receives_the_matching_depth_embedding_and_original_photo(self):
        import advanced_client
        depth = np.arange(256 * 256, dtype=np.uint8).reshape(256, 256)
        photos = Mock()
        embedding = object()
        photos.get.return_value = embedding
        photos.image.return_value = b'original reference photo'
        catalog = {'klein': {'label': 'Klein', 'available': True}}
        result = (np.zeros((256, 256, 3), dtype=np.uint8), {'total_ms': 100})
        with patch.dict(server.state, status='ready', engine='fast', sizes=[256]), patch.object(server, 'photos', photos), \
                patch.object(advanced_client, 'models', return_value=catalog), patch.object(advanced_client, 'generate', return_value=result) as generate:
            response = TestClient(server.create_app(load=False)).post('/generate', content=pack(
                {'engine': 'klein', 'size': 256, 'reference': '0123456789abcdef', 'priority': True}, depth.tobytes()))
        self.assertEqual(response.status_code, 200, response.text[:100])
        self.assertEqual(response.headers['X-Engine'], 'klein')
        frame, passed_depth, passed_embedding, passed_photo = generate.call_args.args
        self.assertEqual(frame['reference'], '0123456789abcdef')
        np.testing.assert_array_equal(passed_depth, depth)
        self.assertIs(passed_embedding, embedding)
        self.assertEqual(passed_photo, b'original reference photo')

    def test_health_only_advertises_installed_running_optional_models(self):
        import advanced_client
        catalog = {'sdxl': {'available': True}, 'flux': {'available': False, 'reason': 'Need weights'}}
        with patch.dict(server.state, engines=['fast', 'fine', 'best']), patch.object(advanced_client, 'models', return_value=catalog):
            health = TestClient(server.create_app(load=False)).get('/health').json()
        self.assertIn('sdxl', health['engines'])
        self.assertNotIn('flux', health['engines'])
        self.assertEqual(health['models']['flux']['reason'], 'Need weights')
