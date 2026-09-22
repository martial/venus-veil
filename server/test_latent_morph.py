import unittest
from types import SimpleNamespace

import torch

from latent_morph import flux_morph_latents, morph_noise
from server import FrameError, parse_frame
from test_server import pack


class LatentMorphTest(unittest.TestCase):
    def setUp(self):
        self.base = torch.randn((1, 16, 64, 64), generator=torch.Generator().manual_seed(42))

    def test_disabled_and_initial_phase_preserve_original_noise(self):
        self.assertTrue(torch.equal(morph_noise(self.base, 42, 5, 0), self.base))
        self.assertTrue(torch.equal(morph_noise(self.base, 42, 0, 1), self.base))

    def test_frames_are_repeatable_even_when_other_sessions_interleave(self):
        expected = morph_noise(self.base, 42, 2.5, .7)
        morph_noise(self.base, 91, 83.2, .8)
        self.assertTrue(torch.equal(expected, morph_noise(self.base, 42, 2.5, .7)))
        self.assertFalse(torch.equal(expected, morph_noise(self.base, 43, 2.5, .7)))

    def test_noise_does_not_collapse_at_midpoints_and_boundaries_are_continuous(self):
        for phase in (0.5, 1., 1.5, 2.5):
            noise = morph_noise(self.base, 42, phase, 1)
            self.assertAlmostEqual(float(noise.std()), 1., delta=.03)
        before = morph_noise(self.base, 42, 1 - 1e-4, .7)
        after = morph_noise(self.base, 42, 1 + 1e-4, .7)
        self.assertLess(float((before - after).abs().max()), 1e-5)
        near = morph_noise(self.base, 42, .51, .7)
        centre = morph_noise(self.base, 42, .5, .7)
        far = morph_noise(self.base, 42, 1.5, .7)
        self.assertLess(float((near - centre).square().mean()), float((far - centre).square().mean()) / 100)

    def test_amount_limits_deviation_from_the_original_seed(self):
        gentle = morph_noise(self.base, 42, 1.5, .2)
        dream = morph_noise(self.base, 42, 1.5, .9)
        self.assertLess(float((gentle - self.base).square().mean()), float((dream - self.base).square().mean()))

    def test_klein_layout_and_rng_match_its_native_prepare_latents(self):
        pipe = SimpleNamespace(transformer=SimpleNamespace(config=SimpleNamespace(in_channels=128), dtype=torch.bfloat16),
                               vae_scale_factor=8, _execution_device='cpu')
        generator = torch.Generator().manual_seed(42)
        result = flux_morph_latents(pipe, 'klein', 512, generator, 0, .5)
        expected_generator = torch.Generator().manual_seed(42)
        expected = torch.randn((1, 128, 32, 32), dtype=torch.bfloat16, generator=expected_generator)
        self.assertTrue(torch.equal(result, expected))
        self.assertTrue(torch.equal(generator.get_state(), expected_generator.get_state()))

    def test_flux_depth_packs_noise_without_changing_control_image_rng(self):
        def pack_latents(noise, batch, channels, height, width):
            return noise.view(batch, channels, height // 2, 2, width // 2, 2).permute(0, 2, 4, 1, 3, 5).reshape(batch, -1, channels * 4)
        pipe = SimpleNamespace(transformer=SimpleNamespace(config=SimpleNamespace(in_channels=128), dtype=torch.bfloat16),
                               vae_scale_factor=8, _execution_device='cpu', _pack_latents=pack_latents)
        generator = torch.Generator().manual_seed(42)
        before = generator.get_state().clone()
        result = flux_morph_latents(pipe, 'flux', 512, generator, .5, .5)
        self.assertEqual(tuple(result.shape), (1, 1024, 64))
        self.assertTrue(torch.equal(generator.get_state(), before))

    def test_protocol_preserves_morph_and_rejects_non_finite_values(self):
        frame, _ = parse_frame(pack({'size': 256, 'morph_phase': .25, 'morph_amount': .7}, bytes(256 * 256)))
        self.assertEqual(frame['morph_phase'], .25)
        self.assertEqual(frame['morph_amount'], .7)
        for value in (float('nan'), float('inf'), 'bad'):
            with self.assertRaises(FrameError):
                parse_frame(pack({'size': 256, 'morph_phase': value}, bytes(256 * 256)))
